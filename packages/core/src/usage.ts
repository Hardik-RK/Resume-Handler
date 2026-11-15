/** PII-free usage log: totals per run and one line per paid request (port of `_write_usage` and `_metric`). */
import fs from "node:fs";
import path from "node:path";
import type { LlmMeta } from "./errors.js";

export interface RunUsageSummary {
  requests: number;
  cost: number;
  total_tokens: number;
  rate_limit_trips: number;
}

export interface UsageMetric {
  kind: string;
  source_id: string;
  model: unknown;
  attempts: unknown;
  retries: unknown;
  prompt_tokens: unknown;
  completion_tokens: unknown;
  reasoning_tokens: unknown;
  cached_tokens: unknown;
  total_tokens: unknown;
  cost: unknown;
  generation_ids: unknown[];
  request_ids: unknown[];
  fallback_used: boolean;
  vision: boolean;
  error: string | null;
}

export function metric(sourceSha: string, meta: LlmMeta, kind: string, error: string | null = null): UsageMetric {
  return {
    kind,
    source_id: sourceSha.slice(0, 16),
    model: meta.model ?? null,
    attempts: meta.attempts ?? null,
    retries: meta.retries ?? null,
    prompt_tokens: meta.prompt_tokens ?? null,
    completion_tokens: meta.completion_tokens ?? null,
    reasoning_tokens: meta.reasoning_tokens ?? null,
    cached_tokens: meta.cached_tokens ?? null,
    total_tokens: meta.total_tokens ?? null,
    cost: meta.cost ?? null,
    generation_ids: meta.generation_ids?.length ? meta.generation_ids : [],
    request_ids: meta.request_ids?.length ? meta.request_ids : [],
    fallback_used: Boolean(meta["fallback_used"]),
    vision: Boolean(meta["vision"]),
    error,
  };
}

/** `datetime.now().isoformat(timespec="seconds")` (local time, no offset). */
export function isoSeconds(date: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/** Append usage records to output/llm_usage.jsonl (one per run) and llm_usage_requests.jsonl (one per request). */
export function writeUsage(outputDir: string, runId: string, summary: RunUsageSummary, metrics: UsageMetric[]): void {
  fs.mkdirSync(outputDir, { recursive: true });
  const stamp = isoSeconds();
  fs.appendFileSync(
    path.join(outputDir, "llm_usage.jsonl"),
    JSON.stringify({ event: "run", timestamp: stamp, run_id: runId, ...summary }) + "\n",
    "utf-8",
  );
  if (metrics.length > 0) {
    const lines = metrics.map((m) => JSON.stringify({ event: "request", timestamp: stamp, run_id: runId, ...m }) + "\n");
    fs.appendFileSync(path.join(outputDir, "llm_usage_requests.jsonl"), lines.join(""), "utf-8");
  }
}
