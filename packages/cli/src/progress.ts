import type { FileStatus, Phase, PipelineEvent } from "./core.ts";

export type CommitStatus = "idle" | "running" | "done" | "failed";

export interface CommitState {
  status: CommitStatus;
  rows: number;
  ready: number;
  duplicate: number;
  conflict: number;
  invalid: number;
  created: number;
  skipped: number;
  batchId: number | null;
  idempotencyKey: string | null;
  error: string | null;
  dryRun: boolean;
}

/** Events the CLI adds to the pipeline's own: the sink steps, and the final result. */
export type CliEvent =
  | PipelineEvent
  | { type: "commit_started"; data: { campaignId: number; rows: number; dryRun?: boolean } }
  | { type: "commit_preflight"; data: { ready: number; duplicate: number; conflict: number; invalid: number } }
  | { type: "commit_done"; data: { created: number; skipped: number; batchId: number | null; idempotencyKey: string } }
  | { type: "commit_failed"; data: { stage: string; status: number | null; message: string } }
  | { type: "result"; data: { csvPath: string | null; rows: number; error: string | null; cancelled: boolean } };

export interface FileRow {
  name: string;
  status: FileStatus;
  detail: string;
}

export interface Failure {
  name: string;
  status: FileStatus;
  reason: string;
}

export interface ProgressState {
  phase: Phase | "idle";
  detail: string;
  stage: string;
  done: number;
  total: number;
  elapsed: number;
  eta: number | null;
  tokens: number;
  usd: number;
  files: FileRow[];
  counts: Partial<Record<FileStatus, number>>;
  failures: Failure[];
  logs: string[];
  commit: CommitState | null;
  finished: boolean;
  csvPath: string | null;
  resultRows: number;
  error: string | null;
  cancelled: boolean;
}

export const LOG_LIMIT = 8;
/** Statuses that count as a failed file in the summary. */
export const FAILURE_STATUSES: ReadonlySet<FileStatus> = new Set<FileStatus>(["skipped", "quarantined", "upload_failed"]);

export function initialState(): ProgressState {
  return {
    phase: "idle",
    detail: "",
    stage: "",
    done: 0,
    total: 0,
    elapsed: 0,
    eta: null,
    tokens: 0,
    usd: 0,
    files: [],
    counts: {},
    failures: [],
    logs: [],
    commit: null,
    finished: false,
    csvPath: null,
    resultRows: 0,
    error: null,
    cancelled: false,
  };
}

function emptyCommit(): CommitState {
  return { status: "idle", rows: 0, ready: 0, duplicate: 0, conflict: 0, invalid: 0, created: 0, skipped: 0, batchId: null, idempotencyKey: null, error: null, dryRun: false };
}

/** Pure reducer: the state after one more event. Never mutates its input. */
export function reduce(state: ProgressState, event: CliEvent): ProgressState {
  switch (event.type) {
    case "phase": {
      const { phase, detail, total } = event.data;
      const terminal = phase === "done" || phase === "failed" || phase === "cancelled";
      return {
        ...state,
        phase,
        detail: detail ?? "",
        total: typeof total === "number" ? total : state.total,
        cancelled: phase === "cancelled" ? true : state.cancelled,
        error: phase === "failed" ? (detail ?? "The run failed.") : state.error,
        finished: terminal ? true : state.finished,
      };
    }
    case "progress": {
      const { done, total, elapsed, eta, stage } = event.data;
      return { ...state, done, total, elapsed, eta, stage };
    }
    case "cost":
      return { ...state, tokens: event.data.tokens, usd: event.data.usd };
    case "log":
      return { ...state, logs: [...state.logs, event.data.message].slice(-LOG_LIMIT) };
    case "file": {
      const { name, status, detail } = event.data;
      const row: FileRow = { name, status, detail };
      const index = state.files.findIndex((f) => f.name === name);
      const files = index === -1 ? [...state.files, row] : state.files.map((f, i) => (i === index ? row : f));
      const counts: Partial<Record<FileStatus, number>> = {};
      for (const f of files) counts[f.status] = (counts[f.status] ?? 0) + 1;
      const failures = files.filter((f) => FAILURE_STATUSES.has(f.status)).map((f) => ({ name: f.name, status: f.status, reason: f.detail }));
      return { ...state, files, counts, failures };
    }
    case "commit_started":
      return { ...state, commit: { ...emptyCommit(), status: "running", rows: event.data.rows, dryRun: event.data.dryRun ?? false } };
    case "commit_preflight":
      return { ...state, commit: { ...(state.commit ?? emptyCommit()), ...event.data } };
    case "commit_done":
      return { ...state, commit: { ...(state.commit ?? emptyCommit()), status: "done", ...event.data, error: null } };
    case "commit_failed":
      return { ...state, commit: { ...(state.commit ?? emptyCommit()), status: "failed", error: event.data.message } };
    case "result":
      return {
        ...state,
        finished: true,
        csvPath: event.data.csvPath,
        resultRows: event.data.rows,
        error: event.data.error ?? state.error,
        cancelled: event.data.cancelled || state.cancelled,
      };
  }
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "--";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export function formatUsd(usd: number): string {
  if (usd === 0) return "$0.00";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function formatTokens(tokens: number): string {
  return tokens >= 10_000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

export function progressBar(done: number, total: number, width = 30): string {
  const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  const filled = Math.round(ratio * width);
  return `${"#".repeat(filled)}${"-".repeat(width - filled)} ${String(Math.round(ratio * 100)).padStart(3)}%`;
}

/** The exit code a finished state maps to: 130 cancelled, 1 failed, 3 partial (failed files or a failed commit), 0 clean. */
export function exitCodeFor(state: ProgressState): number {
  if (state.cancelled) return 130;
  if (state.error || state.phase === "failed") return 1;
  if (state.failures.length > 0 || state.commit?.status === "failed") return 3;
  return 0;
}

export class Store {
  private state: ProgressState = initialState();
  private listeners = new Set<() => void>();

  getState = (): ProgressState => this.state;

  dispatch = (event: CliEvent): void => {
    this.state = reduce(this.state, event);
    for (const listener of this.listeners) listener();
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}
