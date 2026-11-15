// The pure part of the engine hook: what each server event does to the live run, and how the commit state is read.
import type { CommitInfo, EngineEvent, RunState } from './lib/types';

export const RUNNING = new Set(['preparing', 'parsing', 'screening', 'uploading']);
export const TERMINAL = new Set(['done', 'failed', 'cancelled']);
export const LOG_LIMIT = 200;

export const EMPTY_RUN: RunState = {
  status: 'idle', phase: '', done: 0, total: 0, elapsed: 0, eta: null, tokens: 0, usd: 0, log: [], files: {}, startedAt: null, commitLine: '',
};

export const num = (value: unknown): number => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** The commit state the server reports (GET /state.commit). A server without the field does not commit at all. */
export function normaliseCommit(commit: unknown): CommitInfo {
  if (!commit || typeof commit !== 'object') return { status: 'unsupported', configured: false, counts: {}, lastError: '', tokenRejected: false };
  const c = commit as Record<string, unknown>;
  return {
    status: typeof c.status === 'string' ? (c.status as CommitInfo['status']) : 'idle',
    configured: Boolean(c.configured),
    counts: c.counts && typeof c.counts === 'object' ? (c.counts as Record<string, number>) : {},
    lastError: typeof c.lastError === 'string' ? c.lastError : '',
    tokenRejected: Boolean(c.tokenRejected),
  };
}

/** The one-line live status of a commit event. Server messages never echo row data. */
export function commitLineFor(event: EngineEvent): string {
  switch (event.type) {
    case 'commit_started': return 'Adding the rows to the campaign';
    case 'commit_preflight': return `Checked: ${num(event.ready)} new, ${num(event.duplicate)} duplicate, ${num(event.conflict)} conflict, ${num(event.invalid)} invalid`;
    case 'commit_done': return `Added ${num(event.created)} to the campaign, ${num(event.skipped)} skipped`;
    case 'commit_failed': return `Commit failed${event.message ? `: ${String(event.message).slice(0, 200)}` : ''}`;
    default: return '';
  }
}

/** Applies one event to the live run. Events that do not change the run return the same object. */
export function reduceRun(run: RunState, event: EngineEvent, now: number = Date.now()): RunState {
  switch (event.type) {
    case 'phase': {
      const phase = event.phase ?? event.value ?? '';
      const terminal = TERMINAL.has(phase);
      return {
        ...run,
        phase,
        status: terminal ? (phase as RunState['status']) : (run.status === 'cancelling' ? 'cancelling' : 'running'),
        startedAt: run.startedAt ?? now,
        ...(event.cost ? { tokens: num(event.cost.tokens), usd: num(event.cost.usd) } : {}),
      };
    }
    case 'progress':
      return { ...run, done: num(event.done), total: num(event.total), elapsed: num(event.elapsed), eta: event.eta ?? null };
    case 'file':
      return { ...run, files: { ...run.files, [event.name]: { status: event.status, detail: event.detail || '' } } };
    case 'cost':
      return { ...run, tokens: num(event.tokens), usd: num(event.usd) };
    case 'log':
      return { ...run, log: [...run.log, String(event.line ?? event.message ?? '')].slice(-LOG_LIMIT) };
    case 'commit_started':
    case 'commit_preflight':
    case 'commit_done':
    case 'commit_failed':
      return { ...run, commitLine: commitLineFor(event) };
    default:
      return run;
  }
}
