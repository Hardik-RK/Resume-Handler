import { describe, expect, it } from "vitest";
import { CancelFlag, RateGate } from "../src/concurrency.js";
import { Cancelled, DailyQuotaExceeded } from "../src/errors.js";
import * as jd from "../src/jd.js";
import * as llm from "../src/llm.js";
import * as parse from "../src/parse.js";
import type { HttpClient, HttpRequest, HttpResponse } from "../src/types.js";
import { eachRow, fixture, golden } from "./helpers/golden.js";

type ScriptItem = [number, string, Record<string, string>] | { throw: string };

class ScriptedHttp implements HttpClient {
  readonly bodies: any[] = [];
  constructor(private script: ScriptItem[]) {}
  async post(_url: string, request: HttpRequest): Promise<HttpResponse> {
    this.bodies.push(structuredClone(request.body));
    const item = this.script.shift();
    if (!item) throw Object.assign(new Error("script exhausted"), { name: "ConnectionError" });
    if (!Array.isArray(item)) {
      throw Object.assign(new Error("x"), { name: item.throw === "ReadTimeout" ? "TimeoutError" : "ConnectionError" });
    }
    const [status, text, headers] = item;
    return { status, text, headers };
  }
}

function transport(script: ScriptItem[]): { tr: llm.Transport; http: ScriptedHttp; notes: string[] } {
  const http = new ScriptedHttp(script);
  const notes: string[] = [];
  const tr = new llm.Transport({ http, gate: new RateGate(2, 0.5), onRetry: (m) => notes.push(m) });
  return { tr, http, notes };
}

describe("llm post: retry, backoff and error flows (golden against the Python reference)", () => {
  const flows = golden("post-flows") as Record<string, { script: ScriptItem[]; result: any }>;
  it.each(Object.keys(flows))("%s", async (name) => {
    const { script, result } = flows[name]!;
    const { tr, http, notes } = transport(structuredClone(script));
    const body = { model: "req/model", max_tokens: 1000, messages: [] };
    let out: any;
    try {
      const { parsed, meta } = await llm.post("http://x.test/chat/completions", { Authorization: "Bearer k" }, body, "lbl", { maxRetries: 2, transport: tr });
      delete (meta as any).latency_seconds;
      out = { ok: true, parsed, meta };
    } catch (e: any) {
      const meta = e.llmMeta ? { ...e.llmMeta } : null;
      if (meta) delete meta.latency_seconds;
      out = { ok: false, error: e.name, message: e.message, meta: meta };
    }
    out.notes = notes;
    out.maxTokens = http.bodies.map((b) => b.max_tokens);
    out.calls = http.bodies.length;
    out.trips = tr.gate!.trips;
    if (out.meta === null) out.meta = result.meta === null ? null : undefined;
    expect(out).toEqual(result);
  }, 20_000);

  it("cancel wakes a waiting retry immediately", async () => {
    const cancel = new CancelFlag();
    const http = new ScriptedHttp([[500, "x", {}], [200, "never", {}]]);
    const tr = new llm.Transport({ http, cancel });
    const started = Date.now();
    const pending = llm.post("u", {}, { model: "m", max_tokens: 10 }, "lbl", { maxRetries: 3, transport: tr });
    setTimeout(() => cancel.set(), 100);
    await expect(pending).rejects.toBeInstanceOf(Cancelled);
    expect(Date.now() - started).toBeLessThan(900); // the 1 s transient back-off was interrupted
  });
});

const cfgBase = {
  LLM_API_KEY: "sk-test-key-0123456789",
  LLM_BASE_URL: "https://openrouter.ai/api/v1",
  LLM_PRIMARY_MODEL: "p/text",
  LLM_PRIMARY_VISION_MODEL: "p/vision",
  LLM_FALLBACK_MODEL: "f/text",
  LLM_FALLBACK_VISION_MODEL: "f/vision",
  CRM_CAMPAIGN_TYPE: "TECH",
  LLM_MAX_RETRIES: 1,
  VISION_DPI: 100,
  _LLM_RUN_ID: "run-test",
};

describe("extract_resume decisions (golden: fallback, vision, merge, errors)", () => {
  const flows = golden("extract-flows") as any[];
  eachRow(flows)("flow %i", async (flow) => {
    const { tr, http, notes } = transport(structuredClone(flow.script));
    const cfg = { ...cfgBase, ...flow.cfg };
    let result: any;
    try {
      const row: any = await parse.extractResume(fixture("pdf", flow.file), cfg, tr, [], "lbl");
      const meta = row._llm_meta;
      delete meta.latency_seconds;
      const text = row._resume_text;
      delete row._llm_meta;
      delete row._resume_text;
      // the text itself comes from a different PDF reader; what must hold is the vision rule
      expect(text === "" || !row._use_vision).toBe(true);
      result = { ok: true, row, meta };
    } catch (e: any) {
      const meta = { ...(e.llmMeta ?? {}) };
      delete meta.latency_seconds;
      result = { ok: false, error: e.name, message: e.message, meta };
    }
    const expected = structuredClone(flow.result);
    if (expected.ok) delete expected.row._resume_text;
    expect(result).toEqual(expected);
    const bodies = http.bodies.map((b: any) => {
      const content = b.messages[1].content;
      return {
        model: b.model,
        max_tokens: b.max_tokens,
        vision: Array.isArray(content),
        images: Array.isArray(content) ? content.length - 1 : 0,
        keys: Object.keys(b).sort(),
        system: b.messages[0].content,
        reasoning: b.reasoning ?? null,
      };
    });
    expect(bodies).toEqual(flow.bodies.map((b: any) => ({ ...b, reasoning: b.reasoning ?? null })));
    expect(notes).toEqual(flow.notes);
  });

  it("a name-only problem is repaired from the text without a second call", async () => {
    const reply = JSON.stringify({ id: "g", model: "m", choices: [{ message: { content: JSON.stringify({ name: "Not Specified", email: "priya.nair92@example.com", phone: "+91 98765 43210" }) } }], usage: {} });
    const { tr, http } = transport([[200, reply, {}]]);
    const row: any = await parse.extractResume(fixture("pdf", "priya.pdf"), cfgBase, tr, [], "lbl");
    expect(row.Name).toBe("Priya Nair");
    expect(http.bodies).toHaveLength(1);
    expect(row._llm_meta.fallback_attempted).toBe(false);
  });
  it("a daily quota or a cancel is re-thrown without trying the fallback", async () => {
    const quota = transport([[429, "requests per day exceeded", {}]]);
    await expect(parse.extractResume(fixture("pdf", "priya.pdf"), cfgBase, quota.tr, [], "l")).rejects.toBeInstanceOf(DailyQuotaExceeded);
    expect(quota.http.bodies).toHaveLength(1);
    const cancel = new CancelFlag();
    cancel.set();
    const http = new ScriptedHttp([]);
    await expect(
      parse.extractResume(fixture("pdf", "priya.pdf"), cfgBase, new llm.Transport({ http, cancel }), [], "l"),
    ).rejects.toBeInstanceOf(Cancelled);
  });
});

describe("JD scoring (golden)", () => {
  const flows = golden("jd-flows") as any[];
  eachRow(flows)("flow %i", async (flow) => {
    const { tr, http } = transport(structuredClone(flow.script));
    const cfg = { LLM_API_KEY: "sk-test-key-0123456789", LLM_BASE_URL: "https://openrouter.ai/api/v1/", LLM_SCORING_MODEL: "s/model", LLM_MAX_RETRIES: 2, ...flow.flow.cfg };
    let out: any;
    try {
      const resume = flow.flow.resume ?? "Resume text here";
      const [res, meta] = await jd.scoreResume("lbl", "JD text", cfg, tr, resume, flow.flow.fields ?? null);
      if (meta) delete meta.latency_seconds;
      out = { ok: true, result: res, meta };
    } catch (e: any) {
      out = { ok: false, error: e.name };
    }
    out.bodies = http.bodies;
    expect(out).toEqual(flow.out);
  });

  it("helpers match the reference", () => {
    const g = golden("jd-helpers");
    expect(jd.buildScoringBody("m", "JD", "RESUME")).toEqual(g.body);
    for (const c of g.fieldsToText) expect(jd.fieldsToText(c.fields)).toBe(c.out);
    for (const c of g.passes) expect(jd.passes(c.result, c.threshold)).toBe(c.out);
    expect([jd.DEFAULT_SCORING_MODEL, jd.CANNOT_DETERMINE_LIMIT, jd.MIN_SCORED]).toEqual(g.constants);
  });
  it("the scoring request carries no temperature, by design (ported pytest case)", () => {
    const body = jd.buildScoringBody("test/scorer", "Senior Python developer.", "Python developer.");
    expect(JSON.stringify(body)).not.toContain("temperature");
    expect(body["response_format"]).toEqual({ type: "json_object" });
    expect(body["messages"][1].content).toContain("Candidate Resume:\nPython developer.");
    expect(body["messages"][0].content).toBe(jd.SYSTEM_PROMPT);
  });
});
