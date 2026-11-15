import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import { afterAll, describe, expect, it } from "vitest";
import { writeFixtures } from "../fixtures/cli.ts";
import { generateBatch, makeCandidates, zipBatch } from "../fixtures/generate.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("synthetic résumé generator", () => {
  it("is deterministic per seed and differs across seeds", () => {
    expect(makeCandidates(10, 1, "sales")).toEqual(makeCandidates(10, 1, "sales"));
    expect(makeCandidates(10, 1, "sales").map((c) => c.name)).not.toEqual(makeCandidates(10, 2, "sales").map((c) => c.name));
  });

  it("uses only reserved or fictional contact data and unique people", () => {
    const people = makeCandidates(50, 3, "backend");
    expect(new Set(people.map((c) => c.email)).size).toBe(50);
    expect(new Set(people.map((c) => c.phone)).size).toBe(50);
    for (const c of people) {
      expect(c.email).toMatch(/@example\.com$/);
      expect(c.phone).toMatch(/^\+44 7700 900\d{3}$/);
    }
  });

  it("produces text, scanned, duplicate and corrupt files", async () => {
    const batch = await generateBatch({ count: 12, seed: 5 });
    const kinds = batch.files.map((f) => f.kind);
    expect(kinds.filter((k) => k === "text")).toHaveLength(10);
    expect(kinds.filter((k) => k === "scanned")).toHaveLength(2);
    expect(kinds.filter((k) => k === "duplicate")).toHaveLength(2);
    expect(kinds.filter((k) => k === "corrupt")).toHaveLength(1);
    expect(new Set(batch.files.map((f) => f.name)).size).toBe(batch.files.length);
    const duplicate = batch.files.find((f) => f.kind === "duplicate");
    const original = batch.files.find((f) => f.kind === "text" && f.candidate?.email === duplicate?.candidate?.email);
    expect(original).toBeDefined();
  }, 30_000);

  it("writes parseable PDFs: text ones carry the person's name, scanned ones are image-only", async () => {
    const batch = await generateBatch({ count: 6, seed: 9, scanned: 1 });
    const text = batch.files.find((f) => f.kind === "text")!;
    const doc = await PDFDocument.load(text.bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(Buffer.from(text.bytes).toString("latin1")).toContain("Helvetica");
    const scanned = batch.files.find((f) => f.kind === "scanned")!;
    const scannedRaw = Buffer.from(scanned.bytes).toString("latin1");
    expect(scannedRaw).toContain("/Subtype /Image");
    expect(scannedRaw).not.toContain("Helvetica");
    const corrupt = Buffer.from(batch.files.find((f) => f.kind === "corrupt")!.bytes).toString("latin1");
    expect(corrupt.startsWith("%PDF-")).toBe(true);
    expect(corrupt).not.toContain("%%EOF");
    expect(corrupt).not.toContain("/Type /Page");
  }, 30_000);

  it("rejects counts outside 5 to 50", async () => {
    await expect(generateBatch({ count: 4 })).rejects.toThrow(RangeError);
    await expect(generateBatch({ count: 51 })).rejects.toThrow(RangeError);
  });

  it("zips every file and writes a manifest to disk", async () => {
    const batch = await generateBatch({ count: 5, seed: 11, scanned: 0 });
    expect(Object.keys(unzipSync(zipBatch(batch))).sort()).toEqual(batch.files.map((f) => f.name).sort());
    const dir = mkdtempSync(join(tmpdir(), "intake-fixtures-"));
    dirs.push(dir);
    const out = await writeFixtures(dir, { count: 5, seed: 11 });
    expect(readdirSync(out.resumes).length).toBe(out.batch.files.length);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as unknown[];
    expect(manifest).toHaveLength(out.batch.files.length);
  }, 30_000);
});
