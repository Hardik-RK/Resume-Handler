import { beforeEach, describe, expect, it } from 'vitest';
import { HISTORY_LIMIT, addHistory, dayKey, readHistory, recordFor, summariseCosts, writeHistory } from '../src/history';
import type { Batch, HistoryRecord } from '../src/lib/types';

const NOW = new Date('2026-03-15T12:00:00').getTime();
const DAY = 86400000;
const rec = (over: Partial<HistoryRecord>): HistoryRecord => ({
  id: String(Math.random()), batchId: 'b', campaign: 'Camp A', source: 'LinkedIn', files: 'a.zip', fileCount: 1, status: 'done', resumes: 10, uploaded: 10,
  tokens: 100, usd: 1, startedAt: NOW, finishedAt: NOW, ...over,
});

describe('history store', () => {
  beforeEach(() => window.localStorage.clear());
  it('round-trips records and caps the list', () => {
    expect(readHistory()).toEqual([]);
    writeHistory(Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) => rec({ id: `r${i}` })));
    expect(readHistory()).toHaveLength(HISTORY_LIMIT);
    expect(readHistory()[0].id).toBe('r5');
    expect(addHistory(rec({ id: 'last' })).at(-1)?.id).toBe('last');
  });
  it('ignores garbage in storage', () => {
    window.localStorage.setItem('resume-intake-history-v1', '{"x":1}');
    expect(readHistory()).toEqual([]);
    window.localStorage.setItem('resume-intake-history-v1', '[null,{"id":"a","finishedAt":5}]');
    expect(readHistory()).toHaveLength(1);
  });
});

describe('recordFor', () => {
  const batch = { id: 'b9', source: 'Indeed', folderName: 'Folder', commit: { enabled: true, campaignId: 1, campaignLabel: 'Acme — Camp' }, startedAt: 7, files: [{ original: 'x.zip', name: 'x.zip' }, { original: '', name: 'y.pdf' }] } as unknown as Batch;
  it('labels the files and takes the run cost and counts', () => {
    const r = recordFor(batch, { phase: 'done', counts: { parsed: 4, uploaded: 3 }, cost: { tokens: 50, usd: 0.25 }, detail: '' }, { tokens: 1, usd: 1 }, 1000);
    expect(r).toMatchObject({ batchId: 'b9', campaign: 'Acme — Camp', source: 'Indeed', files: 'x.zip +1', fileCount: 2, status: 'done', resumes: 4, uploaded: 3, tokens: 50, usd: 0.25, startedAt: 7, finishedAt: 1000 });
  });
  it('falls back to the live cost', () => {
    const r = recordFor(batch, { phase: 'cancelled', counts: {}, cost: null, detail: '' }, { tokens: 9, usd: 0.5 }, 1000);
    expect(r).toMatchObject({ tokens: 9, usd: 0.5, status: 'cancelled' });
  });
});

describe('summariseCosts', () => {
  const list = [
    rec({ usd: 1, resumes: 10, finishedAt: NOW }),
    rec({ usd: 2, resumes: 20, finishedAt: NOW - 3 * DAY, campaign: 'Camp B', source: 'Indeed' }),
    rec({ usd: 4, resumes: 5, finishedAt: NOW - 20 * DAY }),
    rec({ usd: 8, resumes: 1, finishedAt: NOW - 90 * DAY }),
  ];
  it('sums today, the week, the month and all time', () => {
    const c = summariseCosts(list, NOW);
    expect(c.today).toEqual({ usd: 1, runs: 1, resumes: 10 });
    expect(c.week).toEqual({ usd: 3, runs: 2, resumes: 30 });
    expect(c.month).toEqual({ usd: 7, runs: 3, resumes: 35 });
    expect(c.allTime).toEqual({ usd: 15, runs: 4, resumes: 36 });
  });
  it('splits the month by campaign and source, biggest first', () => {
    const c = summariseCosts(list, NOW);
    expect(c.byCampaign.map((r) => [r.name, r.usd])).toEqual([['Camp A', 5], ['Camp B', 2]]);
    expect(c.bySource.map((r) => r.name)).toEqual(['LinkedIn', 'Indeed']);
  });
  it('lists the spend per local day', () => {
    const c = summariseCosts(list, NOW);
    expect(c.byDay.find((d) => d.day === dayKey(new Date(NOW)))).toEqual({ day: dayKey(new Date(NOW)), usd: 1, runs: 1 });
  });
});
