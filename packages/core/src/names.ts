/**
 * Candidate-name heuristics (no network). The name always comes from the résumé text, never the filename.
 * Port of pipeline/names.py.
 */

import { casefold } from "./pyish.js";

const HONORIFICS = /\b(Dr|Mr|Mrs|Ms|Miss|Prof|Shri|Smt)\.?\s+/gi;

const SECTION_HEADINGS = new Set([
  "resume", "résumé", "cv", "curriculum vitae", "profile", "summary",
  "professional summary", "objective", "career objective", "experience",
  "professional experience", "work experience", "employment history", "education",
  "technical skills", "skills", "core skills", "certifications", "contact",
  "personal details", "projects", "references", "languages", "achievements",
]);
const ROLE_WORDS = new Set([
  "administrator", "analyst", "architect", "associate", "consultant", "coordinator",
  "designer", "developer", "director", "engineer", "executive", "intern", "lead",
  "manager", "recruiter", "representative", "specialist", "supervisor", "teacher",
  "technical", "software", "sales", "support", "trainer", "writer",
]);
const TITLE_START_WORDS = new Set([
  "administrator", "analyst", "architect", "associate", "aspiring", "backend", "business",
  "cloud", "customer", "data", "developer", "devops", "engineer", "executive", "finance",
  "front-end", "frontend", "full", "java", "junior", "lab", "lead", "machine", "manager",
  "marketing", "mobile", "network", "operations", "principal", "product", "python", "qa",
  "recruiter", "research", "sales", "senior", "software", "student", "support", "technical",
  "teacher", "trainer", "travel",
]);
const ORG_WORDS = new Set([
  "academy", "college", "company", "consultancy", "corporation", "education", "institute",
  "limited", "llc", "llp", "ltd", "pvt", "school", "solutions", "systems", "technologies",
  "university",
]);
const DEGREE_WORDS = new Set([
  "ba", "bba", "bca", "be", "b.e", "btech", "b.tech", "bsc", "b.sc", "diploma",
  "ma", "mba", "mca", "me", "m.e", "mtech", "m.tech", "msc", "m.sc", "phd",
]);
const NAME_TOKEN = /^\p{L}[\p{L}\p{N}_.'’-]*$/u;
const URL_OR_DIGIT = /https?:\/\/|\p{Nd}/iu;

export const NOT_SPECIFIED = "Not Specified";

const isCased = (ch: string): boolean => ch.toLowerCase() !== ch.toUpperCase();

/** Python `str.title()`: upper-case a letter that follows an uncased character, lower-case the rest. */
export function pyTitle(text: string): string {
  let out = "";
  let previousCased = false;
  for (const ch of text) {
    if (isCased(ch)) {
      out += previousCased ? ch.toLowerCase() : ch.toUpperCase();
      previousCased = true;
    } else {
      out += ch;
      previousCased = false;
    }
  }
  return out;
}

/** Python `str.isupper()`. */
function pyIsUpper(text: string): boolean {
  return text !== text.toLowerCase() && text === text.toUpperCase();
}

/** Python `str.splitlines()`. */
export function splitLines(text: string): string[] {
  const parts = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function stripChars(text: string, chars: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start]!)) start++;
  while (end > start && chars.includes(text[end - 1]!)) end--;
  return text.slice(start, end);
}

function rstripChars(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1]!)) end--;
  return text.slice(0, end);
}

/** Whether a parser result is a real candidate name rather than a placeholder. */
export function usableResumeName(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const name = String(value).replace(/\s+/g, " ").trim();
  if (!name || ["not specified", "n/a", "na", "none", "null", "unknown", "candidate"].includes(name.toLowerCase())) {
    return false;
  }
  if (name.includes("@") || URL_OR_DIGIT.test(name)) return false;
  return true;
}

/** Keep model names intact while making all-uppercase output readable. */
export function normaliseResumeNameValue(value: unknown): string {
  const name = String(value).replace(/\s+/g, " ").trim();
  return pyIsUpper(name) ? pyTitle(name) : name;
}

/** Turn a markdown/text extraction line into a simple candidate-name fragment. */
function normaliseNameLine(raw: unknown): string {
  let line = String(raw ?? "").normalize("NFKC").replace(/ /g, " ");
  line = line.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  line = line.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  line = line.replace(/^[#>*`~\-•▪●\s]+/, "");
  line = line.replace(/[*_`~]/g, "");
  line = line.replace(/\s+/g, " ").trim();
  return stripChars(line, " |•·:—–");
}

function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

/**
 * Find a conservative name candidate from the top of a résumé's text.
 *
 * Deliberately a fallback: only short, name-shaped lines near the top are considered; contact details,
 * headings, job titles and degree labels are rejected. Returns "Not Specified" when nothing qualifies.
 */
export function nameFromResumeText(text: string | null | undefined): string {
  if (!text) return NOT_SPECIFIED;
  for (const raw of splitLines(String(text)).slice(0, 60)) {
    const line = normaliseNameLine(raw);
    if (!line) continue;
    // A header often puts name, title and contact details on one line; only the first segment can be identity.
    const fragments = line
      .split(/\s*[|•·—–]\s*/)
      .map((part) => part.trim())
      .filter((part) => part);
    for (const fragment of fragments.slice(0, 1)) {
      let candidate = stripChars(fragment.replace(HONORIFICS, "").trim(), " ,:;-—–");
      // Name and job title run together after PDF-to-markdown conversion: keep the name-shaped prefix only.
      let tokens = words(candidate);
      const titleStart = tokens.findIndex((token) => TITLE_START_WORDS.has(rstripChars(casefold(token), ".,")));
      if (titleStart !== -1) candidate = tokens.slice(0, titleStart).join(" ");
      let lowered = casefold(candidate);
      if (SECTION_HEADINGS.has(lowered) || lowered.startsWith("name:") || lowered.startsWith("candidate:")) {
        candidate = candidate.replace(/^(?:name|candidate)\s*:\s*/i, "");
        lowered = casefold(candidate);
      }
      if (!candidate || SECTION_HEADINGS.has(lowered)) continue;
      if (candidate.includes("@") || URL_OR_DIGIT.test(candidate)) continue;
      tokens = words(candidate);
      if (!(tokens.length >= 1 && tokens.length <= 5)) continue;
      if (!tokens.every((token) => NAME_TOKEN.test(token))) continue;
      const tokenKeys = new Set(tokens.map((token) => rstripChars(casefold(token), ".")));
      if ([...tokenKeys].some((k) => DEGREE_WORDS.has(k))) continue;
      if ([...tokenKeys].some((k) => ROLE_WORDS.has(k) || ORG_WORDS.has(k))) continue;
      return tokens.map((token) => pyTitle(token)).join(" ");
    }
  }
  return NOT_SPECIFIED;
}
