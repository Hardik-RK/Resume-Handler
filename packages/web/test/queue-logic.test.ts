import { describe, expect, it } from 'vitest';
import {
  FINISHED, batchState, entriesFromForm, findOrphans, groupFiles, normaliseCounts, optionsFor, parallelFor, parseStored, readyFiles, retryProblem,
  runnable, toStore,
} from '../src/queue-logic';
import type { Batch, QueueFile, SubmitForm } from '../src/lib/types';

const file = (name: string, status: QueueFile['status'] = 'ready'): QueueFile => ({ key: `k-${name}`, name, original: name, size: 10, status, progress: 1 });
const batch = (over: Partial<Batch> = {}): Batch => ({
  id: 'b1', status: 'queued', createdAt: 1, source: 'LinkedIn', campaignType: 'TECH', driveFolderId: '', folderName: '',
  jd: { on: false, text: '', threshold: 0, dryRun: false }, commit: { enabled: false, campaignId: null, campaignLabel: '' },
  commitResult: null, counts: null, cost: null, startedAt: null, finishedAt: null, error: '', rows: [], csv: '', files: [file('a.pdf')], ...over,
});

describe('groupFiles', () => {
  it('puts each zip alone and the loose PDFs together', () => {
    const groups = groupFiles([{ name: 'a.pdf' }, { name: 'x.zip' }, { name: 'b.PDF' }, { name: 'y.ZIP' }]);
    expect(groups.map((g) => g.map((f) => f.name))).toEqual([['x.zip'], ['y.ZIP'], ['a.pdf', 'b.PDF']]);
    expect(groupFiles([])).toEqual([]);
  });
});

describe('batch state', () => {
  it('shows a queued entry with a file still copying as uploading, and only runs ready ones', () => {
    const copying = batch({ files: [file('a.pdf', 'uploading')] });
    expect(batchState(copying)).toBe('uploading');
    expect(runnable(copying)).toBe(false);
    expect(batchState(batch())).toBe('queued');
    expect(runnable(batch())).toBe(true);
    expect(runnable(batch({ status: 'running' }))).toBe(false);
    expect(runnable(batch({ files: [file('a.pdf', 'error')] }))).toBe(false);
    expect(readyFiles(batch({ files: [file('a.pdf'), file('b.pdf', 'error')] }))).toHaveLength(1);
  });
  it('knows which statuses are finished', () => {
    expect([...FINISHED].sort()).toEqual(['cancelled', 'done', 'failed']);
  });
});

describe('normaliseCounts', () => {
  it('reads both the server and the page spellings and nulls what is absent', () => {
    expect(normaliseCounts({ parsed: 3, uploaded: 2, reused_existing: 1, upload_failed: 4, rows: 3 })).toEqual({
      parsed: 3, uploaded: 2, reused: 1, quarantined: 0, uploadFailed: 4, rows: 3, files: null,
    });
    expect(normaliseCounts(null).parsed).toBe(0);
  });
});

describe('optionsFor', () => {
  it('builds the run options of an entry', () => {
    const o = optionsFor(batch({ files: [file('a.pdf'), file('b.pdf', 'error')], driveFolderId: 'f1' }), 5);
    expect(o).toMatchObject({ campaignType: 'TECH', platform: 'LinkedIn', driveFolderId: 'f1', parallel: 5, dryRun: false, jdFilter: false, inputs: ['a.pdf'], commit: { enabled: false } });
    expect('jd' in o).toBe(false);
  });
  it('adds the commit and the JD text when on', () => {
    const o = optionsFor(batch({ commit: { enabled: true, campaignId: '101', campaignLabel: 'x' }, jd: { on: true, text: '  need go  ', threshold: 60, dryRun: true } }), 3);
    expect(o.commit).toEqual({ enabled: true, campaignId: 101, source: 'Resume intake', stage: 'LEAD' });
    expect(o).toMatchObject({ jd: 'need go', jdFilter: true, jdThreshold: 60, dryRun: true });
  });
  it('does not commit without a campaign', () => {
    expect(optionsFor(batch({ commit: { enabled: true, campaignId: null, campaignLabel: '' } }), 5).commit).toEqual({ enabled: false });
  });
});

describe('parallelFor', () => {
  it('prefers the operator, then the server default, then 5', () => {
    expect(parallelFor(7, { maxConcurrency: 3 })).toBe(7);
    expect(parallelFor(null, { maxConcurrency: 3 })).toBe(3);
    expect(parallelFor(null, { maxConcurrency: 99 })).toBe(5);
    expect(parallelFor(null, undefined)).toBe(5);
  });
});

describe('what is kept in the browser', () => {
  it('stores settings and outcomes but never rows or csv, and only ready files', () => {
    const stored = toStore([batch({ rows: [{ Name: 'x' }], csv: 'secret', files: [file('a.pdf'), file('b.pdf', 'error')] }), batch({ id: 'b2', files: [file('c.pdf', 'uploading')] })]) as Array<Record<string, unknown>>;
    expect(stored).toHaveLength(1);
    expect(stored[0].rows).toBeUndefined();
    expect(stored[0].csv).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain('secret');
    expect((stored[0].files as unknown[]).length).toBe(1);
  });
  it('restores a running entry as failed and survives garbage', () => {
    const text = JSON.stringify([{ ...batch({ status: 'running' }), rows: undefined }, { nope: true }, batch({ id: 'b3', files: [] })]);
    const list = parseStored(text, 99);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'failed', finishedAt: 99, rows: [], csv: '' });
    expect(list[0].error).toMatch(/page was closed/);
    expect(parseStored('not json')).toEqual([]);
    expect(parseStored('{"a":1}')).toEqual([]);
    expect(parseStored(null)).toEqual([]);
  });
});

describe('findOrphans', () => {
  const files = [{ name: 'a.pdf', size: 1 }, { name: 'b.zip', size: 1 }, { name: 'notes.txt', size: 1 }, { name: 'c.pdf', size: 1 }];
  it('offers input-folder files no entry refers to, PDFs and zips only', () => {
    expect(findOrphans([batch()], files).map((f) => f.name)).toEqual(['b.zip', 'c.pdf']);
  });
  it('offers nothing while a file is still copying', () => {
    expect(findOrphans([batch({ files: [file('z.pdf', 'uploading')] })], files)).toEqual([]);
  });
});

describe('retryProblem', () => {
  it('is empty when every file is still in the input folder', () => {
    expect(retryProblem(batch(), new Set(['a.pdf']))).toBe('');
  });
  it('names the files that left the folder, singular and plural', () => {
    expect(retryProblem(batch(), new Set())).toMatch(/^a\.pdf is no longer in the input folder/);
    expect(retryProblem(batch({ files: [file('a.pdf'), file('b.pdf')] }), new Set())).toMatch(/^a\.pdf, b\.pdf are no longer/);
  });
});

describe('entriesFromForm', () => {
  it('makes one entry per zip plus one for the PDFs, and queues a copy job per new file', () => {
    const blobs = new Map<string, File>();
    const make = (name: string) => new File(['x'], name);
    const form: SubmitForm = {
      files: [
        { key: 'p1', name: 'a.pdf', size: 1, file: make('a.pdf') },
        { key: 'p2', name: 'x.zip', size: 2, file: make('x.zip') },
        { key: 'p3', name: 'old.pdf', size: 3, resident: true },
      ],
      campaignType: 'SALES', source: 'Indeed', driveFolderId: 'f', folderName: 'Camp', jd: { on: false, text: '', threshold: 0, dryRun: false },
      commit: { enabled: true, campaignId: 7, campaignLabel: 'Camp' },
    };
    const { entries, jobs } = entriesFromForm(form, blobs, 5);
    expect(entries).toHaveLength(2);
    expect(entries[0].files.map((f) => f.original)).toEqual(['x.zip']);
    expect(entries[1].files.map((f) => [f.original, f.status])).toEqual([['a.pdf', 'uploading'], ['old.pdf', 'ready']]);
    expect(entries[1]).toMatchObject({ status: 'queued', createdAt: 5, campaignType: 'SALES', commit: { enabled: true, campaignId: 7, campaignLabel: 'Camp' } });
    expect(jobs).toHaveLength(2);
    expect(blobs.size).toBe(2);
  });
});
