import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, errorMessage, lastResults, resultsCsv, uploadFile } from './lib/api';
import type { Batch, CommitInfo, ResultRow, SubmitForm } from './lib/types';
import { addHistory, recordFor } from './history';
import { readParallel } from './format';
import { problemLines } from './run-state';
import {
  FINISHED, entriesFromForm, findOrphans, normaliseCounts, optionsFor, parallelFor, readStoredBatches, retryProblem,
  runnable, writeStoredBatches,
} from './queue-logic';
import type { ResumeEngine } from './use-resume-engine';

export { ACCEPT, DEFAULT_PARALLEL, batchState, groupFiles, newId, readyFiles } from './queue-logic';

// The upload queue. Submitting the form creates entries (each zip its own entry, the loose PDFs of one submission together in
// one entry, all with the campaign type, source, Drive folder and screening chosen in the form), copies the files to the
// server's input folder, and the queue runs the entries strictly one after another: POST /run with `inputs` = that entry's
// file names, wait for the terminal phase event, keep the entry's rows and CSV (the server only keeps the latest), then the
// next. The queue (without rows, CSVs or any résumé data) is kept in this browser so a reload does not lose it; after a
// reload the restored queue waits for Resume instead of starting by itself.
// Entry status: queued | running | done | failed | cancelled. A queued entry whose files are still uploading is "uploading".

type BatchChange = Partial<Batch> | ((b: Batch) => Partial<Batch>);
type Paused = '' | 'restored' | 'cancelled' | 'engine';

const UPLOAD_CONCURRENCY = 3;

export function useBatchQueue(engine: ResumeEngine) {
  const config = engine.settings?.config;
  const sources = useMemo(
    () => (Array.isArray(config?.platforms) ? config.platforms.map((p) => (typeof p === 'string' ? p : p?.name || '')).filter(Boolean) : []),
    [config?.platforms],
  );
  const [batches, setBatches] = useState<Batch[]>([]);
  const [restored, setRestored] = useState(false);
  const [active, setActive] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [paused, setPaused] = useState<Paused>('');          // why the queue waits for Resume ('' = runs by itself)
  const [session, setSession] = useState<string[]>([]);      // ids run since the queue last started from idle

  const batchesRef = useRef(batches);
  const engineRef = useRef(engine);
  const activeRef = useRef(false);
  const stopRef = useRef(false);
  const blobs = useRef(new Map<string, File>());              // file key -> File, until its upload finishes
  batchesRef.current = batches;
  engineRef.current = engine;

  useEffect(() => {
    const list = readStoredBatches();
    setBatches(list);
    if (list.some((b) => b.status === 'queued')) setPaused('restored');
    setRestored(true);
  }, []);
  useEffect(() => {
    if (restored) writeStoredBatches(batches);
  }, [batches, restored]);

  const patch = useCallback((id: string, change: BatchChange) => {
    setBatches((list) => list.map((b) => (b.id === id ? { ...b, ...(typeof change === 'function' ? change(b) : change) } : b)));
  }, []);
  const patchFile = useCallback((id: string, key: string, change: Partial<Batch['files'][number]>) => {
    setBatches((list) => list.map((b) => {
      if (b.id !== id) return b;
      const files = b.files.map((f) => (f.key === key ? { ...f, ...change } : f));
      const next = { ...b, files };
      // Every file of the entry failed to copy: the entry cannot run, say why.
      if (b.status === 'queued' && files.every((f) => f.status === 'error')) {
        return { ...next, status: 'failed' as const, finishedAt: Date.now(), error: `The file could not be copied to the server: ${files[0]?.error || 'unknown error'}` };
      }
      return next;
    }));
  }, []);

  const uploadAll = useCallback(async (jobs: Array<{ batchId: string; key: string }>) => {
    let next = 0;
    const lane = async () => {
      while (next < jobs.length) {
        const { batchId, key } = jobs[next];
        next += 1;
        const file = blobs.current.get(key);
        if (!file) continue;
        try {
          const res = await uploadFile(file, { onProgress: (p) => patchFile(batchId, key, { progress: p }) });
          const name = (Array.isArray(res?.added) && res.added[0]) || file.name;
          patchFile(batchId, key, { status: 'ready', name, progress: 1 });
        } catch (err) {
          patchFile(batchId, key, { status: 'error', error: errorMessage(err) });
        } finally {
          blobs.current.delete(key);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, jobs.length) }, lane));
    engineRef.current.refreshFiles().catch(() => {});
  }, [patchFile]);

  // The form's submission. Returns the number of entries created.
  const submit = useCallback((form: SubmitForm): number => {
    const { entries, jobs } = entriesFromForm(form, blobs.current);
    if (entries.length) setBatches((b) => [...b, ...entries]);
    if (jobs.length) uploadAll(jobs);
    return entries.length;
  }, [uploadAll]);

  const orphans = useMemo(() => findOrphans(batches, engine.files), [batches, engine.files]);

  // Removing an entry only takes it off the list; its files stay in the input folder (the page offers them back).
  const remove = useCallback((id: string) => {
    const batch = batchesRef.current.find((b) => b.id === id);
    if (!batch || batch.status === 'running') return;
    setBatches((list) => list.filter((b) => b.id !== id));
  }, []);

  // Cancel a queued entry from its row: it stays in the list as cancelled (its files stay in the input folder, so Run again
  // can bring it back). The running entry is cancelled through cancel() below.
  const cancelQueued = useCallback((id: string) => {
    patch(id, (b) => (b.status === 'queued' ? { status: 'cancelled', finishedAt: Date.now(), error: '' } : {}));
  }, [patch]);

  const clearFinished = useCallback(() => setBatches((list) => list.filter((b) => !FINISHED.has(b.status))), []);

  // Run again: only when its files are still in the input folder (a finished zip moves to the processed folder).
  const retry = useCallback((id: string): string => {
    const batch = batchesRef.current.find((b) => b.id === id);
    if (!batch) return '';
    const present = new Set((engineRef.current.files || []).map((f) => f.name));
    const problem = retryProblem(batch, present);
    if (problem) {
      patch(id, { error: problem });
      return problem;
    }
    patch(id, { status: 'queued', error: '', counts: null, cost: null, startedAt: null, finishedAt: null, rows: [], csv: '', commitResult: null });
    setPaused('');
    return '';
  }, [patch]);

  const start = useCallback(async () => {
    if (activeRef.current) return;
    activeRef.current = true;
    stopRef.current = false;
    setActive(true);
    setStopping(false);
    setPaused('');
    engineRef.current.setQueueBusy(true);
    setSession([]);
    try {
      while (!stopRef.current) {
        const next = batchesRef.current.find(runnable);
        if (!next) break;
        setSession((ids) => (ids.includes(next.id) ? ids : [...ids, next.id]));
        patch(next.id, { status: 'running', startedAt: Date.now(), finishedAt: null, error: '', counts: null, cost: null, rows: [], csv: '', commitResult: null });
        let end;
        try {
          end = await engineRef.current.runBatch(optionsFor(next, parallelFor(readParallel(), engineRef.current.settings?.config)));
        } catch (err) {
          patch(next.id, { status: 'failed', finishedAt: Date.now(), error: errorMessage(err) });
          // The server is busy or gone: pause rather than fail every entry in turn.
          if (err instanceof ApiError && ['busy', 'unreachable', 'unauthorized'].includes(err.code)) { setPaused('engine'); break; }
          continue;
        }
        let rows: ResultRow[] = [];
        let csv = '';
        if (end.phase !== 'failed') {
          try {
            const res = await lastResults();
            rows = res.rows;
            // Only when the server wrote one: a cancelled run has rows but no CSV, and asking would log a 404.
            if (res.csvAvailable) csv = await resultsCsv().catch(() => '');
          } catch { /* the counts still tell the story; the output folder has the CSV */ }
        }
        const live = engineRef.current.run;
        patch(next.id, {
          status: end.phase === 'done' ? 'done' : (end.phase as Batch['status']),
          finishedAt: Date.now(),
          counts: normaliseCounts(end.counts),
          commitResult: end.commit || null,
          cost: end.cost || { tokens: live.tokens, usd: live.usd },
          error: end.phase === 'failed' ? (end.detail || 'The server stopped this upload.') : '',
          problems: problemLines(live.files),
          rows, csv,
        });
        engineRef.current.refreshFiles().catch(() => {});
        addHistory(recordFor(next, end, live));
        // Cancel stops the running entry and keeps the rest queued until Resume.
        if (end.phase === 'cancelled') { setPaused('cancelled'); break; }
      }
    } finally {
      if (stopRef.current) setPaused((p) => p || 'cancelled');
      activeRef.current = false;
      setActive(false);
      setStopping(false);
      engineRef.current.setQueueBusy(false);
    }
  }, [patch]);

  // The server can take a run: reached, and the live stream is up.
  const engineReady = engine.phase === 'ready' && engine.live;
  const hasRunnable = batches.some(runnable);

  // Entries start by themselves: whenever the queue is idle, not paused, and something can run.
  useEffect(() => {
    if (restored && !paused && engineReady && hasRunnable && !active && !activeRef.current) start();
  }, [restored, paused, engineReady, hasRunnable, active, start]);

  const resume = useCallback(() => setPaused(''), []);

  // Sends a failed commit again (the server retries idempotently); the entry keeps its rows and CSV.
  const retryCommit = useCallback(async (id: string): Promise<CommitInfo> => {
    const idle = { counts: {}, tokenRejected: false, configured: true } as const;
    patch(id, (b) => ({ commitResult: { ...idle, ...(b.commitResult || {}), status: 'running', lastError: '' } }));
    try {
      const result = await engineRef.current.retryCommit();
      patch(id, { commitResult: result });
      return result;
    } catch (err) {
      patch(id, (b) => ({ commitResult: { ...idle, ...(b.commitResult || {}), status: 'failed', lastError: errorMessage(err) } }));
      throw err;
    }
  }, [patch]);

  const cancel = useCallback(async () => {
    stopRef.current = true;
    setStopping(true);
    try {
      if (batchesRef.current.some((b) => b.status === 'running')) await engineRef.current.stopRun();
    } catch (err) {
      stopRef.current = false;
      setStopping(false);
      throw err;
    }
  }, []);

  return {
    batches, sources, active, stopping, paused, session, orphans, engineReady,
    submit, remove, clearFinished, retry, resume, cancel, cancelQueued, retryCommit,
  };
}

export type BatchQueue = ReturnType<typeof useBatchQueue>;
