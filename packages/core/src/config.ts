/**
 * Configuration defaults. Values are identical to the reference DEFAULTS (the web edition's choices:
 * 3000 output tokens, 4 Drive workers, a fallback model from another vendor).
 */
import type { PipelineConfig } from "./types.js";

export const DEFAULTS: PipelineConfig = {
  llmBaseUrl: "https://openrouter.ai/api/v1",
  modelExtract: "openai/gpt-6-luna",
  modelFallback: "google/gemini-2.5-flash", // a different vendor: the fallback is skipped when it equals the primary
  modelVision: "google/gemini-2.5-flash", // a vision-capable model
  modelFallbackVision: "openai/gpt-6-luna",
  modelScoring: "openai/gpt-6-luna",
  maxConcurrency: 5,
  driveConcurrency: 4,
  jdFilterEnabled: false,
  jdDryRun: true,
  jdThreshold: 50,
  platforms: ["Unstop", "Indeed", "LinkedIn", "Naukri"],
  jdByRole: {},
  driveFolders: {},
  defaultCampaignType: "",
  extractAts: false,
  visionDpi: 150,
  maxOutputTokens: 3000,
  fallbackMaxOutputTokens: 4096,
  maxRetries: 2,
  promptMode: "compact",
  responseFormat: "json_schema",
  reasoningEffort: "none",
  visionReasoningEffort: "none",
  fallbackReasoningEffort: "low",
  fallbackVisionReasoningEffort: "low",
  requireParameters: true,
  allowFallbacks: true,
  dataCollection: "deny",
  zdr: false,
  providerOrder: [],
  sort: "",
  writeUsageLog: true,
  readTimeouts: [75, 100, 130, 160],
  visionReadTimeouts: [110, 140, 170, 200],
  connectTimeout: 10,
  cooldownSeconds: 60,
  zipMaxEntries: 500,
  zipMaxEntryMb: 50,
  zipMaxTotalMb: 500,
  zipMaxRatio: 100,
};

/** Defaults overlaid with the caller's settings (null or undefined means absent). */
export function resolveConfig(raw?: Record<string, unknown> | null): PipelineConfig {
  const cfg: Record<string, unknown> = { ...DEFAULTS };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value !== null && value !== undefined) cfg[key] = value;
  }
  return cfg as unknown as PipelineConfig;
}
