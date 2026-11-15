/**
 * Error classes. Their `name` values equal the Python exception names because the pipeline puts the
 * name (never the message) into quarantine reasons and usage metadata, exactly as the original did.
 */

export interface LlmMeta {
  model?: string | null;
  attempts?: number;
  retries?: number;
  latency_seconds?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
  cached_tokens?: number;
  total_tokens?: number;
  cost?: number;
  generation_ids?: string[];
  request_ids?: string[];
  provider_names?: string[];
  [key: string]: unknown;
}

/** The run was cancelled cooperatively (checked between files and inside waits). */
export class Cancelled extends Error {
  override name = "Cancelled";
  constructor(message = "cancelled") {
    super(message);
  }
}

/** Provider daily/credit quota exhausted; will not recover until reset or top-up. */
export class DailyQuotaExceeded extends Error {
  override name = "DailyQuotaExceeded";
}

/** Bad input (Python ValueError). */
export class ValueError extends Error {
  override name = "ValueError";
  llmMeta?: LlmMeta;
}

/** A failed LLM request (Python RuntimeError carrying `_llm_meta`). */
export class RuntimeFailure extends Error {
  override name = "RuntimeError";
  llmMeta?: LlmMeta;
}

/** The Google token is missing, malformed or cannot be refreshed. */
export class DriveAuthError extends Error {
  override name = "DriveAuthError";
}

/** The whole archive breaks a limit and nothing is extracted from it. */
export class ZipRejected extends Error {
  override name = "ZipRejected";
}

export function errorName(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  return typeof error === "object" && error !== null ? "Error" : typeof error;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function llmMetaOf(error: unknown): LlmMeta {
  const meta = (error as { llmMeta?: LlmMeta } | null | undefined)?.llmMeta;
  return meta && typeof meta === "object" ? { ...meta } : {};
}
