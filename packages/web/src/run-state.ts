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

/** Polls in a row that find the engine idle, with no finished run, before the page gives up on a run it started. */
export const LOST_RUN_TICKS = 3;

/**
 * True when the engine answers but is idle and has no finished run since this page started one: it was stopped and started
 * again (or crashed) mid-run, so no end event will ever come. `finished` says a terminal run newer than the start exists.
 */
export function engineLostRun(info: { phase?: string } | null | undefined, finished: boolean): boolean {
  return Boolean(info) && !finished && !RUNNING.has(String(info?.phase ?? ''));
}

/** A server reason for a file the run could not read, in words a recruiter can act on. Never includes file content. */
export function plainReason(detail: string): string {
  const d = String(detail || '').replace(/^[A-Za-z]*(Error|Exception):\s*/, '').trim();
  if (/HTTP 40[13]/.test(d)) return 'the model provider refused the key (HTTP ' + (/40[13]/.exec(d)?.[0] ?? '401') + '): check the model key in Settings';
  if (/HTTP 429/.test(d)) return 'the model provider is rate limiting: lower "Your parallel requests" in Settings';
  if (/not JSON/i.test(d)) return 'the model gave an answer that could not be read';
  if (/no extractable text and could not render/i.test(d)) return 'an empty, damaged or password-protected PDF';
  return d.length > 120 ? `${d.slice(0, 117)}...` : d;
}

/** Why files were left out of a finished run: "3 files: <reason>" lines, most common first, at most three. */
export function problemLines(files: Record<string, { status?: string; detail?: string }> | null | undefined): string[] {
  const counts = new Map<string, number>();
  for (const f of Object.values(files || {})) {
    if (f.status !== 'quarantined' && f.status !== 'skipped') continue;
    const why = plainReason(f.detail ?? '') || 'could not be read';
    counts.set(why, (counts.get(why) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([why, n]) => `${n} file${n === 1 ? '' : 's'}: ${why}`);
}
