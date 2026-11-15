/**
 * Identity keys (phone, email, Lead ID), atomic file writes, the batch CSV and the JD index.
 *
 * Lead ID = sha1("<normalised email>|<last 10 digits of phone>")[:12], falling back to the normalised
 * name only when both email and phone are missing. Port of pipeline/csvout.py.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { digitsOnly, localStamp, pyJsonDumps, pyStrip } from "./pyjson.js";

export const LEAD_ID_HEADER = "Lead ID";
export const MAX_CSV_FILES = 20; // keep the newest N batch CSVs

// ── identity ──────────────────────────────────────────────────────────────────

/** Lowercase, strip accents/punctuation, collapse whitespace; stable across runs. */
export function normalizeNameForId(name: unknown): string {
  const ascii = String(name || "").normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
  return ascii.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Trim + lowercase; blanks the usual placeholders. */
export function normalizeEmailForId(email: unknown): string {
  const s = pyStrip(String(email || "")).toLowerCase();
  return ["", "nan", "not specified", "n/a", "-"].includes(s) ? "" : s;
}

/** Last 10 digits, the country-code-agnostic key the downstream system also matches on. */
export function phoneKey(raw: unknown): string {
  const digits = digitsOnly(raw || "");
  return digits.length >= 7 ? digits.slice(-10) : "";
}

/**
 * E.164 for the Phone Number column (IN assumed for bare numbers). Falls back to the raw digits when
 * the number cannot be parsed as valid, so a real number is never blanked.
 */
export function normalizePhoneE164(raw: unknown, defaultRegion = "IN"): string {
  const s = pyStrip(String(raw || ""));
  if (!s || ["nan", "not specified", "n/a", "-"].includes(s.toLowerCase())) return "";
  try {
    const num = parsePhoneNumberFromString(s, defaultRegion as never);
    if (num && num.isValid()) return num.format("E.164");
  } catch {
    /* unparseable: fall through to the digit fallback */
  }
  const digits = digitsOnly(s);
  if (digits.length < 7) return "";
  return (s.startsWith("+") ? "+" : "") + digits;
}

/** Deterministic 12-char Lead ID from normalised email + phone key. */
export function leadId(email: unknown, phone: unknown, name: unknown = ""): string {
  const e = normalizeEmailForId(email);
  const p = phoneKey(phone);
  const basis = e || p ? `${e}|${p}` : `name:${normalizeNameForId(name)}`;
  return crypto.createHash("sha1").update(basis, "utf8").digest("hex").slice(0, 12);
}

// ── atomic writes ─────────────────────────────────────────────────────────────

/** Write to a temp file in the same folder, then replace. Never leaves a half-written file. */
export function atomicWriteBytes(file: string, data: Buffer | Uint8Array): void {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `${path.basename(target)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, data);
      try {
        fs.fsyncSync(fd);
      } catch {
        /* best effort */
      }
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw error;
  }
}

export function atomicWriteText(file: string, text: string): void {
  atomicWriteBytes(file, Buffer.from(text, "utf-8"));
}

// ── values ────────────────────────────────────────────────────────────────────

/** Render one CSV cell. Lists of objects become JSON; lists of strings a '; ' join. */
export function cellValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === "string")) return value.join("; ");
    return pyJsonDumps(value);
  }
  if (typeof value === "object") return pyJsonDumps(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

/** One CSV record as Python's `csv.writer` (excel dialect, "\n" terminator, QUOTE_MINIMAL) writes it. */
export function csvLine(fields: string[]): string {
  if (fields.length === 1 && fields[0] === "") return '""\n';
  const out = fields.map((field) => (/[,"\n\r]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field));
  return out.join(",") + "\n";
}

export function rowsToCsvText(rows: Array<Record<string, unknown>>, columns: string[]): string {
  let text = csvLine(columns);
  for (const row of rows) text += csvLine(columns.map((column) => cellValue(row[column])));
  return text;
}

/** Write output/batch_<method>_<timestamp>.csv atomically and keep the newest MAX_CSV_FILES. */
export function writeBatchCsv(
  outputDir: string,
  rows: Array<Record<string, unknown>>,
  columns: string[],
  method: string,
): string {
  const dir = path.resolve(outputDir);
  fs.mkdirSync(dir, { recursive: true });
  const tag = method.replace(/[^A-Za-z0-9]+/g, "") || "batch";
  const stamp = localStamp("file");
  let file = path.join(dir, `batch_${tag}_${stamp}.csv`);
  if (fs.existsSync(file)) {
    // two runs within one second: never overwrite
    file = path.join(dir, `batch_${tag}_${stamp}_${crypto.randomBytes(2).toString("hex")}.csv`);
  }
  atomicWriteText(file, "﻿" + rowsToCsvText(rows, columns));
  const existing = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("batch_") && name.endsWith(".csv"))
    .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);
  for (const old of existing.slice(0, -MAX_CSV_FILES)) {
    try {
      fs.unlinkSync(path.join(dir, old.name));
    } catch {
      /* in use or gone */
    }
  }
  return file;
}

export interface QuarantinedFile {
  sha256?: string;
  name?: string;
  source?: string;
  reason?: string;
}

/** Write output/retry_<timestamp>.csv for files whose parse failed (no PII beyond the name). */
export function writeRetryList(outputDir: string, quarantined: QuarantinedFile[]): string {
  const dir = path.resolve(outputDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `retry_${localStamp("file")}.csv`);
  const columns = ["sha256", "file", "source", "reason"];
  const rows = quarantined.map((q) => ({
    sha256: q.sha256 ?? "",
    file: q.name ?? "",
    source: q.source ?? "",
    reason: q.reason ?? "",
  }));
  atomicWriteText(file, "﻿" + rowsToCsvText(rows, columns));
  return file;
}

export interface IndexEntry {
  filename: string;
  score?: number | string;
  missing_critical?: string[];
  reason?: string;
}

/** Append JD-rejected files to database/index.csv (created with a header when missing). */
export function appendDatabaseIndex(
  databaseDir: string,
  entries: IndexEntry[],
  idHeader: string,
  labelHeader: string,
  targetId: string,
  targetLabel: string,
): string {
  const dir = path.resolve(databaseDir);
  fs.mkdirSync(dir, { recursive: true });
  const indexPath = path.join(dir, "index.csv");
  const header = ["Date", "Filename", idHeader, labelHeader, "Score", "Missing Critical", "Reason"];
  let existing = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf-8") : "";
  if (existing.startsWith("﻿")) existing = existing.slice(1);
  existing = existing.replace(/\r\n?/g, "\n"); // universal newlines, as Python's text mode
  let added = existing ? "" : csvLine(header);
  const stamp = localStamp("minute");
  for (const entry of entries) {
    added += csvLine([
      stamp,
      entry.filename,
      targetId,
      targetLabel,
      entry.score === undefined ? "" : cellValue(entry.score),
      (entry.missing_critical ?? []).join("; "),
      entry.reason ?? "",
    ]);
  }
  // existing was read without its BOM; rewrite the whole file atomically
  atomicWriteText(indexPath, "﻿" + existing + added);
  return indexPath;
}
