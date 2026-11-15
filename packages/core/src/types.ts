/**
 * Public types of @intake/core. The server codes against these.
 *
 * `RunContext` mirrors the Python `RunContext` dataclass that engine/server.py builds
 * (dirs, config, secrets, options, emit, cancelled, http, drive) with camelCase names; `RunResult` mirrors the
 * Python `RunResult` dataclass. Event payloads are the same JSON objects the Python emitter produced.
 */

// ── configuration ─────────────────────────────────────────────────────────────

/** The settings the pipeline reads (camelCase). Anything absent or null takes the value in DEFAULTS. */
export interface PipelineConfig {
  llmBaseUrl: string;
  modelExtract: string;
  modelFallback: string;
  modelVision: string;
  modelFallbackVision: string;
  modelScoring: string;
  maxConcurrency: number;
  driveConcurrency: number;
  jdFilterEnabled: boolean;
  jdDryRun: boolean;
  jdThreshold: number;
  platforms: string[];
  /** job descriptions keyed by campaign type (upper case) */
  jdByRole: Record<string, string>;
  /** `{ TECH: "folderId" }` or `[{ name: "Tech", id: "folderId" }]` */
  driveFolders: Record<string, string> | Array<{ name?: string; id?: string }>;
  defaultCampaignType: string;
  extractAts: boolean;
  visionDpi: number;
  maxOutputTokens: number;
  fallbackMaxOutputTokens: number;
  maxRetries: number;
  promptMode: string;
  responseFormat: string;
  reasoningEffort: string;
  visionReasoningEffort: string;
  fallbackReasoningEffort: string;
  fallbackVisionReasoningEffort: string;
  requireParameters: boolean;
  allowFallbacks: boolean;
  dataCollection: string;
  zdr: boolean;
  providerOrder: string[];
  sort: string;
  writeUsageLog: boolean;
  readTimeouts: number[];
  visionReadTimeouts: number[];
  connectTimeout: number;
  cooldownSeconds: number;
  zipMaxEntries: number;
  zipMaxEntryMb: number;
  zipMaxTotalMb: number;
  zipMaxRatio: number;
}

/** Secrets the pipeline reads. They are never logged or put in events. */
export interface RunSecrets {
  openrouterApiKey?: string;
  /** Google user token JSON (string or already parsed) with a refresh token */
  googleTokenJson?: string | Record<string, unknown>;
  googleClientSecrets?: string | Record<string, unknown>;
  [key: string]: unknown;
}

/** Per-run options (what POST /run validates). */
export interface RunOptions {
  campaignType?: string;
  platform?: string;
  jd?: string;
  parallel?: number;
  dryRun?: boolean;
  jdFilter?: boolean;
  jdThreshold?: number;
  driveFolderId?: string;
  /** limit the run to these input file names (or relative posix paths) */
  inputs?: string[];
  /** opaque to the pipeline; the server's sink reads it */
  commit?: unknown;
  [key: string]: unknown;
}

export interface WorkspaceDirs {
  input: string;
  output: string;
  old: string;
  database: string;
  logs: string;
  /** parse-cache folder; when absent a per-user default folder is used */
  cache?: string;
}

// ── events ────────────────────────────────────────────────────────────────────

export type Phase = "preparing" | "parsing" | "screening" | "uploading" | "done" | "failed" | "cancelled";

export type FileStatus =
  | "skipped"
  | "quarantined"
  | "rejected"
  | "scored"
  | "parsed"
  | "uploaded"
  | "upload_failed"
  | "duplicate";

export interface PhaseEventData {
  phase: Phase;
  detail?: string;
  total?: number;
  [key: string]: unknown;
}
export interface LogEventData {
  message: string;
  level?: string;
}
export interface FileEventData {
  name: string;
  status: FileStatus;
  detail: string;
}
export interface ProgressEventData {
  done: number;
  total: number;
  elapsed: number;
  eta: number | null;
  stage: string;
}
export interface CostEventData {
  tokens: number;
  usd: number;
}

/** What the pipeline hands to `ctx.emit`: the event type and its payload (the wire `data`). */
export type PipelineEvent =
  | { type: "phase"; data: PhaseEventData }
  | { type: "log"; data: LogEventData }
  | { type: "file"; data: FileEventData }
  | { type: "progress"; data: ProgressEventData }
  | { type: "cost"; data: CostEventData };

export type PipelineEventType = PipelineEvent["type"];

/** The envelope the SSE stream carries: `{id, type, ts, data}`; id and ts are added by the event bus. */
export interface WireEvent<T extends string = string, D = Record<string, unknown>> {
  id: number;
  type: T;
  ts: number;
  data: D;
}

/** Receives pipeline events. Exceptions thrown by the sink are swallowed (as the Python emitter did). */
export type EventSink = (event: PipelineEvent) => void;

// ── injectable collaborators ─────────────────────────────────────────────────

export interface HttpRequest {
  headers: Record<string, string>;
  /** JSON-serialisable body */
  body: unknown;
  /** per-attempt read timeout, milliseconds */
  timeoutMs: number;
  connectTimeoutMs: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/**
 * POST transport for the LLM calls. The default uses `fetch`; tests and the demo inject
 * `createFakeLlm()` (deterministic, offline). A timeout rejects with an error whose `name` is
 * `TimeoutError`; any other rejection is treated as a connection failure.
 */
export interface HttpClient {
  post(url: string, request: HttpRequest): Promise<HttpResponse>;
}

export interface DriveFile {
  id: string;
  name?: string;
  webViewLink?: string | null;
  appProperties?: Record<string, string>;
}

export interface DriveCreateRequest {
  name: string;
  parents: string[];
  appProperties: Record<string, string>;
  /** local file with the bytes to upload */
  path: string;
  mimeType: string;
}

/**
 * The slice of Google Drive v3 the uploader needs. `createGoogleDrive()` implements it over REST;
 * `createFakeDrive()` is the in-memory stand-in. Errors carry an HTTP `status` when there is one.
 */
export interface DriveClient {
  listFolder(folderId: string, pageToken?: string): Promise<{ files: DriveFile[]; nextPageToken?: string | null }>;
  createFile(request: DriveCreateRequest): Promise<DriveFile>;
}

export type DriveFactory = DriveClient | (() => DriveClient);

// ── run context and result ───────────────────────────────────────────────────

export interface RunContext {
  dirs: WorkspaceDirs;
  /** raw settings; resolveConfig() overlays them on DEFAULTS */
  config: Partial<PipelineConfig> & Record<string, unknown>;
  secrets: RunSecrets;
  options: RunOptions;
  emit: EventSink;
  /** aborted when the operator cancels the run */
  cancelled: AbortSignal;
  /** LLM transport override (tests, demo) */
  http?: HttpClient;
  /** Drive override (tests, demo). When absent the Google token in `secrets` is used. */
  drive?: DriveFactory;
  /** field definitions (only used by the `legacy` prompt mode) */
  fields?: Array<Record<string, unknown>>;
}

export interface FailedFile {
  name: string;
  reason: string;
}

export interface RunCost {
  tokens: number;
  usd: number;
}

/** One output row: the CSV columns in order, plus any role-specific extras. */
export type ResultRow = Record<string, unknown>;

export interface RunResult {
  rows: ResultRow[];
  csvPath: string | null;
  counts: Record<string, number>;
  cost: RunCost;
  failedFiles: FailedFile[];
  cancelled: boolean;
  error: string | null;
  retryPath: string | null;
  runId: string;
  /** the input files this run read (the server moves them after success) */
  processed: string[];
}
