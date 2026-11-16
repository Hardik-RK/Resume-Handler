import { describe, expect, it } from 'vitest';
import { EMPTY_RUN, LOG_LIMIT, LOST_RUN_TICKS, commitLineFor, engineLostRun, normaliseCommit, copyProblemLine, plainReason, problemLines, reduceRun } from '../src/run-state';
import type { EngineEvent, RunState } from '../src/lib/types';

const NOW = 1_700_000_000_000;
const apply = (run: RunState, ...events: EngineEvent[]): RunState => events.reduce((r, e) => reduceRun(r, e, NOW), run);

describe('normaliseCommit', () => {
  it('reports a server without the field as unsupported', () => {
    expect(normaliseCommit(undefined)).toEqual({ status: 'unsupported', configured: false, counts: {}, lastError: '', tokenRejected: false });
    expect(normaliseCommit('x').status).toBe('unsupported');
  });
  it('reads a commit object and defaults what is missing', () => {
    expect(normaliseCommit({ status: 'failed', configured: 1, lastError: 'boom', tokenRejected: true, counts: { created: 2 } })).toEqual({
      status: 'failed', configured: true, counts: { created: 2 }, lastError: 'boom', tokenRejected: true,
    });
    expect(normaliseCommit({})).toMatchObject({ status: 'idle', configured: false, counts: {}, lastError: '' });
  });
});

describe('commitLineFor', () => {
  it('words each commit event without echoing row data', () => {
    expect(commitLineFor({ type: 'commit_started' })).toBe('Adding the rows to the campaign');
    expect(commitLineFor({ type: 'commit_preflight', ready: 3, duplicate: 1 })).toBe('Checked: 3 new, 1 duplicate, 0 conflict, 0 invalid');
    expect(commitLineFor({ type: 'commit_done', created: 4, skipped: 1 })).toBe('Added 4 to the campaign, 1 skipped');
    expect(commitLineFor({ type: 'commit_failed', message: 'x'.repeat(300) })).toBe(`Commit failed: ${'x'.repeat(200)}`);
    expect(commitLineFor({ type: 'commit_failed' })).toBe('Commit failed');
    expect(commitLineFor({ type: 'state' })).toBe('');
  });
});

describe('reduceRun', () => {
  it('moves to running on a phase event and keeps the first start time', () => {
    const a = apply(EMPTY_RUN, { type: 'phase', phase: 'parsing' });
    expect(a).toMatchObject({ status: 'running', phase: 'parsing', startedAt: NOW });
    const b = reduceRun(a, { type: 'phase', phase: 'uploading' }, NOW + 5000);
    expect(b.startedAt).toBe(NOW);
  });
  it('ends on a terminal phase and takes the cost it carries', () => {
    const r = apply({ ...EMPTY_RUN, status: 'running' }, { type: 'phase', phase: 'done', cost: { tokens: 100, usd: 0.02 } });
    expect(r).toMatchObject({ status: 'done', phase: 'done', tokens: 100, usd: 0.02 });
  });
  it('stays cancelling while a non-terminal phase arrives, then ends cancelled', () => {
    const cancelling: RunState = { ...EMPTY_RUN, status: 'cancelling', startedAt: NOW };
    expect(reduceRun(cancelling, { type: 'phase', phase: 'parsing' }).status).toBe('cancelling');
    expect(reduceRun(cancelling, { type: 'phase', phase: 'cancelled' }).status).toBe('cancelled');
  });
  it('accepts the older `value` field for the phase', () => {
    expect(apply(EMPTY_RUN, { type: 'phase', value: 'screening' }).phase).toBe('screening');
  });
  it('tracks progress, file status, cost and log (capped)', () => {
    let r = apply(EMPTY_RUN, { type: 'progress', done: 2, total: 5, elapsed: 3, eta: 9 }, { type: 'file', name: 'a.pdf', status: 'done' }, { type: 'cost', tokens: 10, usd: 0.5 });
    expect(r).toMatchObject({ done: 2, total: 5, elapsed: 3, eta: 9, tokens: 10, usd: 0.5 });
    expect(r.files['a.pdf']).toEqual({ status: 'done', detail: '' });
    for (let i = 0; i < LOG_LIMIT + 20; i += 1) r = reduceRun(r, { type: 'log', message: `line ${i}` });
    expect(r.log).toHaveLength(LOG_LIMIT);
    expect(r.log[r.log.length - 1]).toBe(`line ${LOG_LIMIT + 19}`);
  });
  it('treats garbage numbers as zero', () => {
    expect(apply(EMPTY_RUN, { type: 'progress', done: Number.NaN, total: undefined })).toMatchObject({ done: 0, total: 0, eta: null });
  });
  it('writes the live commit line', () => {
    expect(apply(EMPTY_RUN, { type: 'commit_done', created: 2, skipped: 0 }).commitLine).toBe('Added 2 to the campaign, 0 skipped');
  });
  it('returns the same object for events that do not change the run', () => {
    expect(reduceRun(EMPTY_RUN, { type: 'state' })).toBe(EMPTY_RUN);
    expect(reduceRun(EMPTY_RUN, { type: 'notice', code: 'x' })).toBe(EMPTY_RUN);
  });
});

describe('engineLostRun', () => {
  it('is true when the engine is idle and never finished the run (it restarted mid-run)', () => {
    expect(engineLostRun({ phase: 'idle' }, false)).toBe(true);
    expect(engineLostRun({ phase: '' }, false)).toBe(true);
    expect(LOST_RUN_TICKS).toBeGreaterThanOrEqual(2); // one idle poll between phases must not end a run
  });
  it('is false while the engine runs, once the run finished, and when the engine does not answer', () => {
    expect(engineLostRun({ phase: 'parsing' }, false)).toBe(false);
    expect(engineLostRun({ phase: 'uploading' }, false)).toBe(false);
    expect(engineLostRun({ phase: 'idle' }, true)).toBe(false);
    expect(engineLostRun(null, false)).toBe(false);
  });
});

describe('copyProblemLine', () => {
  it('names the file the server refused and why', () => {
    expect(copyProblemLine('big.pdf', 'A file is larger than 25 MB.')).toBe('big.pdf was not copied to the server: A file is larger than 25 MB.');
    expect(copyProblemLine('x.pdf', '')).toBe('x.pdf was not copied to the server: it was refused');
  });
});

describe('problemLines', () => {
  it('says why files were left out, grouped, most common first', () => {
    const files = {
      'a.pdf': { status: 'quarantined', detail: 'RuntimeError: HTTP 401' },
      'b.pdf': { status: 'quarantined', detail: 'RuntimeError: HTTP 401' },
      'c.pdf': { status: 'quarantined', detail: 'ValueError: no extractable text and could not render page image (corrupt PDF?)' },
      'd.pdf': { status: 'parsed', detail: '' },
    };
    expect(problemLines(files)).toEqual([
      '2 files: the model provider refused the key (HTTP 401): check the model key in Settings',
      '1 file: an empty, damaged or password-protected PDF',
    ]);
    expect(problemLines({})).toEqual([]);
    expect(problemLines(undefined)).toEqual([]);
  });
  it('shortens an unknown reason and strips the exception class', () => {
    expect(plainReason('RuntimeError: boom')).toBe('boom');
    expect(plainReason('x'.repeat(300)).length).toBe(120);
    expect(plainReason('')).toBe('');
  });
});
