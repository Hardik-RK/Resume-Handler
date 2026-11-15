import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZipRejected } from "../src/errors.js";
import * as llm from "../src/llm.js";
import * as parse from "../src/parse.js";
import { DEFAULT_ZIP_LIMITS, extractZip, type ZipLimits } from "../src/zips.js";
import { eachRow, fixture, golden } from "./helpers/golden.js";
import { makePdf, resumeLines } from "./helpers/make-pdf.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "intake-zip-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const LIMIT_KEYS: Record<string, keyof ZipLimits> = {
  max_entries: "maxEntries",
  max_entry_bytes: "maxEntryBytes",
  max_total_bytes: "maxTotalBytes",
  max_ratio: "maxRatio",
};

describe("safe unzip (golden against the Python reference)", () => {
  const cases = golden("zips") as any[];
  eachRow(cases)("zip case %i", async (c) => {
    const limits: ZipLimits = { ...DEFAULT_ZIP_LIMITS };
    for (const [k, v] of Object.entries(c.limits)) (limits as any)[LIMIT_KEYS[k]!] = v;
    const dest = path.join(tmp, "out");
    let out: any;
    try {
      const result = await extractZip(fixture("zips", c.zip), dest, limits);
      out = {
        ok: true,
        files: result.files.map((f) => ({ sha256: f.sha256, displayName: f.displayName, source: f.source, onDisk: path.basename(f.path) })),
        skipped: result.skipped,
        ignored: result.ignored,
        dirListing: fs.readdirSync(dest).sort(),
      };
    } catch (e) {
      expect(e).toBeInstanceOf(ZipRejected);
      out = { ok: false, message: (e as Error).message, dirListing: fs.readdirSync(dest).sort() };
    }
    expect(out).toEqual(c.out);
  });

  it("entries are stored under their content hash and only ever by basename (path traversal)", async () => {
    const dest = path.join(tmp, "out");
    const result = await extractZip(fixture("zips", "mixed.zip"), dest);
    for (const f of result.files) {
      expect(path.basename(f.path)).toBe(`${f.sha256}.pdf`);
      expect(crypto.createHash("sha256").update(fs.readFileSync(f.path)).digest("hex")).toBe(f.sha256);
      expect(path.dirname(f.path)).toBe(path.resolve(dest));
    }
    expect(result.files.map((f) => f.displayName)).toContain("escape.pdf");
    expect(fs.existsSync(path.join(tmp, "escape.pdf"))).toBe(false);
    expect(fs.readdirSync(dest).every((n) => /^[0-9a-f]{64}\.pdf$/.test(n))).toBe(true);
  });

  it("a zip bomb leaves no file behind (ported pytest case)", async () => {
    const dest = path.join(tmp, "out");
    const result = await extractZip(fixture("zips", "bomb.zip"), dest);
    expect(result.skipped.some(([, reason]) => reason.includes("compression ratio"))).toBe(true);
    expect(fs.readdirSync(dest).filter((n) => n.startsWith("_partial_"))).toEqual([]);
  });
  it("500 entries are fine, 501 reject the whole archive (ported pytest case)", async () => {
    await expect(extractZip(fixture("zips", "many.zip"), path.join(tmp, "a"))).rejects.toBeInstanceOf(ZipRejected);
    expect((await extractZip(fixture("zips", "exact.zip"), path.join(tmp, "b"))).files).toHaveLength(500);
  });
  it("a corrupt archive is rejected cleanly (ported pytest case)", async () => {
    await expect(extractZip(fixture("zips", "bad.zip"), path.join(tmp, "o"))).rejects.toThrow("not a valid zip file");
  });
});

describe("PDF reading (golden: text/vision routing, links, contact recovery)", () => {
  const docs = golden("parse-docs") as any[];
  eachRow(docs)("document %i", async (c) => {
    const doc = await parse.PdfDoc.open(fixture("pdf", c.file));
    try {
      expect(doc.rawLen === null).toBe(c.rawLen === null);
      expect(doc.hasImages).toBe(c.hasImages);
      expect(doc.uris).toEqual(c.uris);
      expect(doc.pages.length).toBe(c.pages);
      if (c.rawLen !== null) {
        // different readers count whitespace slightly differently; both must agree on which side of the thresholds it is
        expect(doc.rawLen! < llm.MIN_TEXT_CHARS).toBe(c.rawLen < llm.MIN_TEXT_CHARS);
        expect(Math.abs(doc.rawLen! - c.rawLen)).toBeLessThan(40);
      }
      const text = parse.extractText(doc);
      expect(text.trim() === "").toBe(c.extractedEmpty);
      if (text.trim()) expect(parse.needsVision(text, doc)).toBe(c.needsVision);
      expect(!(text.trim() && !parse.needsVision(text, doc))).toBe(c.useVision);
      expect(parse.linksText(doc.uris)).toBe(c.linksText);
      expect(doc.pages.length ? parse.recoverContacts(text, doc.rawText) : "").toBe(c.recover);
      const images = await doc.render(150, 4);
      expect(images.length).toBe(c.renderCount);
      for (const uri of images) {
        expect(uri.startsWith("data:image/png;base64,")).toBe(true);
        const png = Buffer.from(uri.split(",")[1]!, "base64");
        expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      }
    } finally {
      await doc.close();
    }
  });

  it("helpers match the reference", () => {
    const g = golden("parse-helpers");
    for (const c of g.hasPhone) expect(parse.hasPhone(c.text)).toBe(c.out);
    for (const c of g.linksText) expect(parse.linksText(c.uris.map((u: string | null) => u ?? ""))).toBe(c.out);
    for (const c of g.recover) expect(parse.recoverContacts(c.md, c.raw)).toBe(c.out);
  });

  it("renders at the requested DPI and caps pages", async () => {
    const file = path.join(tmp, "multi.pdf");
    fs.writeFileSync(file, makePdf([1, 2, 3, 4, 5, 6].map((n) => ({ lines: [`Page ${n}`] }))));
    const doc = await parse.PdfDoc.open(file);
    try {
      expect(doc.pages).toHaveLength(6);
      expect(await doc.render(100, 4)).toHaveLength(4);
      const small = Buffer.from((await doc.render(72, 1))[0]!.split(",")[1]!, "base64");
      const large = Buffer.from((await doc.render(144, 1))[0]!.split(",")[1]!, "base64");
      const width = (png: Buffer): number => png.readUInt32BE(16);
      expect(width(small)).toBe(612);
      expect(width(large)).toBe(1224);
    } finally {
      await doc.close();
    }
  });
  it("a rendered page has an opaque white background (what the vision model should see)", async () => {
    const file = path.join(tmp, "blank.pdf");
    fs.writeFileSync(file, makePdf([{ lines: [] }]));
    const doc = await parse.PdfDoc.open(file);
    try {
      const canvas = await import("@napi-rs/canvas");
      const png = Buffer.from((await doc.render(50, 1))[0]!.split(",")[1]!, "base64");
      const image = await canvas.loadImage(png);
      const c = canvas.createCanvas(image.width, image.height);
      const ctx = c.getContext("2d");
      ctx.drawImage(image, 0, 0);
      expect(Array.from(ctx.getImageData(5, 5, 1, 1).data)).toEqual([255, 255, 255, 255]);
    } finally {
      await doc.close();
    }
  });
  it("a text PDF built here reads back its lines and routes to the text path", async () => {
    const file = path.join(tmp, "t.pdf");
    fs.writeFileSync(file, makePdf([{ lines: resumeLines("Test Person A", "cand0@example.com", "9876543200") }]));
    const doc = await parse.PdfDoc.open(file);
    try {
      expect(doc.rawText).toContain("Candidate: Test Person A");
      expect(doc.hasImages).toBe(false);
      expect(parse.extractText(doc)).toContain("cand0@example.com");
    } finally {
      await doc.close();
    }
  });
});
