const PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{8,}/g, "[redacted-key]"],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{32,}/g, "[redacted-token]"],
];

/** Scrub known secret values and token-shaped text from anything the CLI prints. */
export function redactText(text: unknown, secrets: Iterable<string | null | undefined> = []): string {
  let out = String(text ?? "");
  const known = [...secrets].filter((s): s is string => typeof s === "string" && s.length >= 6).sort((a, b) => b.length - a.length);
  for (const secret of known) out = out.split(secret).join("[redacted]");
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
