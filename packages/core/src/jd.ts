/**
 * JD / ATS fit scoring (port of pipeline/jd.py).
 *
 * The request never carries `temperature` (some routes reject it), and every score goes through the shared
 * transport, so it shares the rate gate, the cancel and the usage accounting.
 *
 * Fail-open: a scoring error becomes a cannot_determine verdict, which the caller treats as a pass. A quota
 * error propagates so the run stops. The run aborts (see pipeline) when more than 30% of scores come back
 * cannot_determine, because that means the scorer is broken, not that the résumés are weak.
 */
import { Cancelled, DailyQuotaExceeded, errorName, llmMetaOf, type LlmMeta } from "./errors.js";
import * as llm from "./llm.js";
import { type Dict, getd, isDict, or, pyInt, pyStr, truthy } from "./pyish.js";

export const DEFAULT_SCORING_MODEL = "Qwen/Qwen3-30B-A3B-Instruct";
/** abort the run above this share (see MIN_SCORED) */
export const CANNOT_DETERMINE_LIMIT = 0.3;
/** no abort decision on a tiny sample */
export const MIN_SCORED = 10;

export const SYSTEM_PROMPT =
  "You are an expert ATS (Applicant Tracking System) and technical recruiter. Screen the " +
  "candidate's resume against the job description strictly and objectively. Do not assume " +
  "a skill, qualification, or experience unless it is explicitly supported by the resume " +
  "text. Do not inflate the score. Prioritize mandatory/must-have requirements over " +
  "nice-to-have ones. Output only valid JSON.";

export function scoringInstructions(jdText: string, resumeText: string): string {
  return `Job Description:
${jdText}

Candidate Resume:
${resumeText}

Score how well this candidate fits the job description above.

Return a single JSON object with exactly these keys:
- "score": integer 0-100, overall fit (0 = no fit, 100 = perfect fit on every requirement)
- "verdict": one of "pass", "reject", "cannot_determine"
- "missing_critical": array of short strings naming any must-have requirement the resume does
  not support (empty array if none)
- "reason": one short sentence explaining the score

Rules:
- Be evidence-based. Do not credit a skill, qualification, or years of experience that is not
  explicitly stated or clearly inferable (e.g. from dated work history) in the resume.
- Weigh required/must-have requirements far more heavily than nice-to-have ones.
- If the resume is too sparse, garbled, or ambiguous to judge fairly, use verdict
  "cannot_determine" with a low-confidence score rather than guessing.
- "verdict" should be "reject" only when the resume clearly fails one or more must-have
  requirements or is a poor overall fit; otherwise "pass".`;
}

export interface ScoreResult {
  score: number;
  verdict: "pass" | "reject" | "cannot_determine";
  missing_critical: string[];
  reason: string;
}

export function cannotDetermine(reason: string): ScoreResult {
  return { score: 0, verdict: "cannot_determine", missing_critical: [], reason };
}

/** Plain-text stand-in for a résumé with no text layer, built from the extracted fields. */
export function fieldsToText(extractedFields: Dict | null | undefined): string {
  if (!extractedFields || !truthy(extractedFields)) return "";
  return Object.entries(extractedFields)
    .filter(([k, v]) => !String(k).startsWith("_") && pyStr(v).trim() !== "" && pyStr(v).trim().toLowerCase() !== "not specified")
    .map(([k, v]) => `${k}: ${pyStr(v)}`)
    .join("\n");
}

/** The exact request body. No temperature, by design. */
export function buildScoringBody(model: string, jdText: string, resumeText: string): Dict {
  return {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: scoringInstructions(jdText, resumeText) },
    ],
    response_format: { type: "json_object" },
  };
}

/**
 * Score one résumé. Returns {score, verdict, missing_critical, reason} and the usage meta (null when no call
 * was made). Throws DailyQuotaExceeded and Cancelled.
 */
export async function scoreResume(
  label: string,
  jdText: string,
  cfg: llm.LlmCfg,
  transport: llm.Transport,
  resumeText = "",
  extractedFields: Dict | null = null,
): Promise<[ScoreResult, LlmMeta | null]> {
  let text = (resumeText || "").trim();
  if (!text && extractedFields) text = fieldsToText(extractedFields);
  if (!text) return [cannotDetermine("no readable resume text to score"), null];

  const apiKey = getd(cfg, "LLM_API_KEY", "");
  const baseUrl = String(or(cfg["LLM_BASE_URL"], llm.DEFAULT_BASE_URL)).replace(/\/+$/, "");
  if (!apiKey) return [cannotDetermine("LLM_API_KEY not set"), null];
  const model = or(cfg["LLM_SCORING_MODEL"], DEFAULT_SCORING_MODEL) as string;

  const url = `${baseUrl}/chat/completions`;
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const body = buildScoringBody(model, jdText, text);
  let result: any;
  let meta: LlmMeta;
  try {
    ({ parsed: result, meta } = await llm.post(url, headers, body, label, { transport }));
  } catch (exc) {
    if (exc instanceof DailyQuotaExceeded || exc instanceof Cancelled) throw exc;
    const errMeta = llmMetaOf(exc);
    return [cannotDetermine(`scoring failed: ${errorName(exc)}`), Object.keys(errMeta).length ? errMeta : null];
  }

  try {
    if (!isDict(result)) throw new TypeError("not an object");
    const score = Math.max(0, Math.min(100, pyInt(getd(result, "score", 0))));
    let verdict = getd(result, "verdict", "cannot_determine");
    if (!["pass", "reject", "cannot_determine"].includes(verdict)) verdict = "cannot_determine";
    const missing = or(getd(result, "missing_critical"), []);
    const reason = pyStr(getd(result, "reason", "")).slice(0, 300);
    return [{ score, verdict, missing_critical: missing, reason }, meta];
  } catch {
    return [cannotDetermine("malformed scoring response"), meta];
  }
}

/** The reference's rule: only 'reject' below the threshold is a reject; cannot_determine passes. */
export function passes(result: Pick<ScoreResult, "verdict" | "score">, threshold: number): boolean {
  if (result.verdict === "reject" && result.score < threshold) return false;
  return true;
}
