/**
 * Append-only parse-result cache.
 *
 * Each completed LLM result (extraction or JD score) is appended as one JSON line keyed by
 * sha256(file bytes) + kind + model + campaign type + prompt version. A rerun after a cancel or a
 * quota error reads the cache and makes no paid call for a file it already finished. A torn last
 * line (process killed mid-write) is skipped on load.
 */
import fs from "node:fs";
import path from "node:path";

// Bump when the extraction prompt, schema or normaliser changes meaning.
export const PROMPT_VERSION = "extract-compact-1";
export const SCORE_VERSION = "jd-score-1";

export function extractKey(
  sha256: string,
  primaryModel: string | null | undefined,
  fallbackModel: string | null | undefined,
  campaignType: string | null | undefined,
): string {
  return ["extract", sha256, primaryModel || "", fallbackModel || "", (campaignType || "").toUpperCase(), PROMPT_VERSION].join("|");
}

export function scoreKey(sha256: string, scoringModel: string | null | undefined, jdSha256: string): string {
  return ["score", sha256, scoringModel || "", jdSha256, SCORE_VERSION].join("|");
}

export class ParseCache {
  readonly path: string;
  private readonly data = new Map<string, unknown>();
  /** a torn last line has no newline; the next append must start on a fresh line */
  private needsNewline = false;

  constructor(file: string) {
    this.path = path.resolve(file);
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    if (fs.existsSync(this.path)) {
      const content = fs.readFileSync(this.path, "utf-8");
      this.needsNewline = content.length > 0 && !content.endsWith("\n");
      for (const rawLine of content.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as { key?: unknown; value?: unknown };
          if (entry && typeof entry === "object" && typeof entry.key === "string" && "value" in entry) {
            this.data.set(entry.key, entry.value);
          }
        } catch {
          continue; // torn or foreign line: ignore, never fail the run
        }
      }
    }
  }

  get<T = any>(key: string): T | null {
    const value = this.data.get(key);
    return value === undefined || value === null ? null : (JSON.parse(JSON.stringify(value)) as T);
  }

  put(key: string, value: unknown): void {
    if (this.data.has(key)) return;
    this.data.set(key, value);
    const line = JSON.stringify({ key, value });
    const fd = fs.openSync(this.path, "a");
    try {
      fs.writeSync(fd, (this.needsNewline ? "\n" : "") + line + "\n");
      this.needsNewline = false;
      try {
        fs.fsyncSync(fd);
      } catch {
        /* best effort */
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  get size(): number {
    return this.data.size;
  }
}
