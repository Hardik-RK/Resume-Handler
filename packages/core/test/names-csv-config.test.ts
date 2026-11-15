import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULTS,
  EventBus,
  ParseCache,
  REPLAY_SIZE,
  SUBSCRIBER_BACKLOG,
  clearRegisteredSecrets,
  extractKey,
  leadId,
  nameFromResumeText,
  normalizePhoneE164,
  normaliseResumeNameValue,
  phoneKey,
  redact,
  redactEvent,
  registerSecret,
  resolveConfig,
  rowsToCsvText,
  scoreKey,
  scrub,
  secretValues,
  usableResumeName,
  writeBatchCsv,
} from "../src/index.js";
import { cellValue, normalizeNameForId } from "../src/csvout.js";
import { eachRow, golden } from "./helpers/golden.js";

describe("names (golden against the Python reference)", () => {
  const g = golden("names");
  eachRow(g.fromText)("name_from_resume_text %#", ({ text, name }: { text: string; name: string }) => {
    expect(nameFromResumeText(text)).toBe(name);
  });
  eachRow(g.usable)("usable_resume_name %#", ({ value, usable }: { value: unknown; usable: boolean }) => {
    expect(usableResumeName(value)).toBe(usable);
  });
  eachRow(g.normalise)("normalise_resume_name_value %#", ({ value, out }: { value: string; out: string }) => {
    expect(normaliseResumeNameValue(value)).toBe(out);
  });

  it("reads the name from the text, never the filename (ported pytest cases)", () => {
    expect(nameFromResumeText("# Ankit Arvind Chaudhari\nIndia | +91 7715030550 | ankit@example.com")).toBe("Ankit Arvind Chaudhari");
    expect(nameFromResumeText("Senior Software Engineer | Bangalore\nMUHAMMED ASHFAQ\nBangalore, India")).toBe("Muhammed Ashfaq");
    expect(nameFromResumeText("# **SHAKIL AHMAD Java Full Stack Developer | Spring Boot**\nSome Technology Pvt Ltd | Software Developer")).toBe("Shakil Ahmad");
    expect(nameFromResumeText("Some Technology Pvt Ltd | Software Developer")).toBe("Not Specified");
    expect(normaliseResumeNameValue("SAHIL KASHYAP")).toBe("Sahil Kashyap");
  });
});

describe("identity keys and CSV (golden)", () => {
  const g = golden("csvout");
  it("lead id is sha1 of email and last ten digits, 12 chars (ported pytest case)", () => {
    const expected = crypto.createHash("sha1").update("asha@example.com|9876543210").digest("hex").slice(0, 12);
    expect(leadId("Asha@Example.com ", "+91 98765 43210", "Asha Rao")).toBe(expected);
    expect(leadId("asha@example.com", "98765-43210", "Other")).toBe(expected);
    expect(expected).toHaveLength(12);
    const byName = crypto.createHash("sha1").update("name:asha rao").digest("hex").slice(0, 12);
    expect(leadId("Not Specified", "", "Ásha  Rao!")).toBe(byName);
  });
  it("phone key and e164 basics (ported pytest case)", () => {
    expect(phoneKey("+91 98765 43210")).toBe("9876543210");
    expect(phoneKey("12")).toBe("");
    expect(normalizePhoneE164("98765 43210")).toBe("+919876543210");
    expect(normalizePhoneE164("Not Specified")).toBe("");
  });
  eachRow(g.phone)("phone %#", ({ raw, key, e164 }: { raw: string | null; key: string; e164: string }) => {
    expect(phoneKey(raw)).toBe(key);
    expect(normalizePhoneE164(raw)).toBe(e164);
  });
  eachRow(g.leadId)("lead id %#", ({ email, phone, name, id }: any) => {
    expect(leadId(email, phone, name)).toBe(id);
  });
  eachRow(g.normName)("name key %#", ({ in: input, out }: any) => {
    expect(normalizeNameForId(input)).toBe(out);
  });
  eachRow(g.cells)("cell value %i", (c: any) => {
    // a Python float with an integer value ("2.5" is fine, "5.0" cannot exist in JSON) is the only known gap
    expect(cellValue(c.value)).toBe(c.cell);
  });
  it("csv text is byte-identical to Python's csv.writer", () => {
    const rows = g.cells.map((c: any) => ({ A: c.value, B: "x" }));
    expect(rowsToCsvText(rows, ["A", "B"])).toBe(g.csvText);
    expect(rowsToCsvText([{ A: "" }, { A: "x" }, { A: null }], ["A"])).toBe(g.csvSingleEmpty);
  });
});

describe("config and redaction (golden)", () => {
  it("DEFAULTS are identical to the reference, key by key", () => {
    expect(DEFAULTS).toEqual(golden("defaults").DEFAULTS);
  });
  it("documented web-edition values and timeouts", () => {
    expect(DEFAULTS.modelFallback).not.toBe(DEFAULTS.modelExtract); // equal models would disable the fallback
    expect(DEFAULTS.modelVision).not.toBe(DEFAULTS.modelFallbackVision);
    expect(DEFAULTS.dataCollection).toBe("deny");
    expect(DEFAULTS.maxOutputTokens).toBe(3000);
    expect(DEFAULTS.driveConcurrency).toBe(4);
    expect(DEFAULTS.maxConcurrency).toBe(5);
    expect(DEFAULTS.readTimeouts).toEqual([75, 100, 130, 160]);
    expect(DEFAULTS.visionReadTimeouts).toEqual([110, 140, 170, 200]);
    expect(DEFAULTS.connectTimeout).toBe(10);
    expect(DEFAULTS.maxRetries).toBe(2);
  });
  it("absent and null keys take defaults", () => {
    const cfg = resolveConfig({ maxConcurrency: null, modelScoring: "x/y" });
    expect(cfg.maxConcurrency).toBe(DEFAULTS.maxConcurrency);
    expect(cfg.modelScoring).toBe("x/y");
    expect(resolveConfig(undefined)).toEqual(DEFAULTS);
  });
  it("drive folder settings keep both stored formats", () => {
    expect(resolveConfig({ driveFolders: [{ name: "Tech", id: "F1" }] }).driveFolders).toEqual([{ name: "Tech", id: "F1" }]);
    expect(resolveConfig({ driveFolders: { TECH: "F2" } }).driveFolders).toEqual({ TECH: "F2" });
  });
  eachRow(golden("redact").pipeline)("pipeline redact %#", ({ text, secrets, out }: any) => {
    expect(redact(text, secrets)).toBe(out);
  });
  it("redact removes secrets, emails, numbers and bearer tokens (ported pytest case)", () => {
    const out = redact("key sk-secret-123456 Bearer abc.def mail a@b.com phone +91 98765 43210 ok 12", ["sk-secret-123456"]);
    expect(out).not.toContain("sk-secret");
    expect(out).not.toContain("abc.def");
    expect(out).not.toContain("a@b.com");
    expect(out).not.toContain("98765");
    expect(out).toContain("ok 12");
  });
  it("collects secret values including the pieces of the Google documents", () => {
    const g = golden("redact");
    expect(
      secretValues({
        openrouterApiKey: "sk-test-key-0123456789",
        googleTokenJson: '{"refresh_token": "r-tok-1", "client_secret": "c-sec-1", "access_token": "a-tok-1"}',
        googleClientSecrets: { installed: { client_secret: "inst-sec" } },
      }),
    ).toEqual(g.extractedSecretValues);
  });
});

describe("event redaction (ported from test_events.py, golden)", () => {
  beforeEach(() => {
    clearRegisteredSecrets();
    registerSecret("hunter-two-secret-value");
  });
  afterEach(() => clearRegisteredSecrets());

  eachRow(golden("redact").events)("redact %#", ({ text, out }: any) => {
    expect(redactEvent(text)).toBe(out);
  });
  it("scrubs keys, bearer tokens and registered secrets", () => {
    const cleaned = redactEvent(
      "key sk-or-v1-abcdef0123456789xyz and AIzaSyD-example-google-key-0123456789 Bearer abc.def-token ; token=abc123def password: hunter2 hunter-two-secret-value",
    );
    for (const leaked of ["sk-or-v1-abcdef", "AIzaSyD", "abc.def-token", "abc123def", "hunter2", "hunter-two-secret-value"]) {
      expect(cleaned).not.toContain(leaked);
    }
  });
  it("keeps ordinary text", () => {
    const text = "Processed 12 files for Asha Rao, 3 tokens used, cost 0.02 USD";
    expect(redactEvent(text)).toBe(text);
  });
  eachRow(golden("redact").scrub)("scrub %#", ({ value, out }: any) => {
    expect(scrub(value)).toEqual(out);
  });
  it("publish scrubs nested payloads", () => {
    const bus = new EventBus();
    const event = bus.publish("log", { message: "using sk-live-abcdefgh123", extra: { key: "sk-live-zzzzzzzz9" } });
    expect(JSON.stringify(event)).not.toContain("sk-live");
  });
  it("history is bounded to the replay window", () => {
    const bus = new EventBus();
    for (let i = 0; i < 250; i++) bus.publish("log", { message: String(i) });
    const history = bus.history();
    expect(history).toHaveLength(REPLAY_SIZE);
    expect(REPLAY_SIZE).toBe(200);
    expect(history[0]!.id).toBe(51);
    expect(history.at(-1)!.id).toBe(250);
  });
  it("a late subscriber replays after the given id, then gets live events", async () => {
    const bus = new EventBus();
    for (let i = 0; i < 3; i++) bus.publish("log", { message: `m${i}` });
    const sub = bus.subscribe(1);
    expect(sub.replay.map((e) => e.id)).toEqual([2, 3]);
    const next = sub.get(500);
    bus.publish("phase", { phase: "parsing" });
    const event = await next;
    expect(event && event.type).toBe("phase");
    expect(event && event.id).toBe(4);
  });
  it("times out with undefined when idle, ends with null when the bus closes", async () => {
    const bus = new EventBus();
    const sub = bus.subscribe();
    expect(await sub.get(20)).toBeUndefined();
    bus.close();
    expect(await sub.get(500)).toBeNull();
    expect(await bus.subscribe().get(50)).toBeNull();
  });
  it("a slow subscriber is cut loose without blocking publishers", async () => {
    const bus = new EventBus();
    const sub = bus.subscribe();
    for (let i = 0; i < SUBSCRIBER_BACKLOG + 5; i++) bus.publish("log", { message: String(i) });
    expect(await sub.get(50)).toBeNull();
  });
});

describe("parse cache", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "intake-cache-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("round-trips and ignores a torn last line (ported pytest case)", () => {
    const file = path.join(dir, "c.jsonl");
    const store = new ParseCache(file);
    store.put("k1", { row: { Name: "A" } });
    fs.appendFileSync(file, '{"key": "k2", "value": {"row": '); // torn write
    const reopened = new ParseCache(file);
    expect(reopened.get("k1")).toEqual({ row: { Name: "A" } });
    expect(reopened.get("k2")).toBeNull();
    expect(reopened.size).toBe(1);
  });
  it("an append after a torn line does not merge into it (hardening over the reference)", () => {
    const file = path.join(dir, "c.jsonl");
    new ParseCache(file).put("k1", { v: 1 });
    fs.appendFileSync(file, '{"key": "torn", "value": {"r');
    const second = new ParseCache(file);
    second.put("k3", { v: 3 });
    const third = new ParseCache(file);
    expect(third.get("k1")).toEqual({ v: 1 });
    expect(third.get("k3")).toEqual({ v: 3 });
  });
  it("never overwrites a key and returns copies", () => {
    const store = new ParseCache(path.join(dir, "c.jsonl"));
    store.put("k", { a: 1 });
    store.put("k", { a: 2 });
    const first = store.get<{ a: number }>("k")!;
    first.a = 99;
    expect(store.get("k")).toEqual({ a: 1 });
  });
  it("keys match the reference and change with model and campaign (ported pytest case)", () => {
    const g = golden("cache-keys");
    for (const { args, key } of g.extract) expect(extractKey(args[0], args[1], args[2], args[3])).toBe(key);
    for (const { args, key } of g.score) expect(scoreKey(args[0], args[1], args[2])).toBe(key);
    const base = extractKey("abc", "m1/m2", "f1/f2", "TECH");
    expect(base).not.toBe(extractKey("abc", "m1/m2", "f1/f2", "SALES"));
    expect(base).not.toBe(extractKey("abc", "m9/m2", "f1/f2", "TECH"));
    expect(base).not.toBe(extractKey("def", "m1/m2", "f1/f2", "TECH"));
    expect(scoreKey("abc", "s", "jd1")).not.toBe(scoreKey("abc", "s", "jd2"));
  });
});

describe("batch CSV retention", () => {
  it("keeps only the newest twenty batch CSVs (ported pytest case)", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "intake-out-"));
    try {
      for (let i = 0; i < 22; i++) {
        const file = path.join(out, `batch_Test_2026-01-01_00-00-${String(i).padStart(2, "0")}.csv`);
        fs.writeFileSync(file, "Name\nx\n");
        const t = (Date.now() - (100 - i) * 1000) / 1000;
        fs.utimesSync(file, t, t);
      }
      writeBatchCsv(out, [{ Name: "y" }], ["Name"], "OpenRouter");
      expect(fs.readdirSync(out).filter((n) => n.startsWith("batch_") && n.endsWith(".csv"))).toHaveLength(20);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
  it("a BOM-prefixed file and a second write in the same second never overwrite", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "intake-out-"));
    try {
      const a = writeBatchCsv(out, [{ Name: "é" }], ["Name"], "Open Router!");
      const b = writeBatchCsv(out, [{ Name: "y" }], ["Name"], "Open Router!");
      expect(a).not.toBe(b);
      expect(path.basename(a)).toMatch(/^batch_OpenRouter_\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.csv$/);
      expect(fs.readFileSync(a, "utf-8").startsWith("﻿Name\né")).toBe(true);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});
