// Shapes of the JSON the intake server speaks (same as the original Python engine's routes) and the page's own state.

export type RunPhase = 'idle' | 'preparing' | 'parsing' | 'screening' | 'uploading' | 'done' | 'failed' | 'cancelled';
export type RunStatus = 'idle' | 'running' | 'cancelling' | 'done' | 'failed' | 'cancelled';

export interface HelloInfo {
  app: string;
  version: string;
  protocol?: number;
  dataDir?: string;
  commitConfigured?: boolean;
  auth?: 'none' | 'token' | 'signed';
}

export interface Cost {
  tokens: number;
  usd: number;
}

export type RunCounts = Record<string, number | null | undefined>;

export interface RunSummary {
  phase: string;
  finishedAt?: string;
  at?: string;
  rows?: number;
  counts?: RunCounts;
  cost?: Cost | null;
  failedFiles?: unknown[];
  detail?: string;
}

export type CommitStatus = 'unsupported' | 'idle' | 'running' | 'done' | 'failed';

/** What GET /state.commit reports. A server without the field does not commit at all. */
export interface CommitInfo {
  status: CommitStatus;
  configured: boolean;
  counts: Record<string, number>;
  lastError: string;
  tokenRejected: boolean;
}

export interface EngineInfo {
  version: string;
  phase: string;
  running?: boolean;
  queue?: { pdfs: number; zips: number; rosters: number };
  lastRun?: RunSummary | null;
  settingsLoaded?: boolean;
  google?: { ok: boolean; reason?: string };
  llm?: { ok: boolean };
  commit?: Partial<CommitInfo> | null;
  configError?: string | null;
  warnings?: string[];
  secretStore?: 'vault' | 'memory';
  /** Present when the server also lists its settings in /state. */
  config?: ServerConfig;
  secrets?: SettingsInfo['secrets'];
}

export interface InputFile {
  name: string;
  size: number;
  modified?: string;
  /** File names inside a zip; null when the zip could not be read, absent for a PDF. */
  entries?: string[] | null;
}

export type ResultRow = Record<string, string | number | boolean | null | undefined>;

export interface ResultsAnswer {
  available: boolean;
  summary: RunSummary | null;
  rows: ResultRow[];
  csvAvailable: boolean;
}

/** A campaign the rows can be committed to. Provided by the server settings (`config.campaigns`). */
export interface Campaign {
  id: number | string;
  name: string;
  group?: string;
  type?: string;
  driveFolderId?: string;
}

export interface ServerConfig {
  llmBaseUrl?: string | null;
  modelExtract?: string | null;
  modelFallback?: string | null;
  modelVision?: string | null;
  modelFallbackVision?: string | null;
  modelScoring?: string | null;
  dataCollection?: string | null;
  defaultCampaignType?: string | null;
  crmBaseUrl?: string | null;
  driveConcurrency?: number | null;
  jdThreshold?: number | null;
  visionDpi?: number | null;
  maxConcurrency?: number | null;
  jdFilterEnabled?: boolean;
  jdDryRun?: boolean;
  extractAts?: boolean;
  campaignTypes?: string[];
  platforms?: Array<string | { name?: string }>;
  campaigns?: Array<Partial<Campaign>>;
}

export interface SecretPresence {
  set: boolean;
  hint?: string;
}

/** GET /settings. Secret values never come back: only whether each is set and the last characters. */
export interface SettingsInfo {
  config: ServerConfig;
  secrets: Record<string, SecretPresence>;
  secretsReady?: boolean;
}

export interface SettingsBody {
  config?: Record<string, unknown>;
  secrets?: Record<string, string | null>;
}

export interface RunOptions {
  campaignType: string;
  platform: string;
  driveFolderId: string;
  parallel: number;
  dryRun: boolean;
  jdFilter: boolean;
  jdThreshold: number;
  jd?: string;
  inputs: string[];
  commit: { enabled: false } | { enabled: true; campaignId: number | string; source: string; stage: string };
}

export interface UploadAnswer {
  added?: string[];
  rejected?: Array<{ name: string; reason: string }>;
}

/** The events of GET /events, flattened: `{ type, ...data }` as the page receives them. */
export type EngineEvent =
  | { type: 'phase'; phase?: string; value?: string; cost?: Partial<Cost>; counts?: RunCounts; detail?: string }
  | { type: 'progress'; done?: number; total?: number; elapsed?: number; eta?: number | null }
  | { type: 'file'; name: string; status?: string; detail?: string }
  | { type: 'cost'; tokens?: number; usd?: number }
  | { type: 'log'; line?: string; message?: string; level?: string }
  | { type: 'notice'; code?: string; level?: string; message?: string }
  | { type: 'state' }
  | { type: 'commit_started' }
  | { type: 'commit_preflight'; ready?: number; duplicate?: number; conflict?: number; invalid?: number }
  | { type: 'commit_done'; created?: number; skipped?: number }
  | { type: 'commit_failed'; message?: string };

export interface FileProgress {
  status?: string;
  detail: string;
}

/** The live state of the current run, built from events. */
export interface RunState {
  status: RunStatus;
  phase: string;
  done: number;
  total: number;
  elapsed: number;
  eta: number | null;
  tokens: number;
  usd: number;
  log: string[];
  files: Record<string, FileProgress>;
  startedAt: number | null;
  commitLine: string;
}

export interface Notice {
  code: string;
  level: string;
  message: string;
}

export interface RunEnd {
  phase: string;
  counts: RunCounts;
  cost: Cost | null;
  detail: string;
  commit?: CommitInfo | null;
}

// ---- the upload queue ----

export type EntryStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type EntryState = EntryStatus | 'uploading';

export interface QueueFile {
  key: string;
  name: string;
  original: string;
  size: number;
  status: 'uploading' | 'ready' | 'error';
  progress?: number;
  error?: string;
}

export interface Counts {
  parsed: number;
  uploaded: number;
  reused: number;
  quarantined: number;
  uploadFailed: number;
  rows: number | null;
  files: number | null;
}

export interface Batch {
  id: string;
  status: EntryStatus;
  createdAt: number;
  source: string;
  campaignType: string;
  driveFolderId: string;
  folderName: string;
  jd: { on: boolean; text: string; threshold: number; dryRun: boolean };
  commit: { enabled: boolean; campaignId: number | string | null; campaignLabel: string };
  commitResult: CommitInfo | null;
  counts: Counts | null;
  cost: Cost | null;
  startedAt: number | null;
  finishedAt: number | null;
  error: string;
  /** Why some files were left out of the finished run (see problemLines). */
  problems?: string[];
  rows: ResultRow[];
  csv: string;
  files: QueueFile[];
}

/** One entry of the form's file list. `file` is absent for a file that already sits in the input folder. */
export interface FormFile {
  key: string;
  name: string;
  size: number;
  file?: File;
  resident?: boolean;
}

export interface SubmitForm {
  files: FormFile[];
  campaignType: string;
  source: string;
  driveFolderId: string;
  folderName: string;
  jd: { on: boolean; text: string; threshold: number; dryRun: boolean };
  commit: { enabled: boolean; campaignId: number | string | null; campaignLabel: string };
}

export type PauseReason = '' | 'restored' | 'cancelled' | 'engine';

/** One finished upload, kept in this browser for the History popup. */
export interface HistoryRecord {
  id: string;
  batchId: string;
  campaign: string;
  source: string;
  files: string;
  fileCount: number;
  status: string;
  resumes: number;
  uploaded: number;
  tokens: number;
  usd: number;
  startedAt: number | null;
  finishedAt: number;
}
