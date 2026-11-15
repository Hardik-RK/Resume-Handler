import { describe, expect, it } from "vitest";
import * as llm from "../src/llm.js";
import { sequenceRatio } from "../src/pyish.js";
import { eachRow, golden } from "./helpers/golden.js";

const FIELDS = golden("prompts").fields;
const OPENROUTER = "https://openrouter.ai/api/v1";

describe("prompts and strict schemas (golden against the Python reference)", () => {
  const g = golden("prompts");
  eachRow(g.cases)("instructions + schema for config %i", (c: any) => {
    expect(llm.instructions(FIELDS, c.cfg)).toBe(c.instructions);
    expect(llm.responseSchema(FIELDS, c.cfg)).toEqual(c.schema);
  });
  it("text and vision messages", () => {
    expect(llm.buildMessages("INSTR", "Candidate: A\nb@c.de", [], false)).toEqual(g.messages.text);
    expect(llm.buildMessages("INSTR", "", ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"], true)).toEqual(g.messages.vision);
    expect(g.messages.text[0].content).toBe("Extract resume facts as JSON only.");
  });
  it("the validated prompt keeps the targeted evidence rules (ported pytest case)", () => {
    const text = llm.instructions([], { CRM_CAMPAIGN_TYPE: "TECH", LLM_PROMPT_MODE: "validated" });
    expect(text).toContain("header location or contact address IS residence evidence");
    expect(text).toContain("exclude spoken languages from technical skills");
    expect(text).toContain("NEVER a calendar year");
    expect(text).toContain("ALL pages");
  });
  it("nullable enums use portable branches and the sales schema restricts labels (ported pytest cases)", () => {
    expect(llm.nullableEnum(["expert"])).toEqual({
      type: ["string", "null"],
      anyOf: [{ type: "string", enum: ["expert"] }, { type: "null" }],
    });
    const schema = llm.responseSchema([], { CRM_CAMPAIGN_TYPE: "SALES" });
    expect(schema.properties.sales_types.items.enum).toEqual(["inside sales", "field sales", "enterprise", "SMB", "B2B", "B2C", "customer success"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(Object.keys(schema.properties));
  });
  it("ATS fields only appear when enabled (env var is INTAKE_EXTRACT_ATS)", () => {
    const on = llm.responseSchema([], { CRM_CAMPAIGN_TYPE: "TECH", EXTRACT_ATS: true });
    const off = llm.responseSchema([], { CRM_CAMPAIGN_TYPE: "TECH" });
    expect("atsScore" in on.properties).toBe(true);
    expect("atsScore" in off.properties).toBe(false);
  });
});

describe("request body builder (golden)", () => {
  const g = golden("bodies");
  eachRow(g.bodies)("body case %i", (c: any) => {
    const body = llm.buildBody("model/x", [{ role: "user", content: "hi" }], FIELDS, c.cfg, c.vision, c.fallback);
    expect(body).toEqual(c.body);
  });
  eachRow(g.models)("model selection %i", (c: any) => {
    expect(llm.modelFor(c.cfg)).toBe(c.primary);
    expect(llm.modelFor(c.cfg, true)).toBe(c.vision);
    expect(llm.modelFor(c.cfg, false, true)).toBe(c.fallback);
    expect(llm.modelFor(c.cfg, true, true)).toBe(c.fallbackVision);
  });
  it("default output budget is 3000 and fallback 4096 (ported pytest case)", () => {
    expect(llm.maxOutputTokens({})).toBe(3000);
    expect(llm.maxOutputTokens({}, true)).toBe(4096);
    const body = llm.buildBody("m", [], FIELDS, { LLM_BASE_URL: OPENROUTER, CRM_CAMPAIGN_TYPE: "TECH" });
    expect(body["max_tokens"]).toBe(3000);
  });
  it("the outgoing nullable schema never mixes type and anyOf (ported pytest case)", () => {
    const body = llm.buildBody("google/gemini-2.5-flash", [], [], { CRM_CAMPAIGN_TYPE: "SALES", LLM_BASE_URL: OPENROUTER });
    const field = body["response_format"].json_schema.schema.properties.team_level;
    expect("anyOf" in field).toBe(true);
    expect("type" in field).toBe(false);
    expect(field.anyOf[1]).toEqual({ type: "null" });
  });
  it("there is no temperature unless configured, and the OpenRouter user tag is anonymous", () => {
    const base = { CRM_CAMPAIGN_TYPE: "TECH", LLM_BASE_URL: OPENROUTER, _LLM_RUN_ID: "run-1" };
    const body = llm.buildBody("m", [], [], base);
    expect("temperature" in body).toBe(false);
    expect(body["user"]).toBe("resume-intake:run-1");
  });
});

describe("row normalisers and heuristics (golden)", () => {
  const g = golden("llm-helpers");
  // Deliberate deviation from the Python reference: its list splitter was a raw-string slip that cut words at the
  // letter "n" ("Python" became "Pytho"). The goldens recorded that; the expectation below is the corrected value.
  const unslip = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll('"Pytho"', '"Python"'));
  eachRow(g.normalise)("normalise_model_row %i", (c: any) => {
    // Rows whose recorded output shows words cut at the letter n ("gular Li") are asserted explicitly further down.
    if (/gular Li|Node A"|"gle"/.test(JSON.stringify(c.row))) return;
    expect(llm.normaliseModelRow(structuredClone(c.raw), { CRM_CAMPAIGN_TYPE: c.ctype })).toEqual(unslip(c.row));
  });
  it("a string skill list keeps words whole (fixes the reference's letter-n split)", () => {
    const row = llm.normaliseModelRow({ skill_tags: "Python, Angular; Linux" }, { CRM_CAMPAIGN_TYPE: "TECH" });
    expect(row["Resume parsed skill tags"]).toEqual(["Python", "Angular", "Linux"]);
  });
  eachRow(g.badRaw)("non-object model output %#", ({ value, error }: any) => {
    expect(() => llm.normaliseModelRow(value, {})).toThrow(error);
  });
  it.each([2023, "2018", -1, NaN, Infinity])("invalid experience %s is not written (ported pytest case)", (years) => {
    const result = llm.normaliseModelRow({ skill_tags: ["Python"], skill_details: [{ name: "Python", years }] }, { CRM_CAMPAIGN_TYPE: "TECH" });
    expect(result["Skills"]).toEqual([{ name: "Python" }]);
  });
  it.each([0, 2.5, "4", 100])("valid experience %s is preserved (ported pytest case)", (years) => {
    const result = llm.normaliseModelRow({ skill_details: [{ name: "Python", years }] }, { CRM_CAMPAIGN_TYPE: "TECH" });
    expect(result["Skills"][0].years).toBe(Number(years));
  });
  eachRow(g.recoverPhone)("recover_phone %i", (c: any) => {
    expect(llm.recoverPhone(c.text)).toBe(c.out);
  });
  eachRow(g.snap)("snap contacts %i", (c: any) => {
    expect(llm.snapContactsToText(structuredClone(c.row), c.text)).toEqual(c.out);
  });
  eachRow(g.fill)("fill local contacts %i", (c: any) => {
    expect(llm.fillLocalContacts(structuredClone(c.row), c.text)).toEqual(c.out);
  });
  eachRow(g.validate)("validate_row %i", (c: any) => {
    expect(llm.validateRow(structuredClone(c.row), c.text, {})).toEqual(c.issues);
  });
  eachRow(g.extractJson)("extract_json %i", (c: any) => {
    if (c.ok) expect(llm.extractJson(c.text)).toEqual(c.value);
    else if (c.message === "JSONDecodeError") expect(() => llm.extractJson(c.text)).toThrow();
    else expect(() => llm.extractJson(c.text)).toThrow(c.message);
  });
  eachRow(g.asList)("as_list %i", (c: any) => {
    // The two string cases the Python splitter got wrong are asserted explicitly below.
    if (c.value === "Python Node" || c.value === "a\nb") return;
    expect(llm.asList(c.value)).toEqual(c.out);
  });
  it("splits a string list on ; , | and newlines, never inside a word (fixes the reference's letter-n split)", () => {
    expect(llm.asList("Python Node")).toEqual(["Python Node"]);
    expect(llm.asList("Python, Node.js; Django | React\nGo")).toEqual(["Python", "Node.js", "Django", "React", "Go"]);
    expect(llm.asList("a\nb")).toEqual(["a", "b"]);
  });
  eachRow(g.dedupe)("dedupe_strings %i", (c: any) => {
    expect(llm.dedupeStrings(c.values)).toEqual(c.out);
  });
  eachRow(g.missing)("missing %i", (c: any) => {
    expect(llm.missing(c.value)).toBe(c.out);
  });
  eachRow(g.ratios)("difflib ratio %i", (c: any) => {
    expect(sequenceRatio(c.a, c.b)).toBeCloseTo(c.ratio, 12);
  });
  eachRow(g.closest)("closest %i", (c: any) => {
    expect(llm.closest(c.value, c.cands)).toEqual(c.out);
  });
  it("snap leaves dissimilar values and the vision path alone (ported pytest case)", () => {
    const row = { "Email Address": "a@b.com", "Phone Number": "9876543210" };
    expect(llm.snapContactsToText({ ...row }, "")).toEqual(row);
  });
  it("vision reads up to four pages so last-page contacts are seen (ported pytest case)", () => {
    expect(llm.VISION_MAX_PAGES).toBeGreaterThanOrEqual(4);
  });
  it("usage accumulation, meta and merge match the reference", () => {
    const total = llm.newUsageTotals();
    g.usageSteps.forEach((step: any) => {
      llm.accumulateUsage(total, step.payload);
      expect(total).toEqual(step.total);
    });
    expect(llm.usageMeta({ model: "m/x" }, { elapsed: 1.23456, attempts: 2, retries: 1, usage: structuredClone(total) })).toEqual(g.usageMeta);
    const primary = { model: "p", attempts: 1, retries: 0, prompt_tokens: 5, cost: 0.1, latency_seconds: 1.0, generation_ids: ["a"], request_ids: [], provider_names: ["x"] };
    const secondary = { model: "s", attempts: 2, retries: 1, prompt_tokens: 7, cost: 0.2, latency_seconds: 0.5, generation_ids: ["a", "b"], total_tokens: 9 };
    expect(llm.mergeMeta(primary, secondary, { run_id: "r", vision: false })).toEqual(g.mergeMeta.merged);
    expect(llm.mergeMeta(primary, null, { extra: "e" })).toEqual(g.mergeMeta.none);
    expect(llm.mergeMeta(primary, {}, { extra: "e" })).toEqual(g.mergeMeta.empty);
  });
  eachRow(g.classify)("classify %#", ({ status, body, kind }: any) => {
    expect(llm.classify(status, body)).toBe(kind);
  });
  eachRow(g.retryAfter)("retry_after %i", (c: any) => {
    expect(llm.retryAfter({ status: 429, headers: c.headers, text: c.text }, c.default)).toBe(c.out);
  });
  eachRow(g.contentText)("content_text %i", (c: any) => {
    expect(llm.contentText(c.message)).toBe(c.out);
  });
  it("misc predicates", () => {
    g.isOpenrouter.forEach((c: any) => expect(llm.isOpenrouter(c.url)).toBe(c.out));
    expect(llm.portableSchema(llm.nullableEnum(["a", "b"]))).toEqual(g.portable);
  });
});
