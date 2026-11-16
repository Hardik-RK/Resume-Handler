// The pure part of the upload queue: grouping files into entries, run options, what is stored in the browser, orphans.
import type {
  Batch, Counts, EntryState, FormFile, InputFile, QueueFile, RunCounts, RunOptions, ServerConfig, SubmitForm,
} from './lib/types';

export const STORE_KEY = 'resume-intake-batches-v1';
export const ACCEPT = /\.(pdf|zip)$/i;
export const IS_ZIP = /\.zip$/i;
export const DEFAULT_PARALLEL = 5;
export const FINISHED = new Set(['done', 'failed', 'cancelled']);

let seq = 0;
export const newId = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

export const isUploading = (b: Batch): boolean => b.files.some((f) => f.status === 'uploading');
export const readyFiles = (b: Batch): QueueFile[] => b.files.filter((f) => f.status === 'ready');
export const batchState = (b: Batch): EntryState => (b.status === 'queued' && isUploading(b) ? 'uploading' : b.status);
export const runnable = (b: Batch): boolean => b.status === 'queued' && !isUploading(b) && readyFiles(b).length > 0;

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function normaliseCounts(raw: RunCounts | null | undefined): Counts {
  const c = raw || {};
  return {
    parsed: n(c.parsed), uploaded: n(c.uploaded), reused: n(c.reused_existing ?? c.reused), quarantined: n(c.quarantined),
    uploadFailed: n(c.upload_failed ?? c.uploadFailed),
    rows: c.rows == null ? null : n(c.rows), files: c.files == null ? null : n(c.files),
  };
}

/** What is stored: settings and outcomes only. Rows and CSVs hold candidate data and stay in memory. */
export function toStore(list: Batch[]): unknown[] {
  return list.map((b) => ({
    ...b, rows: undefined, csv: undefined,
    files: b.files.filter((f) => f.status === 'ready').map(({ key, name, original, size }) => ({ key, name, original, size, status: 'ready' })),
  })).filter((b) => b.files.length);
}

/** Reads the stored queue back. An entry that was running when the page closed comes back as failed. */
export function parseStored(text: string | null, now: number = Date.now()): Batch[] {
  let list: unknown = [];
  try { list = JSON.parse(text || '[]'); } catch { list = []; }
  if (!Array.isArray(list)) return [];
  return (list as Partial<Batch>[]).filter((b) => b && b.id && Array.isArray(b.files) && b.files.length).map((b) => ({
    ...(b as Batch),
    rows: [], csv: '',
    ...(b.status === 'running'
      ? { status: 'failed' as const, finishedAt: b.finishedAt || now, error: 'The page was closed or reloaded while this upload was running. The server keeps going and adds the rows by itself, so this is not necessarily a failure: check History and the results before running it again (a repeat is safe, duplicates are skipped).' }
      : {}),
  }));
}

export function readStoredBatches(): Batch[] {
  try { return parseStored(window.localStorage.getItem(STORE_KEY)); } catch { return []; }
}

export function writeStoredBatches(list: Batch[]): void {
  try { window.localStorage.setItem(STORE_KEY, JSON.stringify(toStore(list))); } catch { /* storage unavailable: the queue lives for this visit */ }
}

/** The number of parallel requests: the operator's own, else the server's default, else 5. */
export function parallelFor(own: number | null, cfg: ServerConfig | undefined): number {
  const max = Number(cfg?.maxConcurrency);
  return own ?? (Number.isInteger(max) && max >= 1 && max <= 16 ? max : DEFAULT_PARALLEL);
}

/** POST /run options for one entry. */
export function optionsFor(b: Batch, parallel: number): RunOptions {
  return {
    campaignType: b.campaignType, platform: b.source, driveFolderId: b.driveFolderId || '', parallel,
    dryRun: Boolean(b.jd?.dryRun), jdFilter: Boolean(b.jd?.on), jdThreshold: Number(b.jd?.threshold) || 0,
    ...(b.jd?.on ? { jd: String(b.jd.text).trim() } : {}),
    inputs: readyFiles(b).map((f) => f.name),
    // The server writes the rows to the campaign itself when enabled.
    commit: b.commit?.enabled && b.commit.campaignId != null
      ? { enabled: true, campaignId: typeof b.commit.campaignId === 'string' && /^\d+$/.test(b.commit.campaignId) ? Number(b.commit.campaignId) : b.commit.campaignId, source: 'Resume intake', stage: 'LEAD' }
      : { enabled: false },
  };
}

/** Groups the files of one submission: every zip on its own, the loose PDFs together. */
export function groupFiles<T extends { name: string }>(items: T[]): T[][] {
  const groups = items.filter((f) => IS_ZIP.test(f.name)).map((f) => [f]);
  const pdfs = items.filter((f) => !IS_ZIP.test(f.name));
  if (pdfs.length) groups.push(pdfs);
  return groups;
}

/**
 * Files in the input folder that no entry refers to (copied there by hand, left from an earlier visit, or the files of a queued
 * entry that was removed). Files of a finished entry are processed, so they are never offered.
 */
export function findOrphans(batches: Batch[], files: InputFile[]): InputFile[] {
  if (batches.some(isUploading)) return [];
  const used = new Set(batches.flatMap((b) => b.files.map((f) => f.name)));
  return (files || []).filter((f) => f && f.name && !used.has(f.name) && ACCEPT.test(f.name));
}

/** Why an entry cannot run again: its files left the input folder. Empty when it can. */
export function retryProblem(batch: Batch, present: Set<string>): string {
  const missing = readyFiles(batch).filter((f) => !present.has(f.name));
  if (!readyFiles(batch).length || missing.length) {
    const names = (missing.length ? missing : batch.files).map((f) => f.original || f.name).join(', ');
    return `${names} ${missing.length === 1 ? 'is' : 'are'} no longer in the input folder (the server moves processed files to its processed folder). Add the file again in the form.`;
  }
  return '';
}

/** The entries the form's submission creates. `blobs` receives the File of every file that still has to be copied to the server. */
export function entriesFromForm(form: SubmitForm, blobs: Map<string, File>, now: number = Date.now()): { entries: Batch[]; jobs: Array<{ batchId: string; key: string }> } {
  const jobs: Array<{ batchId: string; key: string }> = [];
  const entries = groupFiles(form.files).map((group): Batch => {
    const id = newId('b');
    return {
      id, status: 'queued', createdAt: now,
      source: form.source || '', campaignType: form.campaignType, driveFolderId: form.driveFolderId, folderName: form.folderName || '',
      jd: { ...form.jd },
      commit: { enabled: Boolean(form.commit?.enabled), campaignId: form.commit?.campaignId ?? null, campaignLabel: String(form.commit?.campaignLabel || '') },
      commitResult: null,
      counts: null, cost: null, startedAt: null, finishedAt: null, error: '', rows: [], csv: '',
      files: group.map((item: FormFile): QueueFile => {
        const key = newId('f');
        if (item.resident || !item.file) return { key, name: item.name, original: item.name, size: item.size, status: 'ready', progress: 1, error: '' };
        blobs.set(key, item.file);
        jobs.push({ batchId: id, key });
        return { key, name: '', original: item.name, size: item.size, status: 'uploading', progress: 0, error: '' };
      }),
    };
  });
  return { entries, jobs };
}
