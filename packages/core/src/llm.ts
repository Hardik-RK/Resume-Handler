/**
 * LLM request construction and HTTP transport for the résumé pipeline (port of pipeline/llm.py).
 *
 * The prompts, the strict json_schema per campaign type, the row normalisers, the usage accounting and
 * the request-body builder are copied from the reference. What lives here besides: one RateGate shared by
 * every worker of a run (a 429 pauses them all and halves concurrency for a cooldown) and
 * cancellation-aware waits. Error messages never carry résumé text.
 */
import { CancelFlag, RateGate } from "./concurrency.js";
import {
  Cancelled,
  DailyQuotaExceeded,
  RuntimeFailure,
  ValueError,
  type LlmMeta,
} from "./errors.js";
import type { HttpClient, HttpResponse } from "./types.js";
import { digitsOnly } from "./pyjson.js";
import {
  type Dict,
  floatOrZero,
  getd,
  has,
  intOrZero,
  isDict,
  or,
  pyFloat,
  pyInt,
  pyStr,
  casefold,
  pyJsonLoads,
  sequenceRatio,
  truthy,
} from "./pyish.js";

export const DEFAULT_BASE_URL = "https://api.deepinfra.com/v1/openai";
export const DEFAULT_MODEL = "meta-llama/Llama-3.3-70B-Instruct";
export const DEFAULT_VISION_MODEL = "Qwen/Qwen3-VL-30B-A3B-Instruct";
export const TRANSIENT = new Set([500, 502, 503, 504]);
export const MAX_RETRIES = 4;
// Read timeouts, per attempt, copied from the reference (do NOT shorten: a slow answer is a real answer,
// and the last attempt is the patient one).
export const READ_TIMEOUTS = [75, 100, 130, 160];
export const READ_TIMEOUTS_VISION = [110, 140, 170, 200];
export const CONNECT_TIMEOUT = 10;
/** contact details can sit on the last page of a scan; most scans are 1-2 pages so the cap only costs on long ones */
export const VISION_MAX_PAGES = 4;
export const VISION_DPI = 150; // readable for OCR without bloating tokens
export const MIN_TEXT_CHARS = 200; // below this real text -> treat as scanned/image -> vision path
/** "picture omitted" markers some PDF-to-markdown converters leave */
export const PLACEHOLDER_RE = /\*\*==>.*?<==\*\*/g;
export const EMAIL_RE_SRC = "[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}";
export const EMAIL_RE = new RegExp(EMAIL_RE_SRC);
const emailRe = (): RegExp => new RegExp(EMAIL_RE_SRC, "g");
export const PHONE_RE_SRC = "\\+?\\d[\\d\\s\\-().]{8,}\\d";
export const phoneRe = (): RegExp => new RegExp(PHONE_RE_SRC, "g");

// A real Indian mobile: 10 digits starting 6-9, which may carry spaces/dashes/dots INSIDE it ("98765 43210"
// is the commonest way people write one). The leading (?<!\d) and trailing (?!\d) are what keep an ID or
// Aadhaar-length run from yielding a bogus 10-digit slice out of its middle. Commas are deliberately NOT
// separators, so "464046, 7974341200" can't fuse a postal code onto a phone. Country-code form is tried
// first, otherwise "+91" itself gets consumed as the first two digits of the number.
const MOBILE_CC = /(?<!\d)(?:\+|00)?91[\s\-.]?([6-9](?:[\s\-.]?\d){9})(?!\d)/g;
const MOBILE_PLAIN = /(?<!\d)0?([6-9](?:[\s\-.]?\d){9})(?!\d)/g;

// Things that contain digit runs but are never a phone number. Emails matter most: a local part such as
// "name8076547911@mail.example" yields a perfectly well-formed 10-digit mobile that is not the person's
// number, and a wrong number is worse than a blank one, because someone eventually rings it.
const EMAILISH_SRC = "[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+";
const URLISH_SRC = "(?:https?://|www\\.)\\S+";
const PHONE_LABEL = /(?:mobile|phone|contact|tel|cell|whats\s?app|mob|ph)\b\W{0,12}$/i;
const REFERENCES_HEAD = /\b(references?|referees?)\b/i;

export type LlmCfg = Dict;

const isAlpha = (ch: string): boolean => /^\p{L}$/u.test(ch);

/**
 * Last-resort phone lookup over the résumé text.
 *
 * The model occasionally returns "Not Specified" for a number sitting in plain sight but unlabelled. When the
 * text demonstrably contains a valid mobile, trusting the text over the model saves a lead nobody can ring.
 * Everything here exists to avoid the opposite failure: a blank phone is a visible gap somebody can chase; a
 * WRONG phone is invisible, gets dialled, and (because rows are de-duplicated on phone number) can collide
 * with another candidate and silently drop a real person from the batch. So this prefers returning nothing
 * over returning a guess.
 */
export function recoverPhone(text: string | null | undefined): string {
  if (!text) return "";
  // Blank out emails/URLs in place (length-preserving, so offsets stay meaningful).
  let scrub = text.replace(new RegExp(EMAILISH_SRC, "g"), (m) => " ".repeat(m.length));
  scrub = scrub.replace(new RegExp(URLISH_SRC, "g"), (m) => " ".repeat(m.length));

  // A referee's or emergency contact's number is not the candidate's.
  const ref = REFERENCES_HEAD.exec(scrub);
  if (ref && ref.index > 400) scrub = scrub.slice(0, ref.index);

  const found: Array<[string, number, boolean]> = [];
  for (const pattern of [MOBILE_CC, MOBILE_PLAIN]) {
    for (const m of scrub.matchAll(pattern)) {
      const digits = digitsOnly(m[1]);
      if (new Set(digits).size === 1) continue; // 9999999999 and friends
      const start = m.index!;
      const end = start + m[0].length;
      // Reject a number welded to a word: an ID, a filename, a username fragment.
      const before = scrub.slice(Math.max(0, start - 1), start);
      const after = scrub.slice(end, end + 1);
      if ((before !== "" && isAlpha(before)) || (after !== "" && isAlpha(after))) continue;
      if (found.some((f) => f[0] === digits)) continue;
      const labelled = PHONE_LABEL.test(scrub.slice(Math.max(0, start - 40), start));
      found.push([digits, start, labelled]);
    }
  }
  if (found.length === 0) return "";
  // An explicitly labelled number beats an unlabelled one; otherwise the earliest wins, since contact details
  // cluster at the top.
  found.sort((x, y) => Number(!x[2]) - Number(!y[2]) || x[1] - y[1]);
  return found[0]![0];
}

export function isTruthyFlag(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(pyStr(value).trim().toLowerCase());
}

type FieldDef = Record<string, any>;

function envAts(cfg: LlmCfg): unknown {
  const env = process.env["INTAKE_EXTRACT_ATS"];
  return env !== undefined ? env : getd(cfg, "EXTRACT_ATS", false);
}

/**
 * Build a type-aware extraction contract from the field definitions (`LLM_PROMPT_MODE=legacy`).
 * Recruiter-owned/manual columns are excluded; ATS output is opt-in.
 */
export function legacyInstructions(fields: FieldDef[], cfg: LlmCfg = {}): string {
  const campaignType = pyStr(or(cfg["CRM_CAMPAIGN_TYPE"], or(cfg["campaignType"], ""))).trim().toUpperCase();
  const atsEnabled = isTruthyFlag(envAts(cfg));

  const activeFields: FieldDef[] = [];
  for (const field of fields) {
    // `source` is reserved for values supplied by the pipeline/recruiter (date, manual source, CTC, etc.).
    // It is never a request to the language model.
    if (truthy(field["source"])) continue;
    if (getd(field, "extractor", "resume") === "ats" && !atsEnabled) continue;
    const types: unknown[] = getd(field, "campaign_types", getd(field, "campaignTypes", []));
    const campaignTypes = new Set(types.map((value) => pyStr(value).trim().toUpperCase()));
    // An unscoped run asks for all role fields. Once a campaign type is known, fields for other types disappear.
    if (campaignTypes.size > 0 && campaignType && !campaignTypes.has(campaignType)) continue;
    activeFields.push(field);
  }

  const fieldsText = activeFields.map((field) => `- "${field["name"]}": ${field["description"]}`).join("\n");
  const scope = campaignType || "the selected campaign";
  return `Extract the following information from this resume for the ${scope} campaign and return it as a single JSON object.
Return only the JSON object — no explanation, no markdown, and no extra keys.

Fields to extract:
${fieldsText}

Rules:
- Return every listed key, even when its value is unavailable. Use exactly "Not Specified" for an unavailable scalar and [] for an unavailable list.
- Extract only information explicitly stated in the resume. Do not infer, estimate, or use general knowledge to fill a gap.
- Preserve the requested JSON shape. For lists, return a JSON array; for list items, use only the properties described for that field.
- Do not copy a value into a different field because the requested field is missing. Do not include recruiter-owned, manual, ATS, or other unlisted fields.
- Name: read the candidate's complete name from the resume itself, normally from the document header. Never use the filename, file path, email username, or a guessed expansion. Convert an ALL-CAPS name to normal Title Case, but do not drop, abbreviate, reorder, or invent name parts.
- Email Address: return the candidate's primary email exactly as written, or "Not Specified". Do not treat an email-like string in a filename, URL username, or another person's contact block as the candidate's email.
- Phone Number: return the candidate's primary phone exactly as written. An Indian mobile is normally 10 digits starting with 6–9 and may have a +91 prefix. It may be unlabelled and appear inline beside an address, postal code, or email. Never return a postal code, date, year, age, salary, candidate ID, Aadhaar/enrolment number, or a number belonging to a reference/emergency contact. Keep a leading + and country code only when present; never add, remove, or alter digits.
- Current Location: use the candidate's present residence/location, not a preferred, past, employer, or job location unless the resume clearly identifies it as current.
- Graduation: report one most recent completed or currently pursuing degree and institution/year when stated; if still studying, use the expected graduation year. When several education entries exist, choose the degree rather than a diploma, short course, or certification, and use that degree's completion/expected year—not the latest date anywhere in the education section. For example, if a diploma ended in 2018 and a BE ended in 2021, return the BE and 2021.
- Skills and certifications: keep proficiency/years tied to the individual skill only when the resume explicitly ties them to that skill; do not copy an overall experience total or general proficiency statement onto every skill. Only report a certification issuer when the resume explicitly identifies it; otherwise use "Not Specified".
- For enum/category fields, do not classify by implication. For SALES CS / Sales type, require the literal category or full phrase: inside sales, field sales, enterprise, SMB, B2B/business-to-business, B2C/business-to-consumer, or customer success. If the resume says customer service, travel sales, sales executive, or generic sales, do not convert it to another category. Return [] or "Not Specified" when the evidence is insufficient.
- For role-specific lists, include only explicitly evidenced values. Keep duplicate entries out. Use the allowed categories/enums in each field description exactly; do not invent a category.`;
}

export function campaignType(cfg: LlmCfg | null | undefined): string {
  const c = cfg ?? {};
  return pyStr(or(c["CRM_CAMPAIGN_TYPE"], or(c["campaignType"], ""))).trim().toUpperCase();
}

/**
 * The compact extraction prompt used by new runs. The contract is deliberately small; the strict response
 * schema below is the source of truth. `LLM_PROMPT_MODE=legacy` remains for a controlled comparison.
 */
export function instructions(fields: FieldDef[], cfg: LlmCfg = {}): string {
  const mode = pyStr(getd(cfg, "LLM_PROMPT_MODE", "compact")).trim().toLowerCase();
  if (mode === "legacy" || mode === "verbose") return legacyInstructions(fields, cfg);

  // Faithful to the reference: ctype is never empty here (it falls back to a phrase), so with no campaign type
  // the role-line list stays empty. Recorded in PORTING-NOTES.
  const ctype = campaignType(cfg) || "the selected campaign";
  const atsEnabled = isTruthyFlag(envAts(cfg));
  const roleLines: string[] = [];
  if (ctype === "TECH" || !ctype) roleLines.push('TECH: "Skills", "Certifications", "Resume parsed skill tags"');
  if (ctype === "TEACHER" || !ctype) {
    roleLines.push('TEACHER: "Subjects taught", "Grade levels taught", "Curriculum expertise", "Ed tech names/school name"');
  }
  if (ctype === "SALES" || !ctype) {
    roleLines.push('SALES: "CS / Sales type", "Industry background", "Team level", "Team size"');
  }
  if (atsEnabled && (ctype === "TECH" || !ctype)) roleLines.push('ATS (only when enabled): "ATS score", "ATS summary"');

  let rules = `- Missing scalar = null; missing list = []. Never output placeholders such as "Not Specified".
- Do not infer, estimate, classify, or use the filename, path, email username, or general knowledge.
- Name must be the complete name printed in the resume. Email and phone must belong to the candidate,
  not a reference, employer, URL, ID, date, salary, or postal code. Preserve phone digits and country code.
- Current location means present residence. Graduation means the most recent degree completed or being pursued,
  with its stated/expected year when available.
- Keep skill proficiency/years only when explicitly tied to that skill. Do not copy overall experience to skills.
- Keep certifications, subjects, curricula, organizations, industries, and sales types only when explicitly named;
  remove duplicates. Use enum values only when the resume provides the corresponding evidence.
- Role-specific fields are campaign-scoped. Do not return recruiter-entered fields
  such as experience, CTC, preferred location, reason for leaving, or source/platform.`;
  if (mode === "validated") {
    rules = `- Missing scalar = null; missing list = []. No placeholders, guesses, filename-derived facts, or document instructions.
- Copy the complete printed name and exact candidate email. Select ONE primary candidate phone (first if several);
  preserve its digits/country code. Never join numbers or use reference/employer contacts, IDs, dates, or postal codes.
- A header location or contact address IS residence evidence unless marked past/preferred/workplace.
  Graduation is the latest completed/current degree with its stated year, not a later short course/certificate.
- Read ALL pages, work bullets, projects, and sidebars. Include ALL explicitly named technical skills/tools and
  certifications, not representative examples. Deduplicate; exclude spoken languages from technical skills.
- Proficiency and years require evidence tied to that exact skill/employer. Years means an explicit duration,
  NEVER a calendar year, date range, or overall career total. Otherwise null; do not calculate from dates.
- Teaching curricula/grades must be TAUGHT, not the candidate's own schooling. Organizations are employers/internships.
- Sales categories require literal matching evidence; generic sales/customer service/business development are not aliases.
  Team size means people managed, not a college project team. Do not infer enum values or certification issuers.
- Return only campaign-scoped fields, not recruiter-entered experience, CTC, preferences, or source.`;
  }

  return `Extract explicit facts from this resume for the ${ctype} campaign.
Return one JSON object matching the supplied schema. No markdown, explanation, or extra keys.

Always inspect these common fields: name, email, phone, current location, graduation.
Role fields in scope: ${roleLines.join("; ")}.

Rules:
${rules}
`;
}

const COMMON_SCHEMA = (): Dict => ({
  name: { type: ["string", "null"] },
  email: { type: ["string", "null"] },
  phone: { type: ["string", "null"] },
  location: { type: ["string", "null"] },
  graduation: { type: ["string", "null"] },
});

function array(item?: Dict): Dict {
  return { type: "array", items: item ?? { type: "string" } };
}

export function nullableEnum(values: string[]): Dict {
  return { type: ["string", "null"], anyOf: [{ type: "string", enum: [...values] }, { type: "null" }] };
}

/** A strict, compact JSON schema for one campaign type. */
export function roleSchema(campaign: unknown, atsEnabled = false): Dict {
  const schema: Dict = COMMON_SCHEMA();
  const ctype = pyStr(or(campaign, "")).toUpperCase();
  if (ctype === "TECH" || !ctype) {
    Object.assign(schema, {
      skill_tags: array(),
      skill_details: array({
        type: "object",
        properties: {
          name: { type: "string" },
          proficiency: nullableEnum(["beginner", "intermediate", "expert"]),
          years: { type: ["number", "null"] },
        },
        required: ["name", "proficiency", "years"],
        additionalProperties: false,
      }),
      certifications: array(),
      certification_details: array({
        type: "object",
        properties: { name: { type: "string" }, issuer: { type: ["string", "null"] } },
        required: ["name", "issuer"],
        additionalProperties: false,
      }),
    });
    if (atsEnabled) {
      Object.assign(schema, { atsScore: { type: ["number", "null"] }, atsSummary: { type: ["string", "null"] } });
    }
  }
  if (ctype === "TEACHER" || !ctype) {
    Object.assign(schema, {
      subjects: array(),
      subject_details: array({
        type: "object",
        properties: { name: { type: "string" }, category: nullableEnum(["STEM", "languages", "humanities", "arts"]) },
        required: ["name", "category"],
        additionalProperties: false,
      }),
      grade_levels: array(),
      curricula: array(),
      organizations: array(),
      organization_details: array({
        type: "object",
        properties: {
          name: { type: "string" },
          type: nullableEnum(["EDTECH", "SCHOOL", "OTHER"]),
          years: { type: ["number", "null"] },
        },
        required: ["name", "type", "years"],
        additionalProperties: false,
      }),
    });
  }
  if (ctype === "SALES" || !ctype) {
    Object.assign(schema, {
      sales_types: array({
        type: "string",
        enum: ["inside sales", "field sales", "enterprise", "SMB", "B2B", "B2C", "customer success"],
      }),
      industries: array(),
      team_level: nullableEnum(["individual_contributor", "team_lead", "manager"]),
      team_size: { type: ["number", "null"] },
    });
  }
  return { type: "object", properties: schema, required: Object.keys(schema), additionalProperties: false };
}

export function responseSchema(_fields: FieldDef[], cfg: LlmCfg | null | undefined): Dict {
  const atsEnabled = isTruthyFlag(envAts(cfg ?? {}));
  return roleSchema(campaignType(cfg), atsEnabled);
}

// ── row normalisers ──────────────────────────────────────────────────────────

const MISSING_WORDS = new Set(["", "not specified", "n/a", "na", "none", "null", "-"]);

export function missing(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return MISSING_WORDS.has(pyStr(value).trim().toLowerCase());
}

function firstValue(data: Dict, ...keys: string[]): any {
  for (const key of keys) {
    if (has(data, key) && !missing(data[key])) return data[key];
  }
  return null;
}

// The reference writes this class as r"[;,|\\n]+", which in a raw string splits on the LETTER n and a backslash
// instead of on newlines (a raw-string slip). Deliberately corrected here: split on ; , | and newlines.
const LIST_SPLIT = /[;,|\n]+/;

export function asList(value: unknown): any[] {
  if (value === null || value === undefined || missing(value)) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    return value
      .split(LIST_SPLIT)
      .map((part) => part.trim())
      .filter((part) => part);
  }
  return [value];
}

const collapseWs = (value: string): string => value.replace(/\s+/g, " ").trim();

export function dedupeStrings(values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let value of values) {
    if (isDict(value)) value = value["name"];
    if (value === null || value === undefined) continue;
    const text = collapseWs(pyStr(value));
    if (!text || missing(text)) continue;
    const key = casefold(text);
    if (!seen.has(key)) {
      out.push(text);
      seen.add(key);
    }
  }
  return out;
}

/** Merge compact list/string output into the legacy list-of-objects shape. */
export function normaliseDetails(
  value: unknown,
  names: unknown,
  options: { allowed?: Record<string, Set<string>>; numericKey?: string; extraKeys?: string[] } = {},
): Dict[] {
  const { allowed, numericKey, extraKeys = [] } = options;
  const details: Dict[] = [];
  const seen = new Set<string>();
  for (let item of asList(value)) {
    if (typeof item === "string") item = { name: item };
    if (!isDict(item)) continue;
    let name = firstValue(item, "name", "title", "value");
    if (missing(name)) continue;
    name = collapseWs(pyStr(name));
    const key = casefold(name);
    if (seen.has(key)) continue;
    seen.add(key);
    const entry: Dict = { name };
    for (const extra of extraKeys) {
      let val: any = has(item, extra) ? item[extra] : null;
      if (allowed && extra in allowed) {
        if (val === null || val === "" || val === "Not Specified") continue;
        const accepted = allowed[extra]!;
        const candidate = extra === "proficiency" ? pyStr(val).toLowerCase() : pyStr(val).toUpperCase();
        if (!accepted.has(candidate)) continue;
        val = extra === "type" || extra === "proficiency" ? candidate : pyStr(val);
      }
      if (numericKey === extra && val !== null) {
        try {
          let num = pyFloat(val);
          if (numericKey === "years" && !(num >= 0 && num <= 100)) continue;
          if (Number.isInteger(num)) num = Math.trunc(num);
          val = num;
        } catch {
          continue;
        }
      }
      if (val !== null && !missing(val)) entry[extra] = val;
    }
    details.push(entry);
  }
  for (const name of dedupeStrings(asList(names))) {
    if (!seen.has(casefold(name))) {
      details.push({ name });
      seen.add(casefold(name));
    }
  }
  return details;
}

/** Convert compact canonical output (and old mock/legacy output) to the output column labels. */
export function normaliseModelRow(raw: unknown, cfg: LlmCfg | null = null): Dict {
  if (!isDict(raw)) throw new ValueError("model output was not a JSON object");
  const ctype = campaignType(cfg ?? {});
  const row: Dict = {
    Name: or(firstValue(raw, "name", "Name"), "Not Specified"),
    "Email Address": or(firstValue(raw, "email", "Email Address"), "Not Specified"),
    "Phone Number": or(firstValue(raw, "phone", "Phone Number"), "Not Specified"),
    "Current Location": or(firstValue(raw, "location", "current_location", "Current Location"), "Not Specified"),
    Graduation: or(firstValue(raw, "graduation", "Graduation"), "Not Specified"),
  };
  if (ctype === "TECH" || !ctype) {
    const skillDetails = normaliseDetails(getd(raw, "skill_details", getd(raw, "Skills")), getd(raw, "skill_tags", getd(raw, "Resume parsed skill tags")), {
      allowed: { proficiency: new Set(["beginner", "intermediate", "expert"]) },
      extraKeys: ["proficiency", "years"],
      numericKey: "years",
    });
    const certDetails = normaliseDetails(getd(raw, "certification_details", getd(raw, "Certifications")), getd(raw, "certifications"), {
      extraKeys: ["issuer"],
    });
    row["Skills"] = skillDetails;
    row["Certifications"] = certDetails;
    row["Resume parsed skill tags"] = dedupeStrings([
      ...asList(getd(raw, "skill_tags", getd(raw, "Resume parsed skill tags"))),
      ...skillDetails.map((item) => item["name"]),
    ]);
    if (has(raw, "atsScore") || has(raw, "ATS score")) {
      row["ATS score"] = or(firstValue(raw, "atsScore", "ATS score"), "Not Specified");
    }
    if (has(raw, "atsSummary") || has(raw, "ATS summary") || has(raw, "Summary")) {
      row["ATS summary"] = or(firstValue(raw, "atsSummary", "ATS summary", "Summary"), "Not Specified");
    }
  }
  if (ctype === "TEACHER" || !ctype) {
    const subjectDetails = normaliseDetails(getd(raw, "subject_details", getd(raw, "Subjects taught")), getd(raw, "subjects"), {
      extraKeys: ["category"],
    });
    const orgDetails = normaliseDetails(
      getd(raw, "organization_details", getd(raw, "Ed tech names/school name")),
      getd(raw, "organizations"),
      { allowed: { type: new Set(["EDTECH", "SCHOOL", "OTHER"]) }, extraKeys: ["type", "years"], numericKey: "years" },
    );
    row["Subjects taught"] = subjectDetails;
    row["Grade levels taught"] = dedupeStrings(asList(getd(raw, "grade_levels", getd(raw, "Grade levels taught"))));
    row["Curriculum expertise"] = dedupeStrings(asList(getd(raw, "curricula", getd(raw, "Curriculum expertise"))));
    row["Ed tech names/school name"] = orgDetails;
  }
  if (ctype === "SALES" || !ctype) {
    row["CS / Sales type"] = dedupeStrings(asList(getd(raw, "sales_types", getd(raw, "CS / Sales type"))));
    row["Industry background"] = dedupeStrings(asList(getd(raw, "industries", getd(raw, "Industry background"))));
    row["Team level"] = or(firstValue(raw, "team_level", "Team level"), "Not Specified");
    row["Team size"] = or(firstValue(raw, "team_size", "Team size"), "Not Specified");
  }
  return row;
}

function usableName(value: unknown): boolean {
  if (missing(value)) return false;
  const text = pyStr(value).trim();
  return !(text.includes("@") || /https?:\/\/|\p{Nd}/iu.test(text));
}

/** Quality flags that warrant one cheaper-model fallback attempt. */
export function validateRow(row: Dict, text = "", _cfg: LlmCfg | null = null): string[] {
  const issues: string[] = [];
  if (missing(row["Name"]) || !usableName(row["Name"])) issues.push("name_missing_or_invalid");
  const email = pyStr(or(row["Email Address"], "")).trim();
  const fullEmail = new RegExp(`^(?:${EMAIL_RE_SRC})$`);
  if (missing(email)) {
    if (missing(row["Phone Number"])) issues.push("both_contacts_missing");
  } else if (!fullEmail.test(email.replace(/ /g, ""))) {
    issues.push("email_invalid");
  }
  const phone = pyStr(or(row["Phone Number"], "")).trim();
  if (!missing(phone) && digitsOnly(phone).length < 10) issues.push("phone_invalid");
  if (text && email && EMAIL_RE.test(text)) {
    const candidates = new Set([...text.matchAll(emailRe())].map((m) => casefold(m[0])));
    if (!candidates.has(casefold(email.replace(/ /g, ""))) && candidates.size === 1) {
      issues.push("email_conflicts_with_text");
    }
  }
  return issues;
}

/**
 * Fill only a blank phone from deterministic local extraction, then snap contacts to the text. Validation
 * happens after this safeguard, so a readable phone does not trigger an unnecessary fallback call.
 */
export function fillLocalContacts(row: Dict, text: string): Dict {
  if (!isDict(row)) return row;
  if (missing(row["Phone Number"])) {
    const found = recoverPhone(text);
    if (found) row["Phone Number"] = found;
  }
  return snapContactsToText(row, text);
}

/** The candidate most similar to `value`, if similar enough to be a transcription slip. */
export function closest(value: string, candidates: string[], threshold = 0.85): string | null {
  let best: string | null = null;
  let bestRatio = threshold;
  for (const cand of candidates) {
    const ratio = sequenceRatio(value, cand);
    if (ratio >= bestRatio) {
      best = cand;
      bestRatio = ratio;
    }
  }
  return best;
}

/**
 * Fix one-character transcription slips: when the model's email/phone is not in the text but a near-identical
 * one is, use the text's. Never invents a value; leaves the row untouched when nothing in the text is close
 * (and on the vision path, where `text` is empty).
 */
export function snapContactsToText(row: Dict, text: string): Dict {
  if (!text || !isDict(row)) return row;
  const email = pyStr(or(row["Email Address"], "")).trim();
  if (!missing(email)) {
    const despaced = text.replace(/\s*([.@])\s*/g, (_m, c: string) => c);
    const found = [...despaced.matchAll(emailRe())].map((m) => m[0]);
    const folded = casefold(email.replace(/ /g, ""));
    if (found.length > 0 && !new Set(found.map((f) => casefold(f))).has(folded)) {
      const best = closest(folded, found.map((f) => casefold(f)));
      if (best) row["Email Address"] = found.find((f) => casefold(f) === best);
    }
  }
  const phone = pyStr(or(row["Phone Number"], "")).trim();
  const digits = digitsOnly(phone);
  if (!missing(phone) && digits.length >= 10 && !digitsOnly(text).includes(digits.slice(-10))) {
    const scrub = text.replace(new RegExp(EMAILISH_SRC, "g"), " ").replace(new RegExp(URLISH_SRC, "g"), " ");
    const cands = new Map<string, string>();
    for (const m of scrub.matchAll(new RegExp("\\+?\\d[\\d\\s\\-().]{8,}\\d", "g"))) {
      const d = digitsOnly(m[0]);
      if (d.length >= 10 && !cands.has(d.slice(-10))) cands.set(d.slice(-10), m[0].trim());
    }
    const best = closest(digits.slice(-10), [...cands.keys()]);
    if (best) row["Phone Number"] = cands.get(best);
  }
  return row;
}

// ── request body ─────────────────────────────────────────────────────────────

export function isOpenrouter(baseUrl: unknown): boolean {
  return pyStr(or(baseUrl, "")).toLowerCase().includes("openrouter.ai");
}

function parseNumber(value: unknown, fallback: number): number {
  try {
    return pyFloat(value);
  } catch {
    return fallback;
  }
}

export interface UsageTotals {
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  cost: number;
  generation_ids: string[];
  request_ids: string[];
  provider_names: string[];
}

export function newUsageTotals(): UsageTotals {
  return {
    prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, cached_tokens: 0, total_tokens: 0, cost: 0,
    generation_ids: [], request_ids: [], provider_names: [],
  };
}

export function accumulateUsage(total: UsageTotals, payload: unknown): void {
  if (isDict(payload)) {
    for (const [key, target] of [["id", "generation_ids"], ["request_id", "request_ids"], ["provider_name", "provider_names"]] as const) {
      const value = payload[key];
      if (truthy(value) && !total[target].includes(value)) total[target].push(value);
    }
  }
  const rawUsage = isDict(payload) ? payload["usage"] : null;
  const usage: Dict = isDict(rawUsage) ? rawUsage : {};
  const completionDetail: Dict = isDict(usage["completion_tokens_details"]) ? usage["completion_tokens_details"] : {};
  const promptDetail: Dict = isDict(usage["prompt_tokens_details"]) ? usage["prompt_tokens_details"] : {};
  total.prompt_tokens += intOrZero(usage["prompt_tokens"]);
  total.completion_tokens += intOrZero(usage["completion_tokens"]);
  total.reasoning_tokens += intOrZero(or(completionDetail["reasoning_tokens"], usage["reasoning_tokens"]));
  total.cached_tokens += intOrZero(or(promptDetail["cached_tokens"], usage["cached_tokens"]));
  total.total_tokens += intOrZero(usage["total_tokens"]);
  total.cost += floatOrZero(usage["cost"]);
}

export function usageMeta(
  payload: unknown,
  options: { responseModel?: string | null; elapsed?: number; attempts?: number; retries?: number; usage?: UsageTotals } = {},
): LlmMeta {
  const { responseModel = null, elapsed = 0, attempts = 1, retries = 0 } = options;
  let usage = options.usage;
  if (!usage) {
    usage = newUsageTotals();
    accumulateUsage(usage, payload);
  }
  return {
    model: or(responseModel, isDict(payload) ? getd(payload, "model", null) : null),
    attempts,
    retries,
    latency_seconds: Math.round(Number(elapsed) * 1000) / 1000,
    prompt_tokens: intOrZero(usage.prompt_tokens),
    completion_tokens: intOrZero(usage.completion_tokens),
    reasoning_tokens: intOrZero(usage.reasoning_tokens),
    cached_tokens: intOrZero(usage.cached_tokens),
    total_tokens: intOrZero(usage.total_tokens),
    cost: floatOrZero(usage.cost),
    generation_ids: [...(usage.generation_ids ?? [])],
    request_ids: [...(usage.request_ids ?? [])],
    provider_names: [...(usage.provider_names ?? [])],
  };
}

const SUMMED_META_KEYS = [
  "prompt_tokens", "completion_tokens", "reasoning_tokens", "cached_tokens", "total_tokens", "cost",
  "latency_seconds", "attempts", "retries",
] as const;

export function mergeMeta(primary: LlmMeta | null | undefined, secondary?: LlmMeta | null, extra: LlmMeta = {}): LlmMeta {
  const out: LlmMeta = { ...(primary ?? {}) };
  if (secondary && truthy(secondary)) {
    for (const key of SUMMED_META_KEYS) out[key] = Number(or(out[key], 0)) + Number(or(secondary[key], 0));
    const primaryModel = out.model;
    out.model = or(secondary.model, primaryModel);
    out["primary_model"] = primaryModel;
    out["fallback_model"] = secondary.model;
    out["fallback_used"] = true;
    for (const key of ["generation_ids", "request_ids", "provider_names"] as const) {
      const values = [...((out[key] as string[] | undefined) ?? [])];
      for (const value of secondary[key] ?? []) if (!values.includes(value)) values.push(value);
      out[key] = values;
    }
  }
  return Object.assign(out, extra);
}

// ── error handling and reply parsing ─────────────────────────────────────────

/**
 * Pull the JSON object out of a model reply, tolerating anything wrapped around it: a sentence before the
 * object, a trailing note, or the code fence anywhere. Scans for the first balanced object.
 */
export function extractJson(reply: string): any {
  const s = reply
    .trim()
    .replace(/^\s*```(?:json)?\s*/, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  try {
    return pyJsonLoads(s);
  } catch {
    /* fall through to the balanced scan */
  }
  const start = s.indexOf("{");
  if (start === -1) throw new ValueError("reply contained no JSON object");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      // braces inside string values must not count
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return pyJsonLoads(s.slice(start, i + 1));
        } catch (e) {
          throw new ValueError((e as Error).message);
        }
      }
    }
  }
  throw new ValueError("reply contained an unterminated JSON object");
}

export type ErrorKind = "daily" | "minute" | "transient" | "fatal";

export function classify(status: number, bodyLow: string): ErrorKind {
  if (status === 429) {
    if (["per day", "daily", "tpd", "requests per day"].some((s) => bodyLow.includes(s))) return "daily";
    return "minute";
  }
  if (TRANSIENT.has(status)) return "transient";
  return "fatal";
}

export function retryAfter(resp: HttpResponse, fallback: number): number {
  const ra = resp.headers["retry-after"];
  if (ra) {
    try {
      return Math.min(pyFloat(ra) + 1, 65);
    } catch {
      /* not a number: try the body */
    }
  }
  const m = /try again in ([\d.]+)s/.exec(resp.text);
  if (m) {
    try {
      return Math.min(pyFloat(m[1]) + 1, 65);
    } catch {
      /* ignore */
    }
  }
  return fallback;
}

export function contentText(message: unknown): string {
  const content = isDict(message) ? message["content"] : "";
  if (Array.isArray(content)) {
    return content
      .filter((part) => isDict(part) && part["text"] !== null && part["text"] !== undefined)
      .map((part) => pyStr(part["text"]))
      .join("");
  }
  if (isDict(content)) return pyStr(or(content["text"], or(content["value"], "")));
  return pyStr(or(content, ""));
}

const EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

export function reasoningEffort(cfg: LlmCfg, fallback = false, vision = false): string {
  let value: unknown;
  if (fallback) {
    const key = vision ? "LLM_FALLBACK_VISION_REASONING_EFFORT" : "LLM_FALLBACK_REASONING_EFFORT";
    value = getd(cfg, key, getd(cfg, "LLM_FALLBACK_REASONING_EFFORT", "low"));
  } else {
    const key = vision ? "LLM_VISION_REASONING_EFFORT" : "LLM_REASONING_EFFORT";
    value = getd(cfg, key, "none");
  }
  const text = pyStr(or(value, "none")).trim().toLowerCase();
  return EFFORTS.has(text) ? text : "none";
}

export function modelFor(cfg: LlmCfg, vision = false, fallback = false): string {
  if (fallback) {
    const key = vision ? "LLM_FALLBACK_VISION_MODEL" : "LLM_FALLBACK_MODEL";
    return pyStr(or(getd(cfg, key, ""), "")).trim();
  }
  const key = vision ? "LLM_PRIMARY_VISION_MODEL" : "LLM_PRIMARY_MODEL";
  const legacyKey = vision ? "LLM_VISION_MODEL" : "LLM_MODEL";
  return pyStr(or(cfg[key], or(cfg[legacyKey], vision ? DEFAULT_VISION_MODEL : DEFAULT_MODEL))).trim();
}

export function maxOutputTokens(cfg: LlmCfg, fallback = false): number {
  const key = fallback ? "LLM_FALLBACK_MAX_OUTPUT_TOKENS" : "LLM_MAX_OUTPUT_TOKENS";
  // Web edition: 3000 output tokens by default (fallback 4096). The reference used 1600 for the compact
  // prompt; the larger budget only stops truncated replies, it changes no content.
  const fallbackValue = fallback ? 4096 : 3000;
  try {
    return Math.max(256, pyInt(getd(cfg, key, fallbackValue)));
  } catch {
    return fallbackValue;
  }
}

export function providerOptions(cfg: LlmCfg): Dict {
  const options: Dict = {
    require_parameters: isTruthyFlag(getd(cfg, "OPENROUTER_REQUIRE_PARAMETERS", true)),
    allow_fallbacks: isTruthyFlag(getd(cfg, "OPENROUTER_ALLOW_FALLBACKS", true)),
  };
  for (const [key, name] of [
    ["OPENROUTER_DATA_COLLECTION", "data_collection"],
    ["OPENROUTER_ZDR", "zdr"],
    ["OPENROUTER_SORT", "sort"],
  ] as const) {
    const value = cfg[key];
    if (value !== null && value !== undefined && value !== "") options[name] = value;
  }
  let order = cfg["OPENROUTER_PROVIDER_ORDER"];
  if (typeof order === "string") {
    order = order
      .split(",")
      .map((part: string) => part.trim())
      .filter((part: string) => part);
  }
  if (truthy(order)) options["order"] = order;
  return options;
}

/** Drop `type` wherever an `anyOf` sits beside it (providers reject the mix). */
export function portableSchema(value: any): any {
  if (Array.isArray(value)) return value.map(portableSchema);
  if (!isDict(value)) return value;
  const out: Dict = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "type" && "anyOf" in value) continue;
    out[key] = portableSchema(item);
  }
  return out;
}

export function buildBody(model: string, messages: unknown[], fields: FieldDef[], cfg: LlmCfg, vision = false, fallback = false): Dict {
  const baseUrl = getd(cfg, "LLM_BASE_URL", DEFAULT_BASE_URL);
  const body: Dict = { model, messages, max_tokens: maxOutputTokens(cfg, fallback) };
  // Some reasoning models reject temperature entirely. Let the provider/model use its deterministic
  // structured-output path unless an explicit temperature was configured for a compatible endpoint.
  const temperature = cfg["LLM_TEMPERATURE"];
  if (temperature !== null && temperature !== undefined && temperature !== "") {
    try {
      body["temperature"] = pyFloat(temperature);
    } catch {
      /* ignored, as the reference */
    }
  }
  const responseMode = pyStr(or(getd(cfg, "LLM_RESPONSE_FORMAT", "json_schema"), "json_schema")).toLowerCase();
  if (responseMode === "json_object" || responseMode === "legacy") {
    body["response_format"] = { type: "json_object" };
  } else {
    body["response_format"] = {
      type: "json_schema",
      json_schema: { name: "resume_extraction", strict: true, schema: portableSchema(responseSchema(fields, cfg)) },
    };
  }
  if (isOpenrouter(baseUrl)) {
    body["reasoning"] = { effort: reasoningEffort(cfg, fallback, vision) };
    body["provider"] = providerOptions(cfg);
    const runId = pyStr(or(getd(cfg, "_LLM_RUN_ID", ""), "")).trim();
    if (runId) {
      // OpenRouter stores this as external_user. Keep it anonymous and short: it is only a batch correlation
      // key, never a candidate identifier.
      body["user"] = ("resume-intake:" + runId).slice(0, 64);
    }
  } else {
    const effort = reasoningEffort(cfg, fallback, vision);
    if (effort !== "none") body["reasoning_effort"] = effort;
  }
  return body;
}

export function buildMessages(instructionText: string, text: string, images: string[], vision = false): Dict[] {
  if (!vision) {
    return [
      { role: "system", content: "Extract resume facts as JSON only." },
      { role: "user", content: instructionText + "\n\nResume:\n" + text },
    ];
  }
  const content: Dict[] = [{ type: "text", text: instructionText + "\n\nThe resume is attached as image(s)." }];
  for (const uri of images) content.push({ type: "image_url", image_url: { url: uri } });
  return [
    { role: "system", content: "Read the attached resume image(s) and extract facts as JSON only." },
    { role: "user", content },
  ];
}

// ── transport ────────────────────────────────────────────────────────────────

export interface TransportOptions {
  http: HttpClient;
  gate?: RateGate | null;
  cancel?: CancelFlag;
  readTimeouts?: number[];
  visionReadTimeouts?: number[];
  connectTimeout?: number;
  onRetry?: (message: string) => void;
}

/** Everything one run needs to talk to the provider: client, gate, cancel, timeouts (seconds). */
export class Transport {
  readonly http: HttpClient;
  readonly gate: RateGate | null;
  readonly cancel: CancelFlag;
  readonly readTimeouts: number[];
  readonly visionReadTimeouts: number[];
  readonly connectTimeout: number;
  private readonly onRetry: ((message: string) => void) | undefined;

  constructor(options: TransportOptions) {
    this.http = options.http;
    this.gate = options.gate ?? null;
    this.cancel = options.cancel ?? new CancelFlag();
    this.readTimeouts = [...(options.readTimeouts ?? READ_TIMEOUTS)];
    this.visionReadTimeouts = [...(options.visionReadTimeouts ?? READ_TIMEOUTS_VISION)];
    this.connectTimeout = options.connectTimeout ?? CONNECT_TIMEOUT;
    this.onRetry = options.onRetry;
  }

  checkCancel(): void {
    if (this.cancel.isSet()) throw new Cancelled();
  }

  sleep(seconds: number): Promise<void> {
    return this.cancel.sleep(seconds);
  }

  async send(url: string, headers: Record<string, string>, body: unknown, readTimeoutSeconds: number): Promise<HttpResponse> {
    if (this.gate) await this.gate.acquire(this.cancel);
    try {
      return await this.http.post(url, {
        headers,
        body,
        timeoutMs: readTimeoutSeconds * 1000,
        connectTimeoutMs: this.connectTimeout * 1000,
        signal: this.cancel.signal,
      });
    } finally {
      this.gate?.release();
    }
  }

  readTimeout(attempt: number, vision = false): number {
    const table = vision ? this.visionReadTimeouts : this.readTimeouts;
    return table[Math.min(attempt, table.length - 1)]!;
  }

  note(message: string): void {
    this.onRetry?.(message);
  }
}

/** The `fetch`-based client used when the context supplies none. */
export function createFetchClient(): HttpClient {
  return {
    async post(url, request) {
      const res = await fetch(url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: request.signal ? AbortSignal.any([AbortSignal.timeout(request.timeoutMs), request.signal]) : AbortSignal.timeout(request.timeoutMs),
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return { status: res.status, headers, text: await res.text() };
    },
  };
}

function networkErrorName(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError" ? "ReadTimeout" : "ConnectionError";
}

export interface PostResult {
  parsed: any;
  meta: LlmMeta;
}

/**
 * POST with bounded retry/backoff; returns the parsed JSON plus usage metadata.
 *
 * `label` identifies the request in retry notes; it is a short content hash, never a file name. The retry
 * rules are the reference's: network errors and 5xx/empty/unparseable replies are retried, 429 (minute) waits
 * on the shared gate, daily quota raises DailyQuotaExceeded.
 */
export async function post(
  url: string,
  headers: Record<string, string>,
  body: Dict,
  label: string,
  options: { vision?: boolean; maxRetries?: unknown; transport?: Transport } = {},
): Promise<PostResult> {
  const tr = options.transport ?? new Transport({ http: createFetchClient() });
  const vision = options.vision ?? false;
  let retryLimit: number;
  try {
    retryLimit = Math.max(1, pyInt(options.maxRetries !== undefined && options.maxRetries !== null ? options.maxRetries : MAX_RETRIES));
  } catch {
    retryLimit = MAX_RETRIES;
  }
  const started = performance.now();
  let requestBody = body;
  const usageTotal = newUsageTotals();

  const failWithMeta = (message: string, attempt: number): never => {
    const error = new RuntimeFailure(message);
    error.llmMeta = usageMeta({}, {
      responseModel: requestBody["model"],
      elapsed: (performance.now() - started) / 1000,
      attempts: attempt + 1,
      retries: attempt,
      usage: usageTotal,
    });
    throw error;
  };

  for (let attempt = 0; attempt < retryLimit; attempt++) {
    tr.checkCancel();
    let resp: HttpResponse;
    try {
      resp = await tr.send(url, headers, requestBody, tr.readTimeout(attempt, vision));
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      tr.checkCancel(); // an abort caused by Cancel is a cancel, not a network error to retry
      if (attempt < retryLimit - 1) {
        // A read timeout means the request queued behind something slow; backing off only wastes the retry.
        // Back off briefly for genuine connection failures.
        const timedOut = networkErrorName(e) === "ReadTimeout";
        tr.note(`[retry] ${label}: ${networkErrorName(e)}`);
        await tr.sleep(timedOut ? 0.5 : 2 ** attempt);
        continue;
      }
      return failWithMeta(`network error after ${retryLimit} attempts (${networkErrorName(e)})`, attempt);
    }

    if (resp.status === 200) {
      let payload: any;
      let content: string;
      try {
        payload = JSON.parse(resp.text);
        const message = payload["choices"][0]["message"];
        content = contentText(message).trim();
        accumulateUsage(usageTotal, payload);
      } catch {
        payload = {};
        content = "";
      }
      content = content.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
      if (!content) {
        if (attempt < retryLimit - 1) {
          tr.note(`[retry] ${label}: empty response`);
          await tr.sleep(2 ** attempt);
          continue;
        }
        return failWithMeta(`model returned an empty response after ${retryLimit} attempts`, attempt);
      }

      let parsed: any;
      try {
        parsed = extractJson(content);
      } catch (e) {
        if (attempt < retryLimit - 1) {
          // Truncated output: only this request gets a larger budget on the retry.
          if (/unterminated/i.test((e as Error).message) && truthy(requestBody["max_tokens"])) {
            try {
              const currentLimit = pyInt(requestBody["max_tokens"]);
              requestBody = { ...requestBody, max_tokens: Math.min(Math.max(currentLimit + 256, currentLimit * 2), 4096) };
            } catch {
              /* keep the budget */
            }
          }
          tr.note(`[retry] ${label}: unparseable reply`);
          await tr.sleep(1);
          continue;
        }
        return failWithMeta(`model reply was not JSON after ${retryLimit} attempts`, attempt);
      }

      const meta = usageMeta(payload, {
        responseModel: isDict(payload) ? getd(payload, "model", null) : null,
        elapsed: (performance.now() - started) / 1000,
        attempts: attempt + 1,
        retries: attempt,
        usage: usageTotal,
      });
      return { parsed, meta };
    }

    const kind = classify(resp.status, (resp.text || "").toLowerCase());
    if (kind === "daily") throw new DailyQuotaExceeded("provider daily quota exhausted");
    if (kind === "minute" && tr.gate) tr.gate.onRateLimited(retryAfter(resp, 2 ** attempt));
    if ((kind === "minute" || kind === "transient") && attempt < retryLimit - 1) {
      const wait = retryAfter(resp, 2 ** attempt);
      const reason = kind === "minute" ? "rate limited" : "server busy";
      tr.note(`[retry] ${label}: ${reason} (${resp.status})`);
      if (kind === "transient") await tr.sleep(wait);
      continue;
    }
    return failWithMeta(`HTTP ${resp.status}`, attempt);
  }
  // unreachable: the loop either returns or throws on its last attempt
  return failWithMeta("no attempts were made", 0);
}

/** The field list for the legacy prompt mode (the compact prompt and the schema do not use it). */
export function loadFields(explicit?: FieldDef[] | null): FieldDef[] {
  return explicit ? [...explicit] : [];
}
