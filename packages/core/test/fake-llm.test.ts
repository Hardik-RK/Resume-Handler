import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeDrive, createFakeLlm, llm, runBatch } from "../src/index.js";
import { buildScoringBody } from "../src/jd.js";
import { candidatePdfs, makeCtx } from "./helpers/ctx.js";

// ported from test_mock_contract.py: the fake must answer with JSON that satisfies the strict schema it is asked for
function matches(value: unknown, spec: any): boolean {
  const types: string[] = Array.isArray(spec.type) ? spec.type : [spec.type];
  if (value === null) return types.includes("null") || (spec.anyOf ?? []).some((s: any) => s.type === "null");
  const checks: Record<string, (v: unknown) => boolean> = {
    string: (v) => typeof v === "string",
    number: (v) => typeof v === "number",
    array: (v) => Array.isArray(v),
    object: (v) => typeof v === "object" && !Array.isArray(v),
  };
  if (spec.anyOf) return spec.anyOf.some((s: any) => matches(value, s));
  if (!types.some((t) => checks[t]?.(value))) return false;
  if (spec.enum && !spec.enum.includes(value)) return false;
  if (Array.isArray(value) && spec.items) return value.every((item) => matches(item, spec.items));
  if (spec.type === "object" && typeof value === "object") return objectMatches(value as Record<string, unknown>, spec);
  return true;
}
function objectMatches(value: Record<string, unknown>, spec: any): boolean {
  const props = spec.properties ?? {};
  const keys = Object.keys(props);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) return false;
  if (JSON.stringify([...(spec.required ?? [])].sort()) !== JSON.stringify([...keys].sort())) return false;
  return keys.every((k) => matches(value[k], props[k]));
}

async function ask(fake: ReturnType<typeof createFakeLlm>, ctype: string, text: string): Promise<any> {
  const cfg = { CRM_CAMPAIGN_TYPE: ctype, LLM_BASE_URL: "https://openrouter.ai/api/v1" };
  const body = llm.buildBody("m", llm.buildMessages(llm.instructions([], cfg), text, [], false), [], cfg);
  const res = await fake.post("http://x/chat/completions", { headers: {}, body, timeoutMs: 1000, connectTimeoutMs: 1000 });
  expect(res.status).toBe(200);
  return { payload: JSON.parse(res.text), schema: body["response_format"].json_schema.schema };
}

describe("fake LLM provider", () => {
  const resume = "Candidate: Test Person A\ncand0@example.com   9876543200   Bengaluru, India\nEducation: B.Tech 2021, Example Institute\nSkills: Python, SQL, dashboards\n";

  it.each(["TECH", "TEACHER", "SALES", ""])("answers with JSON that satisfies the strict schema (%s)", async (ctype) => {
    const { payload, schema } = await ask(createFakeLlm(), ctype, resume);
    const content = JSON.parse(payload.choices[0].message.content);
    expect(objectMatches(content, schema), JSON.stringify(content)).toBe(true);
    expect(content.name).toBe("Test Person A");
    expect(content.email).toBe("cand0@example.com");
    expect(content.phone).toBe("9876543200");
    expect(content.graduation).toBe("2021 - B.Tech");
    expect(payload.usage.total_tokens).toBe(payload.usage.prompt_tokens + payload.usage.completion_tokens);
  });
  it("is deterministic: the same request gets the same reply, ids included", async () => {
    const a = await ask(createFakeLlm(), "TECH", resume);
    const b = await ask(createFakeLlm(), "TECH", resume);
    expect(a.payload).toEqual(b.payload);
    const other = await ask(createFakeLlm(), "TECH", resume + "more");
    expect(other.payload.id).not.toBe(a.payload.id);
  });
  it("reads skills and sales labels from the text, and a name from a header when there is no Candidate line", async () => {
    const tech = (await ask(createFakeLlm(), "TECH", "Priya Nair\nSkills: Go, Rust, Docker\n")).payload;
    const content = JSON.parse(tech.choices[0].message.content);
    expect(content.name).toBe("Priya Nair");
    expect(content.skill_tags).toEqual(["Go", "Rust", "Docker"]);
    const sales = JSON.parse((await ask(createFakeLlm(), "SALES", "Asha Rao\nExperience: inside sales and B2B accounts\n")).payload.choices[0].message.content);
    expect(sales.sales_types).toEqual(["inside sales", "B2B"]);
  });
  it("scores by keyword overlap with an explainable verdict", async () => {
    const fake = createFakeLlm();
    const score = async (jdText: string, resumeText: string): Promise<any> => {
      const res = await fake.post("u", { headers: {}, body: buildScoringBody("m", jdText, resumeText), timeoutMs: 1000, connectTimeoutMs: 1000 });
      return JSON.parse(JSON.parse(res.text).choices[0].message.content);
    };
    const fit = await score("Python Django developer needed", "Built Django services in Python");
    expect(fit).toMatchObject({ score: 100, verdict: "pass", missing_critical: [] });
    const gap = await score("Kubernetes Terraform Golang", "Python and SQL only");
    expect(gap.verdict).toBe("reject");
    expect(gap.missing_critical).toEqual(["kubernetes", "terraform", "golang"]);
    expect(gap.score).toBe(0);
    const forced = createFakeLlm({ scoreVerdict: "pass" });
    const res = await forced.post("u", { headers: {}, body: buildScoringBody("m", "x", "y"), timeoutMs: 1000, connectTimeoutMs: 1000 });
    expect(JSON.parse(JSON.parse(res.text).choices[0].message.content).verdict).toBe("pass");
  });
  it("test hooks: FAILPARSE is a 500, QUOTA a daily 429, rateLimitFirst throttles then recovers, vision gets empty fields", async () => {
    const fake = createFakeLlm({ rateLimitFirst: 1 });
    const post = (text: string): ReturnType<typeof fake.post> => {
      const cfg = { CRM_CAMPAIGN_TYPE: "TECH" };
      const body = llm.buildBody("m", llm.buildMessages("I", text, [], false), [], cfg);
      return fake.post("u", { headers: {}, body, timeoutMs: 1, connectTimeoutMs: 1 });
    };
    const throttled = await post("Candidate: A");
    expect(throttled.status).toBe(429);
    expect(throttled.headers["retry-after"]).toBe("0");
    expect((await post("FAILPARSE")).status).toBe(500);
    const quota = await post("QUOTA");
    expect(quota.status).toBe(429);
    expect(llm.classify(quota.status, quota.text)).toBe("daily");
    expect((await post("Candidate: A")).status).toBe(200);

    const cfg = { CRM_CAMPAIGN_TYPE: "TECH" };
    const vision = llm.buildBody("m", llm.buildMessages("I", "", ["data:image/png;base64,AA"], true), [], cfg, true);
    const res = await createFakeLlm().post("u", { headers: {}, body: vision, timeoutMs: 1, connectTimeoutMs: 1 });
    const content = JSON.parse(JSON.parse(res.text).choices[0].message.content);
    expect(content.name).toBeNull();
    expect(content.skill_tags).toEqual([]);
  });

  it("runs the whole pipeline offline: scan, links and a full batch, with no keys and no network", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "intake-offline-"));
    try {
      const fake = createFakeLlm();
      const drive = createFakeDrive();
      const ctx = makeCtx(tmp, { http: fake, drive, secrets: { openrouterApiKey: "demo-key-0000" } });
      candidatePdfs(ctx.dirs.input, 4);
      const result = await runBatch(ctx);
      expect(result.error).toBeNull();
      expect(result.rows.map((r) => r["Name"])).toEqual(["Test Person A", "Test Person B", "Test Person C", "Test Person D"]);
      expect(result.rows.every((r) => typeof r["Lead ID"] === "string")).toBe(true);
      expect(fake.maxInflight).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
