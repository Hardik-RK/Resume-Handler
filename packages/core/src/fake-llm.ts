/**
 * A deterministic, offline stand-in for an OpenAI-compatible chat-completions endpoint.
 *
 * It lets the whole pipeline run with no API keys (demo, tests): inject it as `ctx.http`.
 *
 * - Extraction requests (a json_schema response format) are answered from the résumé text with simple local
 *   heuristics, shaped by the schema the request asks for: every key present, null for scalars, [] for lists.
 * - Scoring requests (a json_object response format) are answered from keyword overlap between the job
 *   description and the résumé, so a reject is explainable and repeatable.
 * - Vision requests carry images the fake cannot read, so it answers with empty fields.
 *
 * Test hooks: a résumé containing `FAILPARSE` makes extraction fail with HTTP 500, one containing `QUOTA`
 * answers a daily-quota 429, `rateLimitFirst` makes the first N extraction calls answer 429, `delayMs` adds
 * latency and `scoreVerdict` forces the scorer's verdict.
 */
import crypto from "node:crypto";
import { EMAIL_RE_SRC, phoneRe, recoverPhone } from "./llm.js";
import { NOT_SPECIFIED, nameFromResumeText } from "./names.js";
import { digitsOnly } from "./pyjson.js";
import type { HttpClient, HttpRequest, HttpResponse } from "./types.js";

export interface FakeLlmOptions {
  /** latency added to every extraction call */
  delayMs?: number;
  /** the first N extraction calls answer 429 with retry-after 0 */
  rateLimitFirst?: number;
  /** force the scoring verdict; `auto` scores by keyword overlap */
  scoreVerdict?: "auto" | "pass" | "reject" | "cannot_determine";
}

export interface FakeLlmCall {
  kind: "extract" | "score";
  model: string | undefined;
  body: any;
}

export interface FakeLlm extends HttpClient {
  options: Required<FakeLlmOptions>;
  readonly calls: FakeLlmCall[];
  callsOf(kind?: "extract" | "score"): FakeLlmCall[];
  maxInflight: number;
}

const STOPWORDS = new Set([
  "with", "from", "that", "this", "have", "must", "will", "work", "years", "year", "experience", "strong",
  "knowledge", "ability", "skills", "developer", "engineer", "required", "preferred", "team", "good", "using",
  "and", "the", "for", "are", "you", "our", "your", "job", "role", "candidate", "senior", "junior", "need", "needed",
  "looking", "seeking", "responsible", "should", "able",
]);

function textOf(body: any): { text: string; hasImages: boolean } {
  let hasImages = false;
  for (const message of body?.messages ?? []) {
    const content = message?.content;
    if (Array.isArray(content)) {
      if (content.some((part: any) => part?.type === "image_url")) hasImages = true;
      continue;
    }
    if (typeof content === "string" && content.includes("Resume:\n")) {
      return { text: content.split("Resume:\n").slice(1).join("Resume:\n"), hasImages };
    }
  }
  return { text: "", hasImages };
}

function scoringInputs(body: any): { jd: string; resume: string } {
  const content: string = body?.messages?.[1]?.content ?? "";
  const jdStart = content.indexOf("Job Description:\n");
  const resumeStart = content.indexOf("\n\nCandidate Resume:\n");
  const end = content.indexOf("\n\nScore how well this candidate fits");
  if (jdStart === -1 || resumeStart === -1) return { jd: "", resume: content };
  return {
    jd: content.slice(jdStart + "Job Description:\n".length, resumeStart),
    resume: content.slice(resumeStart + "\n\nCandidate Resume:\n".length, end === -1 ? undefined : end),
  };
}

function keywords(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z][a-z+#.]{2,}/g) ?? [];
  return [...new Set(words.filter((w) => w.length >= 4 && !STOPWORDS.has(w)))];
}

function score(body: any, verdictMode: string): any {
  const { jd, resume } = scoringInputs(body);
  const wanted = keywords(jd);
  const have = new Set(keywords(resume));
  const absent = wanted.filter((w) => !have.has(w));
  const fraction = wanted.length ? (wanted.length - absent.length) / wanted.length : 1;
  const value = Math.round(fraction * 100);
  if (verdictMode === "reject") return { score: 20, verdict: "reject", missing_critical: absent.slice(0, 3), reason: "gap against the must-have requirements" };
  if (verdictMode === "cannot_determine") return { score: 0, verdict: "cannot_determine", missing_critical: [], reason: "unclear" };
  if (verdictMode === "pass") return { score: 80, verdict: "pass", missing_critical: [], reason: "good fit" };
  return {
    score: value,
    verdict: fraction < 0.35 ? "reject" : "pass",
    missing_critical: absent.slice(0, 3),
    reason: absent.length ? `missing ${absent.slice(0, 3).join(", ")}` : "covers the stated requirements",
  };
}

const DEGREE = /\b(B\.?\s?Tech|B\.?\s?E\.?|M\.?\s?Tech|MBA|BBA|B\.?\s?Sc\.?|M\.?\s?Sc\.?|B\.?\s?Com\.?|M\.?\s?C\.?\s?A\.?|B\.?\s?Des\.?|M\.?\s?A\.?|B\.?\s?Ed\.?)/i;

function sectionLine(text: string, label: string): string | null {
  const m = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, "im").exec(text);
  return m ? m[1]!.trim() : null;
}

function splitList(line: string | null): string[] {
  if (!line) return [];
  return line
    .replace(/\.\s*$/, "")
    .split(/[,;]| and /)
    .map((s) => s.trim())
    .filter((s) => s && s.length < 40);
}

function extractFacts(text: string): Record<string, any> {
  const candidateLine = /Candidate:\s*(.+?)(?=\s+\S+@|\s{2,}|\s+Education:|\n|$)/.exec(text);
  let name: string | null = candidateLine ? candidateLine[1]!.trim() : null;
  if (!name) {
    const guess = nameFromResumeText(text);
    name = guess === NOT_SPECIFIED ? null : guess;
  }
  const email = new RegExp(EMAIL_RE_SRC).exec(text)?.[0] ?? null;
  let phone: string | null = null;
  for (const m of text.matchAll(phoneRe())) {
    if (digitsOnly(m[0]).length >= 10) {
      phone = m[0].trim();
      break;
    }
  }
  if (!phone) phone = recoverPhone(text) || null;
  const location = /([A-Z][a-z]+(?: [A-Z][a-z]+)*),\s*India/.exec(text)?.[0] ?? null;
  const education = sectionLine(text, "Education");
  let graduation: string | null = null;
  if (education) {
    const year = /\b(19|20)\d\d\b/.exec(education)?.[0];
    const degree = DEGREE.exec(education)?.[0];
    graduation = year ? `${year}${degree ? ` - ${degree}` : ""}` : degree ?? null;
  }
  const skills = splitList(sectionLine(text, "Skills"));
  const lower = text.toLowerCase();
  const salesTypes = ["inside sales", "field sales", "enterprise", "SMB", "B2B", "B2C", "customer success"].filter((s) =>
    lower.includes(s.toLowerCase()),
  );
  return { name, email, phone, location, graduation, skills, salesTypes };
}

function extractionContent(body: any, text: string): Record<string, unknown> {
  const props: Record<string, any> = body?.response_format?.json_schema?.schema?.properties ?? {};
  const facts = extractFacts(text);
  const content: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(props)) {
    const types = Array.isArray(spec.type) ? spec.type : [spec.type];
    content[key] = types.includes("array") ? [] : null;
  }
  const known: Record<string, unknown> = {
    name: facts["name"],
    email: facts["email"],
    phone: facts["phone"],
    location: facts["location"],
    graduation: facts["graduation"],
    skill_tags: facts["skills"],
    skill_details: (facts["skills"] as string[]).map((name) => ({ name, proficiency: null, years: null })),
    sales_types: facts["salesTypes"],
  };
  for (const [key, value] of Object.entries(known)) if (key in props) content[key] = value;
  return content;
}

function wrap(body: any, content: unknown, seed: string): any {
  const prompt = JSON.stringify(body?.messages ?? "").length;
  const completion = JSON.stringify(content).length;
  const promptTokens = Math.ceil(prompt / 4);
  const completionTokens = Math.ceil(completion / 4);
  return {
    id: `gen-fake-${crypto.createHash("sha1").update(seed).digest("hex").slice(0, 10)}`,
    model: body?.model,
    choices: [{ message: { content: JSON.stringify(content) } }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      cost: Math.round((promptTokens * 0.0000002 + completionTokens * 0.0000006) * 1e8) / 1e8,
    },
  };
}

/** Create the fake provider. The returned object is an `HttpClient`; inspect `calls` in tests. */
export function createFakeLlm(options: FakeLlmOptions = {}): FakeLlm {
  const resolved: Required<FakeLlmOptions> = {
    delayMs: options.delayMs ?? 0,
    rateLimitFirst: options.rateLimitFirst ?? 0,
    scoreVerdict: options.scoreVerdict ?? "auto",
  };
  const calls: FakeLlmCall[] = [];
  let inflight = 0;
  const fake: FakeLlm = {
    options: resolved,
    calls,
    maxInflight: 0,
    callsOf: (kind) => calls.filter((c) => kind === undefined || c.kind === kind),
    async post(_url: string, request: HttpRequest): Promise<HttpResponse> {
      const body = request.body as any;
      const json = (status: number, payload: unknown, headers: Record<string, string> = {}, text?: string): HttpResponse => ({
        status,
        headers: { "content-type": "application/json", ...headers },
        text: text ?? JSON.stringify(payload),
      });
      inflight++;
      fake.maxInflight = Math.max(fake.maxInflight, inflight);
      try {
        if (body?.response_format?.type === "json_object") {
          calls.push({ kind: "score", model: body.model, body });
          return json(200, wrap(body, score(body, resolved.scoreVerdict), JSON.stringify(body.messages)));
        }
        const { text, hasImages } = textOf(body);
        calls.push({ kind: "extract", model: body?.model, body });
        const throttled = resolved.rateLimitFirst > 0;
        if (throttled) resolved.rateLimitFirst--;
        if (text.includes("FAILPARSE")) return json(500, { error: "boom" });
        if (text.includes("QUOTA")) return json(429, { error: "x" }, {}, "requests per day exceeded");
        if (throttled) return json(429, { error: "slow down" }, { "retry-after": "0" }, "rate limited");
        if (resolved.delayMs) await new Promise((r) => setTimeout(r, resolved.delayMs));
        const content = extractionContent(body, hasImages ? "" : text);
        return json(200, wrap(body, content, JSON.stringify(body.messages)));
      } finally {
        inflight--;
      }
    },
  };
  return fake;
}
