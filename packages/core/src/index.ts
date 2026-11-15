/**
 * @intake/core: the résumé intake pipeline. No server or UI code lives here.
 *
 * The contract with the server package: `runBatch(ctx)`, `RunContext`, `RunResult`, `resolveConfig(raw)`,
 * `DEFAULTS`, `redact(text, secrets)`, the `EventSink` type and the event union. Everything else exported
 * here is a building block (and what the tests exercise).
 */
export { runBatch, discover } from "./pipeline.js";
export { resolveConfig, DEFAULTS } from "./config.js";
export { redact, secretValues } from "./redact.js";
export type {
  RunContext,
  RunResult,
  RunOptions,
  RunSecrets,
  RunCost,
  FailedFile,
  ResultRow,
  PipelineConfig,
  WorkspaceDirs,
  EventSink,
  PipelineEvent,
  PipelineEventType,
  PhaseEventData,
  LogEventData,
  FileEventData,
  ProgressEventData,
  CostEventData,
  Phase,
  FileStatus,
  WireEvent,
  HttpClient,
  HttpRequest,
  HttpResponse,
  DriveClient,
  DriveFactory,
  DriveFile,
  DriveCreateRequest,
} from "./types.js";

// events, redaction registry
export {
  EventBus,
  Subscription,
  REPLAY_SIZE,
  SUBSCRIBER_BACKLOG,
  registerSecret,
  clearRegisteredSecrets,
  redactEvent,
  scrub,
} from "./events.js";

// offline providers (demo, tests)
export { createFakeLlm, type FakeLlm, type FakeLlmOptions } from "./fake-llm.js";
export { createFakeDrive, type FakeDrive } from "./fake-drive.js";

// building blocks
export { Cancelled, DailyQuotaExceeded, DriveAuthError, ZipRejected, ValueError, RuntimeFailure } from "./errors.js";
export { createGoogleDrive, loadCredentials, DriveUploader, DriveHttpError, driveErrorReason, DRIVE_SCOPE } from "./drive.js";
export { extractZip, DEFAULT_ZIP_LIMITS, type ZipLimits, type ZipResult, type ExtractedFile } from "./zips.js";
export { ParseCache, extractKey, scoreKey, PROMPT_VERSION, SCORE_VERSION } from "./cache.js";
export {
  leadId,
  phoneKey,
  normalizePhoneE164,
  rowsToCsvText,
  writeBatchCsv,
  writeRetryList,
  appendDatabaseIndex,
  atomicWriteText,
  MAX_CSV_FILES,
} from "./csvout.js";
export { nameFromResumeText, normaliseResumeNameValue, usableResumeName, NOT_SPECIFIED } from "./names.js";
export { CancelFlag, RateGate, TaskPool } from "./concurrency.js";
export * as llm from "./llm.js";
export * as jd from "./jd.js";
export * as parse from "./parse.js";
