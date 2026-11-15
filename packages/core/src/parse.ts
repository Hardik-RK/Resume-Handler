/**
 * Résumé reading and the per-file extraction call (port of pipeline/parse.py).
 *
 * One pdf.js open per résumé serves the text-layer check, hyperlinks, the image check and the page renders.
 * The text/vision thresholds, the render DPI and the page cap are the reference's.
 *
 * Replacement note: the reference converted the PDF to markdown with a PyMuPDF-based library and fell back to a
 * second extractor. Here pdf.js text items are joined line by line (no markdown headings); there is no second
 * extractor. The name heuristics already strip markdown, so downstream behaviour is unchanged.
 */
import fs from "node:fs";
import { getDocumentProxy, getResolvedPDFJS, renderPageAsImage } from "unpdf";
import type { PDFDocumentProxy } from "unpdf/pdfjs";
import { errorName, llmMetaOf, ValueError, Cancelled, DailyQuotaExceeded, type LlmMeta } from "./errors.js";
import * as llm from "./llm.js";
import { NOT_SPECIFIED, nameFromResumeText, normaliseResumeNameValue, usableResumeName } from "./names.js";
import { digitsOnly } from "./pyjson.js";
import { type Dict, getd, or } from "./pyish.js";

/** True only for a real phone number (>= 10 digits), so dates are not phones. */
export function hasPhone(text: string): boolean {
  return [...text.matchAll(llm.phoneRe())].some((m) => digitsOnly(m[0]).length >= 10);
}

/** Emails/URLs hidden behind hyperlink annotations (a 'mailto:' with no visible address). */
export function linksText(uris: string[]): string {
  const out: string[] = [];
  for (const raw of uris) {
    const uri = (raw || "").trim();
    const lower = uri.toLowerCase();
    if (lower.startsWith("mailto:")) out.push("Email: " + uri.slice(7));
    else if ((lower.startsWith("http://") || lower.startsWith("https://")) && ["linkedin", "github"].some((k) => lower.includes(k))) {
      out.push(uri);
    }
  }
  const seen: string[] = [];
  for (const u of out) if (!seen.includes(u)) seen.push(u);
  return seen.join("\n");
}

const IMAGE_OP_NAMES = ["paintImageXObject", "paintInlineImageXObject", "paintImageXObjectRepeat", "paintInlineImageXObjectGroup"];

/** Everything the pipeline needs from one PDF, read in a single open. */
export class PdfDoc {
  /** page text, one entry per page (unstripped, as the reference joins them) */
  pages: string[] = [];
  uris: string[] = [];
  hasImages = false;
  /** null when the file cannot be opened */
  rawLen: number | null = null;
  private proxy: PDFDocumentProxy | null = null;

  static async open(file: string): Promise<PdfDoc> {
    const doc = new PdfDoc();
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await fs.promises.readFile(file));
      doc.proxy = await getDocumentProxy(bytes, { verbosity: 0 });
    } catch {
      doc.proxy = null;
      return doc;
    }
    try {
      const pdfjs = await getResolvedPDFJS();
      const imageOps = new Set<number>(IMAGE_OP_NAMES.map((name) => (pdfjs.OPS as Record<string, number>)[name]!).filter((n) => n !== undefined));
      for (let n = 1; n <= doc.proxy.numPages; n++) {
        const page = await doc.proxy.getPage(n);
        const content = await page.getTextContent();
        let text = "";
        for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
          if (typeof item.str !== "string") continue;
          text += item.str;
          if (item.hasEOL) text += "\n";
        }
        if (text && !text.endsWith("\n")) text += "\n";
        doc.pages.push(text);
        for (const annot of (await page.getAnnotations()) as Array<{ url?: string; unsafeUrl?: string }>) {
          if (annot.url || annot.unsafeUrl) doc.uris.push(annot.url || annot.unsafeUrl || "");
        }
        if (!doc.hasImages) {
          const ops = await page.getOperatorList();
          if (ops.fnArray.some((fn: number) => imageOps.has(fn))) doc.hasImages = true;
        }
      }
    } catch {
      /* keep whatever was read, as the reference */
    }
    doc.rawLen = doc.pages.reduce((sum, text) => sum + text.trim().length, 0);
    return doc;
  }

  get rawText(): string {
    return this.pages.join("\n");
  }

  /** First pages as PNG data URIs for the vision model (same cap and DPI as the reference). */
  async render(dpi: number, maxPages: number): Promise<string[]> {
    const uris: string[] = [];
    if (!this.proxy) return uris;
    try {
      const count = Math.min(maxPages, this.proxy.numPages);
      for (let i = 1; i <= count; i++) {
        const png = await renderPageAsImage(this.proxy, i, {
          canvasImport: () => import("@napi-rs/canvas"),
          scale: dpi / 72,
        });
        uris.push(`data:image/png;base64,${Buffer.from(png).toString("base64")}`);
      }
    } catch {
      /* return what rendered */
    }
    return uris;
  }

  async close(): Promise<void> {
    const proxy = this.proxy;
    this.proxy = null;
    try {
      await (proxy as unknown as { destroy?: () => Promise<void> } | null)?.destroy?.();
    } catch {
      /* ignore */
    }
  }
}

/** A missing email or phone recovered from the clean raw text layer (spaced emails like 'a @ mail . com'). */
export function recoverContacts(mdText: string, raw: string): string {
  const out: string[] = [];
  if (!llm.EMAIL_RE.test(mdText)) {
    const m = llm.EMAIL_RE.exec(raw.replace(/\s*([.@])\s*/g, (_s, c: string) => c)); // de-space 'a @ samp . test'
    if (m) out.push("Email: " + m[0]);
  }
  if (!hasPhone(mdText)) {
    for (const m of raw.matchAll(llm.phoneRe())) {
      if (digitsOnly(m[0]).length >= 10) {
        out.push("Phone: " + m[0].trim());
        break;
      }
    }
  }
  return out.join("\n");
}

/** Text of the résumé; '' for a scanned PDF (routes to vision). */
export function extractText(doc: PdfDoc): string {
  const rawLen = doc.rawLen;
  if (rawLen !== null && rawLen < llm.MIN_TEXT_CHARS) return "";
  let text = doc.rawText.replace(llm.PLACEHOLDER_RE, "");
  const tail = [doc.pages.length ? recoverContacts(text, doc.rawText) : "", linksText(doc.uris)].filter((x) => x).join("\n");
  if (tail) text = text.replace(/\s+$/, "") + "\n\n" + tail;
  return text;
}

/**
 * Hybrid PDF: a contact detail exists only as a flattened image. Both email and phone must be present in the
 * text before the images are ignored.
 */
export function needsVision(text: string, doc: PdfDoc | null): boolean {
  if (llm.EMAIL_RE.test(text) && hasPhone(text)) return false;
  if (doc === null || doc.rawLen === null) return false;
  return doc.hasImages;
}

export interface ExtractedRow extends Dict {
  _llm_meta?: LlmMeta;
  _resume_text?: string;
  _use_vision?: boolean;
}

function attachMeta(error: unknown, meta: LlmMeta): void {
  if (error instanceof Error) (error as Error & { llmMeta?: LlmMeta }).llmMeta = meta;
}

/**
 * Parse one résumé through the LLM. Returns the normalised row with `_llm_meta`, `_resume_text` ('' on the
 * vision path) and `_use_vision`. Throws on failure; a DailyQuotaExceeded or Cancelled is re-thrown without
 * trying the fallback model.
 */
export async function extractResume(
  file: string,
  cfg: llm.LlmCfg,
  transport: llm.Transport,
  fields: Array<Record<string, unknown>>,
  label = "resume",
): Promise<ExtractedRow> {
  const apiKey = getd(cfg, "LLM_API_KEY", "");
  const baseUrl = String(getd(cfg, "LLM_BASE_URL", llm.DEFAULT_BASE_URL)).replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;
  if (!apiKey) throw new ValueError("LLM_API_KEY is not set");
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const instructions = llm.instructions(fields, cfg);

  const doc = await PdfDoc.open(file);
  let text: string;
  let useVision: boolean;
  let images: string[] = [];
  try {
    text = extractText(doc);
    useVision = !(text.trim() && !needsVision(text, doc));
    if (useVision) images = await doc.render(getd(cfg, "VISION_DPI", 150), llm.VISION_MAX_PAGES);
  } finally {
    await doc.close();
  }
  if (useVision && images.length === 0) {
    throw new ValueError("no extractable text and could not render page image (corrupt PDF?)");
  }

  const primaryModel = llm.modelFor(cfg, useVision);
  const messages = llm.buildMessages(instructions, text, images, useVision);
  const body = llm.buildBody(primaryModel, messages, fields, cfg, useVision);
  const maxRetries = getd(cfg, "LLM_MAX_RETRIES", llm.MAX_RETRIES);

  let primaryMeta: LlmMeta = {};
  let primaryIssues: string[] = [];
  let primaryError: unknown = null;
  let row: Dict | null = null;
  try {
    const { parsed, meta } = await llm.post(url, headers, body, label, { vision: useVision, maxRetries, transport });
    primaryMeta = meta;
    row = llm.fillLocalContacts(llm.normaliseModelRow(parsed, cfg), text);
    primaryIssues = llm.validateRow(row, text, cfg);
  } catch (exc) {
    if (exc instanceof Cancelled || exc instanceof DailyQuotaExceeded) throw exc;
    primaryError = exc;
    primaryMeta = llmMetaOf(exc);
    row = null;
  }

  // A name-only problem is free to fix from the text, so try that before spending a call.
  if (row !== null && primaryIssues.length === 1 && primaryIssues[0] === "name_missing_or_invalid") {
    const heuristic = nameFromResumeText(text);
    if (heuristic !== NOT_SPECIFIED) {
      row["Name"] = heuristic;
      primaryIssues = llm.validateRow(row, text, cfg);
    }
  }

  const fallbackModel = llm.modelFor(cfg, useVision, true);
  const needFallback = Boolean(fallbackModel && fallbackModel !== primaryModel && (primaryError !== null || primaryIssues.length > 0));
  let fallbackMeta: LlmMeta = {};
  let fallbackIssues: string[] = [];
  let fallbackError: unknown = null;
  let fallbackRow: Dict | null = null;
  if (needFallback) {
    const fallbackBody = llm.buildBody(fallbackModel, messages, fields, cfg, useVision, true);
    try {
      const { parsed, meta } = await llm.post(url, headers, fallbackBody, label, { vision: useVision, maxRetries, transport });
      fallbackMeta = meta;
      fallbackRow = llm.fillLocalContacts(llm.normaliseModelRow(parsed, cfg), text);
      fallbackIssues = llm.validateRow(fallbackRow, text, cfg);
      if (row === null || fallbackIssues.length <= primaryIssues.length) row = fallbackRow;
    } catch (exc) {
      if (exc instanceof Cancelled || exc instanceof DailyQuotaExceeded) throw exc;
      fallbackError = exc;
      fallbackMeta = llmMetaOf(exc);
    }
  }

  if (row === null) {
    const failedError = primaryError ?? fallbackError ?? new Error("resume extraction returned no row");
    const failedMeta = llm.mergeMeta(primaryMeta, Object.keys(fallbackMeta).length ? fallbackMeta : null, {
      run_id: getd(cfg, "_LLM_RUN_ID", null),
      fallback_attempted: needFallback,
      fallback_used: false,
      vision: useVision,
    });
    attachMeta(failedError, failedMeta);
    throw failedError;
  }

  llm.fillLocalContacts(row, text);
  const usingFallbackRow = fallbackRow !== null && row === fallbackRow;
  const finalIssues = usingFallbackRow ? fallbackIssues : primaryIssues;
  const out = row as ExtractedRow;
  out._llm_meta = llm.mergeMeta(primaryMeta, needFallback ? fallbackMeta : null, {
    model: usingFallbackRow ? fallbackModel : primaryModel,
    primary_model: primaryModel,
    fallback_model: or(fallbackModel, null),
    fallback_attempted: needFallback,
    fallback_used: usingFallbackRow,
    vision: useVision,
    run_id: getd(cfg, "_LLM_RUN_ID", null),
    issues: finalIssues,
    primary_issues: primaryIssues,
    fallback_issues: fallbackIssues,
    primary_error: primaryError ? errorName(primaryError) : null,
    fallback_error: fallbackError ? errorName(fallbackError) : null,
  });
  out._resume_text = useVision ? "" : text;
  out._use_vision = useVision;

  // Candidate identity comes from the résumé, never the filename.
  if (usableResumeName(out["Name"])) out["Name"] = normaliseResumeNameValue(out["Name"]);
  else out["Name"] = nameFromResumeText(text);
  return out;
}
