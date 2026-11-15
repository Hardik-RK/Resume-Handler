// Client for the intake server. The page and the server share one origin, so every path is relative.
//
// Auth is chosen by the server: none (loopback), token (a static bearer) or signed (a session token issued by the host
// application). When a token is needed it comes from the address (#token=...), is kept for this tab only, and is sent as
// `Authorization: Bearer`. The live stream (EventSource cannot send headers) carries it in the query string.
import type {
  EngineEvent, EngineInfo, HelloInfo, InputFile, ResultsAnswer, ResultRow, RunOptions, SettingsBody, SettingsInfo, UploadAnswer,
} from './types';

export type ApiErrorCode = 'unreachable' | 'unauthorized' | 'busy' | 'server';

export const MESSAGES = {
  unreachable: 'The server is not reachable. Check that it is running, then try again.',
  unauthorized: 'The server asked for a sign-in and this page has no valid token.',
} as const;

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  constructor(code: ApiErrorCode, message: string, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong.';
}

export const errorCode = (err: unknown): ApiErrorCode | '' => (err instanceof ApiError ? err.code : '');

// ── token ────────────────────────────────────────────────────────────────────────────────────────────────────
const TOKEN_KEY = 'resume-intake.token';
let token = '';

export function getAuthToken(): string {
  return token;
}

export function setAuthToken(value: string): void {
  token = value.trim();
  try {
    if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
    else window.sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* storage blocked: the token lives for this page only */ }
}

/** Reads a token handed over in the address (#token=...) or kept from earlier in this tab, and removes it from the address bar. */
export function initAuthToken(): void {
  let found = '';
  try { found = window.sessionStorage.getItem(TOKEN_KEY) || ''; } catch { /* storage blocked */ }
  const match = /(?:^#|&)token=([^&]+)/.exec(window.location.hash);
  if (match) {
    found = decodeURIComponent(match[1]);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  if (found) setAuthToken(found);
}

// ── calls ────────────────────────────────────────────────────────────────────────────────────────────────────
interface CallOptions {
  body?: unknown;
  form?: FormData;
  raw?: boolean;
  auth?: boolean;
}

async function call(method: string, path: string, opts: CallOptions & { raw: true }): Promise<Response>;
async function call<T = unknown>(method: string, path: string, opts?: CallOptions): Promise<T>;
async function call(method: string, path: string, { body, form, raw = false, auth = true }: CallOptions = {}): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload, cache: 'no-store' });
  } catch {
    throw new ApiError('unreachable', MESSAGES.unreachable);
  }
  if (res.status === 401) throw new ApiError('unauthorized', MESSAGES.unauthorized, res.status);
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    const message = data.error || data.message || `The server request failed (${res.status}).`;
    throw new ApiError(res.status === 409 ? 'busy' : 'server', message, res.status);
  }
  if (raw) return res;
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

/** True when the server wants a token (`/hello` says so) and this page has none yet, so asking /state would only log a 401. */
export const needsSignIn = (info: Pick<HelloInfo, 'auth'>): boolean => Boolean(info.auth) && info.auth !== 'none' && !token;

export const hello = () => call<HelloInfo>('GET', '/hello', { auth: false });
export const engineState = () => call<EngineInfo>('GET', '/state');

/** The current settings (secrets only as set / not set). A server without the route answers null. */
export async function getSettings(): Promise<SettingsInfo | null> {
  try {
    const data = await call<Partial<SettingsInfo> | null>('GET', '/settings');
    if (!data || typeof data !== 'object') return null;
    return { config: data.config || {}, secrets: data.secrets || {}, secretsReady: data.secretsReady };
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 405)) return null;
    throw err;
  }
}

export const saveSettings = (body: SettingsBody) => call('POST', '/settings', { body });

export async function engineFiles(): Promise<InputFile[]> {
  const data = await call<InputFile[] | { files?: InputFile[] } | null>('GET', '/files');
  return Array.isArray(data) ? data : data?.files || [];
}

export const removeFile = (name: string) => call('DELETE', `/files/${encodeURIComponent(name)}`);
export const startRun = (options: RunOptions) => call('POST', '/run', { body: options });
export const cancelRun = () => call('POST', '/cancel');
export const retryCommit = () => call<EngineInfo['commit']>('POST', '/commit/retry');
export const openFolder = (target: string) => call('POST', '/open', { body: { target } });

/** The whole /results answer: { available, summary, rows, csvAvailable }. */
export async function lastResults(): Promise<ResultsAnswer> {
  const data = await call<ResultRow[] | Partial<ResultsAnswer> | null>('GET', '/results');
  if (Array.isArray(data)) return { available: true, summary: null, rows: data, csvAvailable: true };
  return {
    available: Boolean(data?.available ?? data?.rows),
    summary: data?.summary || null,
    rows: data?.rows || [],
    csvAvailable: Boolean(data?.csvAvailable),
  };
}

export const results = async (): Promise<ResultRow[]> => (await lastResults()).rows;

/** The CSV of the last run, as text (the page keeps it per batch because the server only keeps the latest one). */
export async function resultsCsv(): Promise<string> {
  const res = await call('GET', '/results.csv', { raw: true });
  return res.text();
}

/** Uploads one file with XHR so progress is real. onProgress receives 0..1. */
export function uploadFile(file: File, { onProgress }: { onProgress?: (fraction: number) => void } = {}): Promise<UploadAnswer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append('files', file, file.name);
    xhr.open('POST', '/files');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (event) => { if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        try { resolve(JSON.parse(xhr.responseText || '{}') as UploadAnswer); } catch { resolve({}); }
        return;
      }
      let message = `The server refused the file (${xhr.status}).`;
      try { message = (JSON.parse(xhr.responseText) as { error?: string }).error || message; } catch { /* keep default */ }
      const code: ApiErrorCode = xhr.status === 401 ? 'unauthorized' : xhr.status === 409 ? 'busy' : 'server';
      reject(new ApiError(code, message, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('unreachable', MESSAGES.unreachable));
    xhr.send(form);
  });
}

// ── live events ──────────────────────────────────────────────────────────────────────────────────────────────
export type StreamStatus = 'open' | 'lost';

const EVENTS = [
  'phase', 'progress', 'file', 'cost', 'log', 'notice', 'state',
  'commit_started', 'commit_preflight', 'commit_done', 'commit_failed',
] as const;

interface Frame {
  id?: number;
  data?: Record<string, unknown>;
}

/**
 * Opens /events and calls onEvent({ type, ...payload }) for each named event. Reconnects with back-off; the server replays
 * what it sent after Last-Event-ID, so the highest id seen is kept and anything at or below it is dropped. Returns { close }.
 */
export function subscribe(onEvent: (event: EngineEvent) => void, onStatus: (status: StreamStatus) => void = () => {}): { close: () => void } {
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let delay = 1000;
  let lastId = 0;

  const scheduleRetry = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(open, delay);
    delay = Math.min(delay * 2, 10000);
  };

  function open() {
    if (closed) return;
    const params = new URLSearchParams();
    if (token) params.set('token', token);
    if (lastId) params.set('lastEventId', String(lastId));
    const query = params.toString();
    source = new EventSource(`/events${query ? `?${query}` : ''}`);
    source.onopen = () => { delay = 1000; onStatus('open'); };
    for (const type of EVENTS) {
      source.addEventListener(type, (message) => {
        let frame: Frame = {};
        try { frame = JSON.parse((message as MessageEvent<string>).data || '{}') as Frame; } catch { return; }
        const id = Number(frame.id) || 0;
        if (id && id <= lastId) return;
        if (id) lastId = id;
        onEvent({ type, ...(frame.data || {}) } as EngineEvent);
      });
    }
    source.onerror = () => {
      source?.close();
      source = null;
      onStatus('lost');
      scheduleRetry();
    };
  }

  open();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      source?.close();
      source = null;
    },
  };
}
