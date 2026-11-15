import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeDrive, createFakeLlm, discover, runBatch, type RunResult } from "../src/index.js";
import { candidatePdfs, makeCtx, writePdf } from "./helpers/ctx.js";
import { eachRow, fixture, golden } from "./helpers/golden.js";
import { GoldenResponder } from "./helpers/golden-responder.js";
import { resumeLines } from "./helpers/make-pdf.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "intake-run-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Parse a CSV with a BOM into records (the test fixtures contain no embedded newlines in names). */
function csvRows(result: RunResult): Array<Record<string, string>> {
  expect(result.csvPath, "expected a CSV").not.toBeNull();
  const text = fs.readFileSync(result.csvPath!, "utf-8");
  expect(text.charCodeAt(0)).toBe(0xfeff);
  const lines = parseCsv(text.slice(1));
  const header = lines[0]!;
  return lines.slice(1).map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])));
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

describe("end-to-end runs against the fake provider and fake Drive (ported from test_pipeline.py)", () => {
  it("writes the CSV, rows and private Drive uploads", async () => {
    const llm = createFakeLlm();
    const drive = createFakeDrive();
    const ctx = makeCtx(path.join(tmp, "run"), { http: llm, drive });
    candidatePdfs(ctx.dirs.input, 3);

    const result = await runBatch(ctx);

    expect(result.error).toBeNull();
    expect(result.cancelled).toBe(false);
    expect(result.rows).toHaveLength(3);
    const rows = csvRows(result);
    expect(rows.map((r) => r["Name"])).toEqual(["Test Person A", "Test Person B", "Test Person C"]);
    expect(Object.keys(rows[0]!)[0]).toBe("Lead ID");
    expect(rows[0]!["Lead ID"]).toHaveLength(12);
    expect(rows.every((r) => r["Resume"]!.startsWith("https://drive.google.com/file/d/"))).toBe(true);
    expect(rows.every((r) => r["Platform"] === "Unstop")).toBe(true);
    expect(rows[0]!["Phone Number"]).toBe("+919876543200");
    expect(drive.createCalls).toBe(3);
    expect(drive.uploaded().every((f) => f.appProperties["contentSha256"])).toBe(true);
    expect(llm.callsOf("extract")).toHaveLength(3);
    expect(result.counts["uploaded"]).toBe(3);
    expect(ctx.phases()).toContain("parsing");
    expect(ctx.phases()).toContain("done");
    expect(ctx.fileEvents("uploaded").length).toBe(3);
    expect(result.cost.tokens).toBeGreaterThan(0);
    expect(result.cost.usd).toBeGreaterThan(0);
    expect(path.basename(result.csvPath!)).toMatch(/^batch_Ollama_/); // a 127.0.0.1 base URL is named like a local model server
    expect(result.processed.map((p) => path.basename(p)).sort()).toEqual(["cv0.pdf", "cv1.pdf", "cv2.pdf"]);
  });

  it("the usage log keeps cost, tokens and request ids but no personal data", async () => {
    const ctx = makeCtx(path.join(tmp, "run"), { http: createFakeLlm(), drive: createFakeDrive() });
    candidatePdfs(ctx.dirs.input, 2);
    await runBatch(ctx);
    const usage = fs.readFileSync(path.join(ctx.dirs.output, "llm_usage.jsonl"), "utf-8");
    const requests = fs.readFileSync(path.join(ctx.dirs.output, "llm_usage_requests.jsonl"), "utf-8");
    expect(usage).toContain('"total_tokens":');
    expect(usage).toContain('"cost":');
    expect(requests).toContain("gen-");
    expect(requests).toContain('"generation_ids"');
    for (const text of [usage, requests]) {
      expect(text).not.toContain("@example.com");
      expect(text).not.toContain("Test Person");
      expect(text).not.toContain("9876543200");
      expect(text).not.toContain("sk-test-key");
    }
  });

  it("duplicate file names inside a zip do not collide", async () => {
    const drive = createFakeDrive();
    const ctx = makeCtx(path.join(tmp, "run"), { http: createFakeLlm(), drive });
    const zpath = path.join(ctx.dirs.input, "batch.zip");
    fs.copyFileSync(fixture("zips", "two-cv.zip"), zpath);

    const result = await runBatch(ctx);

    expect(csvRows(result).map((r) => r["Name"]).sort()).toEqual(["Test Person A", "Test Person B"]);
    const names = drive.uploaded().map((f) => f.name).sort();
    expect(names).toHaveLength(2);
    expect(names[0]).toBe("CV.pdf");
    expect(names[1]).toMatch(/^CV_.*\.pdf$/);
    expect(result.processed).toContain(zpath); // the run read it; the server moves it after success
    expect(fs.existsSync(zpath)).toBe(true); // the pipeline itself never moves input files
  });

  it("a generic CV.pdf from two candidates is uploaded twice, privately", async () => {
    const drive = createFakeDrive();
    const ctx = makeCtx(path.join(tmp, "run"), { http: createFakeLlm(), drive });
    writePdf(path.join(ctx.dirs.input, "CV.pdf"), resumeLines("Test Person A", "cand0@example.com", "9876543200"));
    writePdf(path.join(ctx.dirs.input, "sub", "CV.pdf"), resumeLines("Test Person B", "cand1@example.com", "9876543201"));
    const result = await runBatch(ctx);
    const rows = csvRows(result);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r["Resume"])).size).toBe(2);
    expect(new Set(drive.uploaded().map((f) => f.id)).size).toBe(2);
  });

  it("identical content is uploaded and parsed once", async () => {
    const llm = createFakeLlm();
    const drive = createFakeDrive();
    const ctx = makeCtx(path.join(tmp, "run"), { http: llm, drive });
    const [original] = candidatePdfs(ctx.dirs.input, 1);
    fs.mkdirSync(path.join(ctx.dirs.input, "copy"));
    fs.copyFileSync(original!, path.join(ctx.dirs.input, "copy", "again.pdf"));
    const result = await runBatch(ctx);
    expect(drive.createCalls).toBe(1);
    expect(llm.callsOf("extract")).toHaveLength(1);
    expect(result.counts["duplicate_content"]).toBe(1);
  });

  it("an existing Drive file with the same hash is reused on a fresh run", async () => {
    const llm = createFakeLlm();
    const drive = createFakeDrive();
    const ctx = makeCtx(path.join(tmp, "run"), { http: llm, drive });
    candidatePdfs(ctx.dirs.input, 1);
    const first = await runBatch(ctx);
    fs.rmSync(ctx.dirs.cache, { recursive: true, force: true }); // drop the parse cache: Drive must still reuse
    const second = await runBatch(makeCtx(path.join(tmp, "run"), { http: llm, drive }));
    expect(first.counts["uploaded"]).toBe(1);
    expect(second.counts["reused_existing"]).toBe(1);
    expect(drive.createCalls).toBe(1);
  });

  it("a 429 storm triggers the shared cooldown and still completes", async () => {
    const llm = createFakeLlm({ rateLimitFirst: 3 });
    const drive = createFakeDrive();
    const ctx = makeCtx(path.join(tmp, "run"), { http: llm, drive, config: { maxRetries: 4 }, options: { parallel: 4 } });
    candidatePdfs(ctx.dirs.input, 6);
    const result = await runBatch(ctx);
    expect(result.error).toBeNull();
    expect(result.rows).toHaveLength(6);
    expect(drive.createCalls).toBe(6);
    const usage = fs.readFileSync(path.join(ctx.dirs.output, "llm_usage.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(usage.at(-1).rate_limit_trips).toBeGreaterThanOrEqual(1);
    expect(llm.callsOf("extract").length).toBeGreaterThanOrEqual(6 + 3);
  });

  it("a parse failure is quarantined, not written as a junk row", async () => {
    const drive = createFakeDrive();
    const ctx = makeCtx(path.join(tmp, "run"), { http: createFakeLlm(), drive });
    candidatePdfs(ctx.dirs.input, 2);
    fs.copyFileSync(fixture("pdf", "failparse.pdf"), path.join(ctx.dirs.input, "broken.pdf"));
    const result = await runBatch(ctx);
    const rows = csvRows(result);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => !r["Name"]!.includes("Not Specified"))).toBe(true);
    expect(drive.createCalls).toBe(2); // the quarantined file is never uploaded
    expect(result.failedFiles.some((f) => f.name === "broken.pdf")).toBe(true);
    expect(ctx.fileEvents("quarantined").some((d) => d.name === "broken.pdf")).toBe(true);
    expect(result.retryPath).not.toBeNull();
    const retry = fs.readFileSync(result.retryPath!, "utf-8");
    expect(retry).toContain("broken.pdf");
    expect(retry).toContain("sha256");
    expect(retry).not.toContain("Person"); // no résumé content
  });

  it("cancel mid-run keeps the cache; a rerun makes no paid call for cached files", async () => {
    const llm = createFakeLlm({ delayMs: 150 });
    const drive = createFakeDrive();
    const root = path.join(tmp, "run");
    const first = makeCtx(root, {
      http: llm,
      drive,
      options: { parallel: 2 },
      onEvent: (event, c) => {
        if (event.type === "file" && event.data.status === "parsed") c.controller.abort();
      },
    });
    candidatePdfs(first.dirs.input, 8);

    const result1 = await runBatch(first);

    const cacheLines = fs.readFileSync(path.join(first.dirs.cache, "parse-cache.jsonl"), "utf-8").split("\n").filter((l) => l.trim());
    expect(result1.cancelled).toBe(true);
    expect(cacheLines.length).toBeGreaterThanOrEqual(1);
    expect(cacheLines.length).toBeLessThan(8);
    const before = llm.callsOf("extract").length;
    expect(before).toBe(cacheLines.length); // no call without a cache entry
    expect(result1.processed).toEqual([]); // a cancelled run archives nothing
    expect(result1.csvPath).toBeNull();
    expect(first.phases()).toContain("cancelled");

    llm.options.delayMs = 0;
    const second = makeCtx(root, { http: llm, drive, options: { parallel: 4 } });
    const result2 = await runBatch(second);
    expect(result2.error).toBeNull();
    expect(result2.cancelled).toBe(false);
    expect(result2.rows).toHaveLength(8);
    expect(llm.callsOf("extract").length - before).toBe(8 - cacheLines.length);
    expect(drive.createCalls).toBe(8);
  });

  it("a full rerun after success makes no LLM calls", async () => {
    const llm = createFakeLlm();
    const drive = createFakeDrive();
    const root = path.join(tmp, "run");
    const first = makeCtx(root, { http: llm, drive });
    candidatePdfs(first.dirs.input, 3);
    await runBatch(first);
    const before = llm.calls.length;
    const result = await runBatch(makeCtx(root, { http: llm, drive }));
    expect(llm.calls.length).toBe(before);
    expect(result.rows).toHaveLength(3);
    expect(result.counts["reused_existing"]).toBe(3);
  });

  it("a rerun reports cached files as such", async () => {
    const root = path.join(tmp, "run");
    const llm = createFakeLlm();
    const drive = createFakeDrive();
    const first = makeCtx(root, { http: llm, drive });
    candidatePdfs(first.dirs.input, 1);
    await runBatch(first);
    const second = makeCtx(root, { http: llm, drive });
    await runBatch(second);
    expect(second.fileEvents("parsed")[0]!.detail).toBe("cached");
    expect(first.fileEvents("parsed")[0]!.detail).toBe("");
  });
});

describe("JD screening", () => {
  it("a dry run reports rejects but uploads everything, and the scorer sends no temperature", async () => {
    const llm = createFakeLlm({ scoreVerdict: "reject" });
    const drive = createFakeDrive();
    const ctx = makeCtx(path.join(tmp, "run"), { http: llm, drive, options: { jdFilter: true, jd: "Senior Python developer with Kubernetes." } });
    candidatePdfs(ctx.dirs.input, 3);
    const result = await runBatch(ctx);
    expect(result.counts["jd_would_reject"]).toBe(3);
    expect(csvRows(result)).toHaveLength(3);
    expect(drive.createCalls).toBe(3);
    expect(fs.readdirSync(ctx.dirs.database).filter((n) => n.endsWith(".pdf"))).toEqual([]);
    const scores = llm.callsOf("score");
    expect(scores).toHaveLength(3);
    for (const call of scores) {
      expect("temperature" in call.body).toBe(false);
      expect(call.body.response_format).toEqual({ type: "json_object" });
    }
    expect(ctx.phases()[1]).toBe("screening");
  });

  it("a live reject moves the PDF to database/ with an index and skips the upload", async () => {
    const llm = createFakeLlm({ scoreVerdict: "reject" });
    const drive = createFakeDrive();
    const ctx = makeCtx(path.join(tmp, "run"), {
      http: llm,
      drive,
      config: { jdDryRun: false },
      options: { jdFilter: true, jd: "Kubernetes engineer." },
    });
    candidatePdfs(ctx.dirs.input, 2);
    const result = await runBatch(ctx);
    expect(result.counts["jd_rejected"]).toBe(2);
    expect(result.csvPath).toBeNull();
    expect(result.rows).toEqual([]);
    expect(drive.createCalls).toBe(0);
    expect(fs.readdirSync(ctx.dirs.database).filter((n) => /^cv.*\.pdf$/.test(n))).toHaveLength(2);
    const index = fs.readFileSync(path.join(ctx.dirs.database, "index.csv"), "utf-8");
    expect(index.startsWith("﻿Date,Filename,Run,Campaign,Score,Missing Critical,Reason")).toBe(true);
    expect(index).toContain("cv0.pdf");
    expect(index).toContain("gap");
    expect(index).toContain(`,${result.runId},TECH,20,`);
  });

  it("a second reject batch appends to the same index without a second header", async () => {
    const llm = createFakeLlm({ scoreVerdict: "reject" });
    const root = path.join(tmp, "run");
    for (const round of [0, 1]) {
      const ctx = makeCtx(root, { http: llm, drive: createFakeDrive(), config: { jdDryRun: false }, options: { jdFilter: true, jd: "Kubernetes engineer." } });
      candidatePdfs(ctx.dirs.input, 1, round);
      await runBatch(ctx);
    }
    const index = fs.readFileSync(path.join(root, "database", "index.csv"), "utf-8");
    expect(index.match(/Date,Filename/g)).toHaveLength(1);
    expect(index.trim().split("\n")).toHaveLength(3);
  });

  it("a scorer that cannot determine most résumés aborts loudly", async () => {
    const llm = createFakeLlm({ scoreVerdict: "cannot_determine" });
    const ctx = makeCtx(path.join(tmp, "run"), { http: llm, drive: createFakeDrive(), options: { jdFilter: true, jd: "Python developer.", parallel: 2 } });
    candidatePdfs(ctx.dirs.input, 14);
    const result = await runBatch(ctx);
    expect(result.error).toContain("cannot_determine");
    expect(result.csvPath).toBeNull();
    expect(ctx.phases()).toContain("failed");
    expect(llm.callsOf("score").length).toBeLessThan(14); // stopped, not run to the end
  });

  it("a real scorer decision uses the keyword fake: a résumé without the requirements is a reject", async () => {
    const llm = createFakeLlm();
    const ctx = makeCtx(path.join(tmp, "run"), {
      http: llm,
      drive: createFakeDrive(),
      config: { jdDryRun: false },
      options: { jdFilter: true, jd: "Kubernetes Terraform Golang specialist", jdThreshold: 50 },
    });
    candidatePdfs(ctx.dirs.input, 2);
    const result = await runBatch(ctx);
    expect(result.counts["jd_rejected"]).toBe(2);
  });

  it("JD screening with no job description is skipped with a log line", async () => {
    const ctx = makeCtx(path.join(tmp, "run"), { http: createFakeLlm(), drive: createFakeDrive(), options: { jdFilter: true, jd: "" } });
    candidatePdfs(ctx.dirs.input, 1);
    const result = await runBatch(ctx);
    expect(ctx.events.some((e) => e.type === "log" && e.data.message.includes("screening skipped"))).toBe(true);
    expect(result.counts["jd_scored"]).toBe(0);
    expect(ctx.phases()[1]).toBe("parsing");
  });
});

describe("failures that must stop before spending money", () => {
  it("a bad Google token stops before any parsing", async () => {
    const llm = createFakeLlm();
    const ctx = makeCtx(path.join(tmp, "run"), {
      http: llm,
      noDrive: true,
      secrets: { googleTokenJson: JSON.stringify({ client_id: "c" }) },
    });
    candidatePdfs(ctx.dirs.input, 2);
    const result = await runBatch(ctx);
    expect(result.error).toContain("Google token invalid");
    expect(llm.calls).toEqual([]);
    expect(ctx.phases()).not.toContain("parsing");
    expect(ctx.phases()).toContain("failed");
  });
  it("a missing OpenRouter key is reported", async () => {
    const ctx = makeCtx(path.join(tmp, "run"), { drive: createFakeDrive(), secrets: { openrouterApiKey: "" } });
    candidatePdfs(ctx.dirs.input, 1);
    const result = await runBatch(ctx);
    expect(result.error).toContain("OpenRouter key");
  });
  it("a missing Drive folder is reported, a configured one is found in both stored formats", async () => {
    const none = makeCtx(path.join(tmp, "a"), { http: createFakeLlm(), drive: createFakeDrive(), options: { driveFolderId: "" } });
    candidatePdfs(none.dirs.input, 1);
    expect((await runBatch(none)).error).toBe("Choose a Drive folder for this run");

    for (const [i, folders, expected] of [
      [1, [{ name: "tech", id: "F-TECH" }], "F-TECH"],
      [2, { TECH: "F-DICT" }, "F-DICT"],
    ] as const) {
      const drive = createFakeDrive();
      const ctx = makeCtx(path.join(tmp, `f${i}`), { http: createFakeLlm(), drive, config: { driveFolders: folders }, options: { driveFolderId: "" } });
      candidatePdfs(ctx.dirs.input, 1);
      await runBatch(ctx);
      expect(drive.uploaded()[0]!.parents).toEqual([expected]);
    }
  });
  it("a daily quota stops the run and keeps the zip", async () => {
    const ctx = makeCtx(path.join(tmp, "run"), { http: createFakeLlm(), drive: createFakeDrive(), options: { parallel: 1 } });
    const zpath = path.join(ctx.dirs.input, "batch.zip");
    fs.copyFileSync(fixture("zips", "quota.zip"), zpath);
    const result = await runBatch(ctx);
    expect(result.error?.toLowerCase()).toContain("quota");
    expect(fs.existsSync(zpath)).toBe(true); // not archived: a rerun still finds it
    expect(fs.existsSync(path.join(ctx.dirs.old, "batch.zip"))).toBe(false);
    expect(result.processed).toEqual([]);
    expect(result.cancelled).toBe(false);
    expect(ctx.phases()).toContain("failed");
  });
  it("empty input finishes without calls", async () => {
    const llm = createFakeLlm();
    const ctx = makeCtx(path.join(tmp, "run"), { http: llm, drive: createFakeDrive() });
    const result = await runBatch(ctx);
    expect(result.error).toBeNull();
    expect(result.rows).toEqual([]);
    expect(result.csvPath).toBeNull();
    expect(result.counts).toEqual({ files: 0 });
    expect(llm.calls).toEqual([]);
    expect(ctx.events.some((e) => e.type === "phase" && e.data.phase === "done" && e.data.detail === "no résumés in input/")).toBe(true);
  });
  it("an unconfigured workspace folder is reported by name", async () => {
    const ctx = makeCtx(path.join(tmp, "run"), { drive: createFakeDrive() });
    delete (ctx.dirs as any).database;
    const result = await runBatch(ctx);
    expect(result.error).toBe("workspace folder 'database' is not configured");
  });
  it("an unexpected failure is a failed phase with the exception type only", async () => {
    const ctx = makeCtx(path.join(tmp, "run"), { drive: createFakeDrive(), options: { inputs: { length: 1 } as unknown as string[] } });
    const result = await runBatch(ctx);
    expect(result.error).toMatch(/^unexpected error in the pipeline \(\w+\)$/);
    expect(ctx.phases()).toContain("failed");
  });
  it("a throwing event sink never fails the run", async () => {
    const ctx = makeCtx(path.join(tmp, "run"), { http: createFakeLlm(), drive: createFakeDrive() });
    candidatePdfs(ctx.dirs.input, 1);
    ctx.emit = () => {
      throw new Error("sink exploded");
    };
    const result = await runBatch(ctx);
    expect(result.error).toBeNull();
    expect(result.rows).toHaveLength(1);
  });
  it("secrets never reach events", async () => {
    const llm = createFakeLlm({ rateLimitFirst: 1 });
    const ctx = makeCtx(path.join(tmp, "run"), {
      http: llm,
      drive: createFakeDrive(),
      config: { maxRetries: 3 },
      secrets: { openrouterApiKey: "sk-super-secret-key-1234567" },
    });
    candidatePdfs(ctx.dirs.input, 2);
    fs.copyFileSync(fixture("pdf", "failparse.pdf"), path.join(ctx.dirs.input, "x.pdf"));
    await runBatch(ctx);
    expect(JSON.stringify(ctx.events)).not.toContain("sk-super-secret");
    expect(JSON.stringify(ctx.events)).not.toContain("@example.com");
  });
  it("roster files are reported and not processed; rejected archives are reported per file", async () => {
    const ctx = makeCtx(path.join(tmp, "run"), { http: createFakeLlm(), drive: createFakeDrive() });
    candidatePdfs(ctx.dirs.input, 1);
    fs.writeFileSync(path.join(ctx.dirs.input, "roster.csv"), "a,b\n");
    fs.copyFileSync(fixture("zips", "bad.zip"), path.join(ctx.dirs.input, "bad.zip"));
    const result = await runBatch(ctx);
    expect(ctx.events.some((e) => e.type === "log" && /1 roster file\(s\) found/.test(e.data.message))).toBe(true);
    expect(ctx.fileEvents("skipped")).toEqual([{ name: "bad.zip", status: "skipped", detail: "archive rejected: not a valid zip file" }]);
    expect(result.counts["zip_rejected"]).toBe(1);
    expect(result.processed.map((p) => path.basename(p)).sort()).toEqual(["bad.zip", "cv0.pdf"]);
    expect(result.rows).toHaveLength(1);
  });
  it("a PDF the reader cannot open is quarantined with the reason", async () => {
    const ctx = makeCtx(path.join(tmp, "run"), { http: createFakeLlm(), drive: createFakeDrive() });
    fs.copyFileSync(fixture("pdf", "corrupt.pdf"), path.join(ctx.dirs.input, "corrupt.pdf"));
    const result = await runBatch(ctx);
    expect(result.failedFiles).toEqual([{ name: "corrupt.pdf", reason: "ValueError: no extractable text and could not render page image (corrupt PDF?)" }]);
    expect(result.rows).toEqual([]);
    expect(result.retryPath).not.toBeNull();
  });
  it("a Drive upload failure is reported per file with a status-only reason, and the row is kept without a link", async () => {
    const drive = createFakeDrive();
    drive.failCreates.push(404);
    const ctx = makeCtx(path.join(tmp, "run"), { http: createFakeLlm(), drive, options: { parallel: 1 } });
    candidatePdfs(ctx.dirs.input, 2);
    const result = await runBatch(ctx);
    expect(result.failedFiles).toHaveLength(1);
    expect(result.failedFiles[0]!.reason).toBe("Drive error 404");
    expect(result.counts["upload_failed"]).toBe(1);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.filter((r) => r["Resume"] === "")).toHaveLength(1);
  });
});

describe("discovery (ported from test_units.py)", () => {
  it("limits a batch to the files it names", () => {
    for (const name of ["a.zip", "b.zip", "c.pdf"]) fs.writeFileSync(path.join(tmp, name), "x");
    expect(discover(tmp).zip.map((p) => path.basename(p))).toEqual(["a.zip", "b.zip"]);
    const only = discover(tmp, ["b.zip", "c.pdf"]);
    expect(only.zip.map((p) => path.basename(p))).toEqual(["b.zip"]);
    expect(only.pdf.map((p) => path.basename(p))).toEqual(["c.pdf"]);
    expect(discover(tmp, ["missing.zip"])).toEqual({ pdf: [], zip: [], roster: [] });
  });
  it("matches relative paths and classifies by lower-cased extension, recursively", () => {
    fs.mkdirSync(path.join(tmp, "sub"));
    fs.writeFileSync(path.join(tmp, "sub", "X.PDF"), "x");
    fs.writeFileSync(path.join(tmp, "list.XLSX"), "x");
    fs.writeFileSync(path.join(tmp, "notes.txt"), "x");
    const all = discover(tmp);
    expect(all.pdf).toHaveLength(1);
    expect(all.roster).toHaveLength(1);
    expect(discover(tmp, ["sub/X.PDF"]).pdf).toHaveLength(1);
    expect(discover(path.join(tmp, "nope"))).toEqual({ pdf: [], zip: [], roster: [] });
  });
});

// ── whole-pipeline golden: the Python reference and this port, same inputs, same provider script ──
describe("whole-pipeline golden runs (recorded from the Python reference)", () => {
  const runs = golden("pipeline-runs") as any[];

  function buildInput(folder: string, scenario: string): void {
    const copy = (name: string, to: string): void => {
      fs.mkdirSync(path.dirname(path.join(folder, to)), { recursive: true });
      fs.copyFileSync(fixture("pdf", name), path.join(folder, to));
    };
    if (scenario === "basic" || scenario === "jd") for (let i = 0; i < 3; i++) copy(`cv${i}.pdf`, `cv${i}.pdf`);
    if (scenario === "mixed") {
      copy("cv0.pdf", "cv0.pdf");
      copy("cv0.pdf", "sub/same-bytes.pdf");
      copy("cv1.pdf", "cv1.pdf");
      copy("cv3.pdf", "cv3.pdf");
      copy("scan.pdf", "scan.pdf");
      copy("corrupt.pdf", "corrupt.pdf");
      fs.writeFileSync(path.join(folder, "roster.csv"), "a,b\n");
      fs.copyFileSync(fixture("zips", "pipeline-batch.zip"), path.join(folder, "batch.zip"));
      fs.copyFileSync(fixture("zips", "bad.zip"), path.join(folder, "bad.zip"));
    }
  }

  eachRow(runs)("run %i", async (run) => {
    const responder = new GoldenResponder();
    const drive = createFakeDrive();
    const ctx = makeCtx(path.join(tmp, "run"), {
      http: responder,
      drive,
      config: {
        llmBaseUrl: "https://openrouter.ai/api/v1",
        modelFallback: "test/fallback",
        modelVision: "test/vision",
        modelFallbackVision: "test/fallback-vision",
        maxConcurrency: 3,
        driveConcurrency: 2,
        ...run.config,
      },
      options: { parallel: 3, ...run.options },
    });
    buildInput(ctx.dirs.input, run.scenario);

    const result = await runBatch(ctx);

    expect(result.error).toBe(run.error);
    expect(result.cancelled).toBe(run.cancelled);
    expect(result.counts).toEqual(run.counts);
    expect(result.cost).toEqual(run.cost);
    expect([...result.failedFiles].sort((a, b) => a.name.localeCompare(b.name))).toEqual(run.failedFiles);
    expect(result.rows).toHaveLength(run.rowsLen);
    if (run.csv) {
      const lines = parseCsv(fs.readFileSync(result.csvPath!, "utf-8").slice(1));
      const header = lines[0]!;
      const rows = lines.slice(1);
      const dateAt = header.indexOf("Date");
      const resumeAt = header.indexOf("Resume");
      for (const r of rows) {
        r[dateAt] = "<date>";
        if (r[resumeAt]!.startsWith("https://drive.google.com/file/d/file")) r[resumeAt] = "<resume>";
      }
      expect({ header, rows }).toEqual(run.csv);
      expect(path.basename(result.csvPath!).match(/^batch_([A-Za-z0-9]+)_/)![1]).toBe(run.csvTag);
    } else {
      expect(result.csvPath).toBeNull();
    }
    const fileEvents = ctx.events
      .flatMap((e) => (e.type === "file" ? [[e.data.name, e.data.status, e.data.detail]] : []))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(fileEvents).toEqual([...run.fileEvents].sort((a: unknown[], b: unknown[]) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    const phases = ctx.events.flatMap((e) => (e.type === "phase" ? [[e.data.phase, e.data.detail ?? null, e.data.total ?? null]] : []));
    expect(phases).toEqual(run.phases);
    expect(result.processed.map((p) => path.relative(ctx.dirs.input, p).split(path.sep).join("/")).sort()).toEqual(run.processed);
    const models = [...new Set(responder.requests.filter((r) => r.kind === "extract").map((r) => r.model))].sort();
    expect({
      extract: responder.requests.filter((r) => r.kind === "extract").length,
      score: responder.requests.filter((r) => r.kind === "score").length,
      models,
      visionCalls: responder.requests.filter((r) => r.vision).length,
    }).toEqual(run.requests);
    expect(drive.uploaded().map((f) => f.name).sort()).toEqual(run.driveFiles);
    if (run.retry === null) expect(result.retryPath).toBeNull();
    else expect(fs.readFileSync(result.retryPath!, "utf-8").replace(/^﻿/, "")).toBe(run.retry);
    expect(fs.readdirSync(ctx.dirs.database).filter((n) => n !== "index.csv").sort()).toEqual(run.databaseFiles.filter((n: string) => n !== "index.csv"));
    if (run.databaseIndex === null) expect(fs.existsSync(path.join(ctx.dirs.database, "index.csv"))).toBe(false);
    else {
      const strip = (text: string): string[][] =>
        parseCsv(text.replace(/^﻿/, "")).map((row) => row.filter((_c, i) => i !== 0 && i !== 2)); // Date and Run vary
      const sorted = (rows: string[][]): string[][] => [rows[0]!, ...rows.slice(1).sort((a, b) => a.join("|").localeCompare(b.join("|")))]; // rejects finish in any order
      expect(sorted(strip(fs.readFileSync(path.join(ctx.dirs.database, "index.csv"), "utf-8")))).toEqual(sorted(strip(run.databaseIndex)));
    }
    const usageFile = path.join(ctx.dirs.output, "llm_usage.jsonl");
    const usage = fs.existsSync(usageFile)
      ? fs.readFileSync(usageFile, "utf-8").trim().split("\n").map((l) => {
          const { timestamp: _t, run_id: _r, ...rest } = JSON.parse(l);
          return rest;
        })
      : [];
    expect(usage).toEqual(run.usageRuns);
    const cacheFile = path.join(ctx.dirs.cache, "parse-cache.jsonl");
    expect(fs.existsSync(cacheFile) ? fs.readFileSync(cacheFile, "utf-8").split("\n").filter((l) => l.trim()).length : 0).toBe(run.cacheLines);
  });
});
