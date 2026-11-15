import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generateBatch, zipBatch } from "../../mock-crm/fixtures/generate.ts";
import { createMockCrm } from "../../mock-crm/src/app.ts";
import { main } from "../src/main.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "intake-e2e-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("end to end: fixtures, real core with the fake provider, mock CRM sink", () => {
  it("reads a fixture zip offline, writes the CSV and commits the candidates", async () => {
    const batch = await generateBatch({ count: 8, seed: 21, scanned: 1, duplicates: 2, corrupt: true });
    const zip = path.join(tmp, "batch.zip");
    fs.writeFileSync(zip, zipBatch(batch));

    const crm = createMockCrm();
    const fetchImpl = ((url: string | URL, init?: RequestInit) => crm.app.request(String(url).replace(/^https?:\/\/[^/]+/, ""), init)) as typeof fetch;
    let out = "";
    let err = "";
    const code = await main(
      ["run", zip, "--fake", "--plain", "--campaign", "Backend Engineer", "--sink", "http://127.0.0.1:47900", "--mint-token", "--workdir", path.join(tmp, "work")],
      { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, env: {}, isTTY: false, cwd: tmp, fetch: fetchImpl },
    );
    expect(err).toBe("");
    const lines = out.trim().split("\n");
    const csvLine = lines.at(-1) ?? "";
    expect(csvLine).toMatch(/^CSV: .+\.csv$/);
    const csvPath = csvLine.slice("CSV: ".length);
    expect(fs.existsSync(csvPath)).toBe(true);
    const csv = fs.readFileSync(csvPath, "utf8");

    // Every distinct text-PDF candidate is in the CSV with a fake address; nobody appears twice.
    const textPeople = batch.files.filter((f) => f.kind === "text").map((f) => f.candidate!);
    expect(textPeople.length).toBeGreaterThan(0);
    for (const person of textPeople) expect(csv.toLowerCase()).toContain(person.email);
    for (const person of textPeople) expect(csv.toLowerCase().split(person.email).length - 1).toBe(1);

    // The damaged file is reported as a failure (exit 3), not a crash.
    expect(lines.join("\n")).toContain("damaged_upload.pdf");
    expect(code).toBe(3);

    // The candidates reached the mock CRM, once each.
    const emails = crm.store.applications.map((a) => a.email);
    expect(new Set(emails).size).toBe(emails.length);
    for (const person of textPeople) expect(emails).toContain(person.email);
    expect(lines.some((l) => /^\[sink\] done: \d+ created/.test(l))).toBe(true);
  }, 120_000);
});
