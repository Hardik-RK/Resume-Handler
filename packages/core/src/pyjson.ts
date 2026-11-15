/** Small helpers that reproduce Python behaviour the CSV/identity output depends on. */

/** Python `json.dumps(value, ensure_ascii=False)`: separators ", " and ": ". */
export function pyJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(pyJsonDumps).join(", ") + "]";
  if (typeof value === "object") {
    const items = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${JSON.stringify(k)}: ${pyJsonDumps(v)}`);
    return "{" + items.join(", ") + "}";
  }
  return JSON.stringify(String(value));
}

/** Python `re.sub(r"\D", "", s)`: keeps every Unicode decimal digit, like Python's `\d`. */
export function digitsOnly(value: unknown): string {
  return String(value ?? "").replace(/\P{Nd}/gu, "");
}

/** Python `str(value or "")`. */
export function strOrEmpty(value: unknown): string {
  return value ? String(value) : "";
}

/** Python `str.strip()` (Unicode whitespace). */
export function pyStrip(value: string): string {
  return value.replace(/^[\s\u001c-\u001f\u0085]+|[\s\u001c-\u001f\u0085]+$/g, "");
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `datetime.now().strftime(...)` for the two formats the pipeline uses (local time). */
export function localStamp(kind: "file" | "minute", date: Date = new Date()): string {
  const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  if (kind === "minute") return `${day} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return `${day}_${pad2(date.getHours())}-${pad2(date.getMinutes())}-${pad2(date.getSeconds())}`;
}
