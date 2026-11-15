import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError, MESSAGES, cancelRun, engineFiles, engineState, errorMessage, getSettings, hello, openFolder as openFolderOnServer, removeFile,
  needsSignIn, results, retryCommit as retryCommitOnServer, saveSettings as saveSettingsOnServer, setAuthToken, startRun, subscribe,
} from './lib/api';
import type {
  EngineEvent, EngineInfo, HelloInfo, InputFile, Notice, ResultRow, RunEnd, RunOptions, RunState, SettingsBody, SettingsInfo, CommitInfo,
} from './lib/types';
import { EMPTY_RUN, RUNNING, TERMINAL, normaliseCommit, num, reduceRun } from './run-state';

// One hook owns the server connection for the page: reaching it, the live event stream, the input folder and the current
// run. The batch queue (use-batch-queue.ts) drives runs through runBatch(), which resolves when the server reports the run's
// terminal phase. Components only render what they get.
// Phases: checking | connecting | ready | unreachable (no answer from the server) | unauthorized (a token is needed) | error.

export type EnginePhase = 'checking' | 'connecting' | 'ready' | 'unreachable' | 'unauthorized' | 'error';

const STATE_POLL_MS = 5000;
// After a run ends, the commit may still be running (the server emits 'done' after the commit): wait for it, up to ~5 min.
const COMMIT_PENDING = new Set(['idle', 'running']);
const COMMIT_POLL_MS = 1000;
const COMMIT_WAIT_TICKS = 300;
const RECONNECT_POLL_MS = 2000;

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

interface Waiter {
  resolve: (end: RunEnd) => void;
  startedAt: number;
}

export interface EngineError {
  code: string;
  message: string;
}

export interface ServerInfo {
  version: string;
  dataDir?: string;
}

export function useResumeEngine() {
  const [phase, setPhase] = useState<EnginePhase>('checking');
  const [error, setError] = useState<EngineError | null>(null);
  const [engine, setEngine] = useState<ServerInfo | null>(null);
  const [settings, setSettings] = useState<SettingsInfo | null>(null);   // GET /settings
  const [engineInfo, setEngineInfo] = useState<EngineInfo | null>(null); // GET /state
  const [files, setFiles] = useState<InputFile[]>([]);
  const [run, setRun] = useState<RunState>(EMPTY_RUN);
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [live, setLive] = useState(false);
  const [session, setSession] = useState(0);
  const [, setQueueBusy] = useState(false);

  // Refs the long-lived callbacks read, so they never act on stale state.
  const lostRef = useRef(false);
  const waiterRef = useRef<Waiter | null>(null);                           // { resolve, startedAt } while runBatch() waits for the end

  const refreshFiles = useCallback(async () => {
    setFiles(await engineFiles());
  }, []);

  const refreshEngineInfo = useCallback(async () => {
    const info = await engineState();
    setEngineInfo(info);
    if (RUNNING.has(info.phase)) {
      setRun((r) => (r.status === 'running' ? r : { ...EMPTY_RUN, status: 'running', phase: info.phase, startedAt: Date.now() }));
    }
    return info;
  }, []);

  const loadResults = useCallback(() => {
    results().then(setRows).catch(() => {});
  }, []);

  const refreshSettings = useCallback(async () => {
    // A server that does not list its settings leaves the dialog empty rather than hiding it.
    // GET /settings, else the settings /state carries; a server that lists neither leaves the dialog empty.
    const listed = await getSettings();
    const fromState = listed ? null : await engineState().catch(() => null);
    const info: SettingsInfo = listed ?? { config: fromState?.config || {}, secrets: fromState?.secrets || {} };
    setSettings(info);
    return info;
  }, []);

  const onEvent = useCallback((event: EngineEvent) => {
    setRun((r) => reduceRun(r, event));
    switch (event.type) {
      case 'phase': {
        const p = event.phase ?? event.value ?? '';
        if (TERMINAL.has(p)) {
          loadResults();
          refreshEngineInfo().catch(() => {});
          const waiter = waiterRef.current;
          if (waiter) {
            waiterRef.current = null;
            waiter.resolve({ phase: p, counts: event.counts || {}, cost: event.cost ? { tokens: num(event.cost.tokens), usd: num(event.cost.usd) } : null, detail: event.detail || '' });
          }
        }
        break;
      }
      case 'notice':
        setNotices((list) => [...list.filter((n) => n.code !== event.code), { code: event.code || 'notice', level: event.level || 'warn', message: event.message || '' }].slice(-4));
        break;
      case 'state':
        refreshFiles().catch(() => {});
        break;
      default:
        break;
    }
  }, [loadResults, refreshEngineInfo, refreshFiles]);

  // Pulls everything the page shows once the server is reached.
  const loadAll = useCallback(async () => {
    await Promise.all([
      refreshFiles().catch(() => {}),
      refreshEngineInfo().catch(() => {}),
      refreshSettings().catch(() => {}),
    ]);
  }, [refreshEngineInfo, refreshFiles, refreshSettings]);

  const connect = useCallback(async () => {
    setPhase('connecting');
    setError(null);
    try {
      const found: HelloInfo = await hello();
      if (needsSignIn(found)) throw new ApiError('unauthorized', MESSAGES.unauthorized, 401);
      await engineState();                         // the first call that needs the session: a 401 lands in the catch
      setEngine({ version: found.version, dataDir: found.dataDir });
      setSession((s) => s + 1);
      setPhase('ready');
      await loadAll();
      loadResults();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'server';
      setPhase(code === 'unreachable' ? 'unreachable' : code === 'unauthorized' ? 'unauthorized' : 'error');
      setError({ code, message: errorMessage(err) });
    }
  }, [loadAll, loadResults]);

  // First load.
  useEffect(() => { connect(); }, [connect]);

  // The server does not answer: look for it every 2 seconds.
  useEffect(() => {
    if (phase !== 'unreachable') return undefined;
    let alive = true;
    const timer = setInterval(async () => {
      const found = await hello().catch(() => null);
      if (found && alive) connect();
    }, RECONNECT_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [phase, connect]);

  // Live events while connected. The subscription reconnects by itself; afterwards the state and the files are read again.
  useEffect(() => {
    if (phase !== 'ready') return undefined;
    const sub = subscribe(onEvent, (status) => {
      if (status === 'lost') {
        lostRef.current = true;
        setLive(false);
        return;
      }
      setLive(true);
      if (!lostRef.current) return;
      lostRef.current = false;
      hello().then((found) => setEngine((e) => ({ ...(e || { version: '' }), version: found.version }))).catch(() => {});
      Promise.all([refreshEngineInfo().catch(() => {}), refreshFiles().catch(() => {})]);
    });
    return () => sub.close();
  }, [phase, session, onEvent, refreshEngineInfo, refreshFiles]);

  const runActive = run.status === 'running' || run.status === 'cancelling';

  const deleteFile = useCallback(async (name: string) => {
    await removeFile(name);
    await refreshFiles();
  }, [refreshFiles]);

  // Starts one run and resolves with { phase, counts, cost, detail, commit } when it ends (done, failed or cancelled).
  // The event stream normally ends it; /state is polled as a fallback in case the stream drops the final event.
  const runBatch = useCallback(async (options: RunOptions): Promise<RunEnd> => {
    const startedAt = Date.now();
    setRun({ ...EMPTY_RUN, status: 'running', phase: 'preparing', startedAt });
    const ended = new Promise<RunEnd>((resolve) => { waiterRef.current = { resolve, startedAt }; });
    try {
      // The server frees its run lock a moment after announcing the end of the previous run: retry briefly when busy.
      for (let attempt = 0; ; attempt += 1) {
        try { await startRun(options); break; } catch (err) {
          if (!(err instanceof ApiError) || err.code !== 'busy' || attempt >= 8) throw err;
          await sleep(500);
        }
      }
    } catch (err) {
      waiterRef.current = null;
      setRun(EMPTY_RUN);
      throw err;
    }
    const poll = setInterval(async () => {
      const waiter = waiterRef.current;
      if (!waiter) return;
      const info = await engineState().catch(() => null);
      const last = info?.lastRun;
      const finished = last && TERMINAL.has(last.phase) && Date.parse(last.finishedAt || last.at || '') >= waiter.startedAt - 1000;
      if (info && last && !RUNNING.has(info.phase) && finished) {
        waiterRef.current = null;
        setRun((r) => ({ ...r, status: last.phase as RunState['status'], phase: last.phase }));
        waiter.resolve({ phase: last.phase, counts: last.counts || {}, cost: last.cost || null, detail: last.detail || '' });
      }
    }, STATE_POLL_MS);
    try {
      const end = await ended;
      // The commit outcome of this run, read once the run has ended. A commit failure never fails the run itself.
      const commitOn = options.commit.enabled;
      let info = commitOn ? await engineState().catch(() => null) : null;
      // The server sends the final 'done' phase AFTER the commit events, so the run can end while the commit still runs.
      // Wait until the commit has left 'running' (or 'idle') before reading its outcome.
      for (let i = 0; commitOn && COMMIT_PENDING.has(info?.commit?.status ?? '') && i < COMMIT_WAIT_TICKS; i += 1) {
        await sleep(COMMIT_POLL_MS);
        info = await engineState().catch(() => null);
      }
      return { ...end, commit: commitOn ? normaliseCommit(info?.commit) : null };
    } finally { clearInterval(poll); }
  }, []);

  // Sends the failed commit again and waits for the server to report its outcome (idempotent on the server side).
  const retryCommit = useCallback(async (): Promise<CommitInfo> => {
    await retryCommitOnServer();
    for (let i = 0; i < COMMIT_WAIT_TICKS; i += 1) {
      await sleep(COMMIT_POLL_MS);
      const info = await engineState().catch(() => null);
      if (info?.commit && info.commit.status !== 'running') return normaliseCommit(info.commit);
    }
    throw new Error('The commit is still running. Check the campaign in a few minutes.');
  }, []);

  const stopRun = useCallback(async () => {
    setRun((r) => ({ ...r, status: 'cancelling' }));
    try {
      await cancelRun();
    } catch (err) {
      setRun((r) => ({ ...r, status: 'running' }));
      throw err;
    }
  }, []);

  const openFolder = useCallback((target: string) => openFolderOnServer(target), []);

  // Saves the settings on the server, then reads them back (secrets come back only as set / not set).
  const saveSettings = useCallback(async (body: SettingsBody) => {
    await saveSettingsOnServer(body);
    const info = await refreshSettings();
    refreshEngineInfo().catch(() => {});
    return info;
  }, [refreshEngineInfo, refreshSettings]);

  // The source list and the like: a partial config patch.
  const saveShared = useCallback((patch: Record<string, unknown>) => saveSettings({ config: patch }), [saveSettings]);

  // The server asked for a token: keep it for this tab and connect again.
  const signIn = useCallback((token: string) => {
    setAuthToken(token);
    return connect();
  }, [connect]);

  const dismissNotice = useCallback((code: string) => setNotices((list) => list.filter((n) => n.code !== code)), []);

  return {
    phase, error, engine, live, settings, engineInfo, files, run, rows, notices,
    retry: connect, signIn, dismissNotice, refreshFiles, deleteFile, runBatch, stopRun, retryCommit,
    openFolder, saveSettings, saveShared, refreshSettings, runActive, setQueueBusy,
  };
}

export type ResumeEngine = ReturnType<typeof useResumeEngine>;
