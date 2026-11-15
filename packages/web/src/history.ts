// Upload history, kept in this browser: one record per finished upload. The History popup reads it and sums the spend.
import type { Batch, HistoryRecord, RunEnd } from './lib/types';
import { normaliseCounts } from './queue-logic';

const KEY = 'resume-intake-history-v1';
export const HISTORY_LIMIT = 200;
const DAY = 86400000;

export function readHistory(): HistoryRecord[] {
  try {
    const list: unknown = JSON.parse(window.localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? (list as HistoryRecord[]).filter((r) => r && r.id && Number.isFinite(Number(r.finishedAt))) : [];
  } catch { return []; }
}

export function writeHistory(list: HistoryRecord[]): boolean {
  try { window.localStorage.setItem(KEY, JSON.stringify(list.slice(-HISTORY_LIMIT))); return true; } catch { return false; }
}

/** The record of a finished entry (the run's own counts and cost, else the live figures). */
export function recordFor(batch: Batch, end: RunEnd, live: { tokens: number; usd: number }, finishedAt: number = Date.now()): HistoryRecord {
  const cost = end.cost || { tokens: live.tokens, usd: live.usd };
  const counts = normaliseCounts(end.counts);
  const names = batch.files.map((f) => f.original || f.name);
  return {
    id: `${batch.id}-${finishedAt.toString(36)}`,
    batchId: batch.id,
    campaign: batch.commit?.campaignLabel || batch.folderName || '',
    source: batch.source,
    files: names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0] || '',
    fileCount: names.length,
    status: end.phase,
    resumes: counts.parsed,
    uploaded: counts.uploaded,
    tokens: Number(cost.tokens) || 0,
    usd: Number(cost.usd) || 0,
    startedAt: batch.startedAt,
    finishedAt,
  };
}

export function addHistory(record: HistoryRecord): HistoryRecord[] {
  const list = [...readHistory(), record];
  writeHistory(list);
  return list.slice(-HISTORY_LIMIT);
}

// ── spend ──────────────────────────────────────────────────────────────────────────────────────────────────
export interface Period { usd: number; runs: number; resumes: number }
export interface DayRow { day: string; usd: number; runs: number }
export interface SplitRow { name: string; usd: number; runs: number; resumes: number }
export interface Costs {
  today: Period; week: Period; month: Period; allTime: Period;
  byDay: DayRow[]; byCampaign: SplitRow[]; bySource: SplitRow[];
}

/** YYYY-MM-DD in the viewer's own time zone. */
export const dayKey = (d: Date): string => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

const sum = (records: HistoryRecord[]): Period => ({
  usd: records.reduce((s, r) => s + (r.usd || 0), 0), runs: records.length, resumes: records.reduce((s, r) => s + (r.resumes || 0), 0),
});

function split(records: HistoryRecord[], pick: (r: HistoryRecord) => string): SplitRow[] {
  const map = new Map<string, SplitRow>();
  for (const r of records) {
    const name = pick(r);
    const row = map.get(name) || { name, usd: 0, runs: 0, resumes: 0 };
    row.usd += r.usd || 0; row.runs += 1; row.resumes += r.resumes || 0;
    map.set(name, row);
  }
  return [...map.values()].sort((a, b) => b.usd - a.usd || b.runs - a.runs);
}

export function summariseCosts(records: HistoryRecord[], now: number = Date.now()): Costs {
  const today = dayKey(new Date(now));
  const within = (days: number) => records.filter((r) => now - r.finishedAt < days * DAY);
  const month = within(30);
  const days = new Map<string, DayRow>();
  for (const r of records) {
    const day = dayKey(new Date(r.finishedAt));
    const row = days.get(day) || { day, usd: 0, runs: 0 };
    row.usd += r.usd || 0; row.runs += 1;
    days.set(day, row);
  }
  return {
    today: sum(records.filter((r) => dayKey(new Date(r.finishedAt)) === today)),
    week: sum(within(7)),
    month: sum(month),
    allTime: sum(records),
    byDay: [...days.values()],
    byCampaign: split(month, (r) => r.campaign),
    bySource: split(month, (r) => r.source),
  };
}
