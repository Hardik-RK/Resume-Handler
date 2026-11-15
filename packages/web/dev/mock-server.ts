// A tiny stand-in for the intake server, for developing and testing the page without the real one.
// It speaks the same routes and JSON shapes, replays canned events for a run, and serves dist/ when it exists.
//
//   npm run dev:mock                      # http://127.0.0.1:47831
//   MOCK_SCENARIO=nosink npm run dev:mock # no downstream system configured (CSV only)
//   MOCK_SCENARIO=auth npm run dev:mock   # asks for the token "demo-token"
//   MOCK_SCENARIO=commit-fail ...         # the commit step fails (shows Retry commit)
//   MOCK_SPEED=0.2 ...                    # events come 5x faster
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 47831);
const SCENARIO = process.env.MOCK_SCENARIO || 'default';
const SPEED = Number(process.env.MOCK_SPEED || 1);
const TOKEN = 'demo-token';
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

interface Frame { id: number; type: string; ts: string; data: Record<string, unknown> }
interface InputFile { name: string; size: number; modified: string; entries?: string[] | null }

const sinkConfigured = SCENARIO !== 'nosink';
const state = {
  phase: 'idle',
  running: false,
  files: [] as InputFile[],
  lastRun: null as Record<string, unknown> | null,
  lastRows: [] as Array<Record<string, string>>,
  commit: { status: 'idle', configured: sinkConfigured, counts: {} as Record<string, number>, lastError: '', tokenRejected: false },
  cancelled: false,
  config: {
    campaignTypes: ['TECH', 'TEACHER', 'SALES'],
    platforms: ['LinkedIn', 'Unstop', 'Indeed', 'Shine', 'Naukri'],
    campaigns: sinkConfigured
      ? [
        { id: 101, name: 'Backend engineers', group: 'Northwind Labs', type: 'TECH' },
        { id: 102, name: 'Campus sales drive', group: 'Northwind Labs', type: 'SALES' },
        { id: 201, name: 'Maths teachers', group: 'Lakeview School', type: 'TEACHER' },
      ]
      : [],
    modelExtract: 'example/extract-model',
    crmBaseUrl: sinkConfigured ? 'https://sink.example.test' : null,
    maxConcurrency: 5,
  } as Record<string, unknown>,
  secrets: { openrouterApiKey: { set: true, hint: 'a1b2' }, ingestionToken: { set: sinkConfigured, hint: sinkConfigured ? 'c3d4' : '' } } as Record<string, { set: boolean; hint: string }>,
};

const frames: Frame[] = [];
const clients = new Set<ServerResponse>();
let nextId = 1;

function emit(type: string, data: Record<string, unknown> = {}): void {
  const frame: Frame = { id: nextId, type, ts: new Date().toISOString(), data };
  nextId += 1;
  frames.push(frame);
  if (frames.length > 400) frames.shift();
  for (const res of clients) write(res, frame);
}

function write(res: ServerResponse, frame: Frame): void {
  res.write(`id: ${frame.id}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms * SPEED); });

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const NAMES = ['Asha Verma', 'Ravi Iyer', 'Meera Nair', 'Dev Malhotra', 'Isha Kapoor', 'Kabir Shah', 'Nina Das', 'Omar Sheikh'];

function rowsFor(count: number, platform: string): Array<Record<string, string>> {
  return Array.from({ length: count }, (_, i) => {
    const name = NAMES[i % NAMES.length];
    const slug = name.toLowerCase().replace(/\s+/g, '.');
    return {
      'Lead ID': `L-${1000 + i}`, Name: name, 'Email Address': `${slug}@example.test`, 'Phone Number': `+91 98${String(10000000 + i * 137).slice(0, 8)}`,
      Platform: platform, Resume: i % 4 === 3 ? '' : `https://files.example.test/resume/${1000 + i}`,
    };
  });
}

async function runPipeline(body: Record<string, unknown>): Promise<void> {
  const inputs = Array.isArray(body.inputs) ? (body.inputs as string[]) : state.files.map((f) => f.name);
  const commit = (body.commit || {}) as { enabled?: boolean };
  const total = Math.max(3, inputs.length * 3);
  const startedAt = Date.now();
  state.running = true;
  state.cancelled = false;
  state.phase = 'preparing';
  emit('phase', { phase: 'preparing' });
  await sleep(500);
  state.phase = 'parsing';
  emit('phase', { phase: 'parsing' });
  let tokens = 0;
  for (let i = 1; i <= total; i += 1) {
    if (state.cancelled) break;
    await sleep(450);
    tokens += 1800;
    emit('file', { name: `resume-${i}.pdf`, status: 'done', detail: '' });
    emit('progress', { done: i, total, elapsed: (Date.now() - startedAt) / 1000, eta: null });
    emit('cost', { tokens, usd: tokens * 0.0000011 });
    emit('log', { level: 'info', message: `Read resume-${i}.pdf` });
  }
  const cost = { tokens, usd: tokens * 0.0000011 };
  const counts = { parsed: total, uploaded: total, rows: total, files: inputs.length };
  if (state.cancelled) {
    finish('cancelled', counts, cost);
    return;
  }
  state.lastRows = rowsFor(total, String(body.platform || ''));
  if (commit.enabled) {
    state.commit = { ...state.commit, status: 'running', lastError: '', counts: {} };
    emit('commit_started');
    await sleep(600);
    emit('commit_preflight', { ready: total - 1, duplicate: 1, conflict: 0, invalid: 0 });
    await sleep(600);
    if (SCENARIO === 'commit-fail') {
      state.commit = { ...state.commit, status: 'failed', lastError: 'The downstream system did not answer (503)', tokenRejected: false };
      emit('commit_failed', { message: state.commit.lastError });
    } else {
      state.commit = { ...state.commit, status: 'done', counts: { rows: total, ready: total - 1, duplicate: 1, conflict: 0, invalid: 0, created: total - 1, skipped: 1, inBatchDuplicates: 0 } };
      emit('commit_done', { created: total - 1, skipped: 1 });
    }
  }
  finish('done', counts, cost);
}

function finish(phase: string, counts: Record<string, number>, cost: { tokens: number; usd: number }): void {
  state.lastRun = { phase, finishedAt: new Date().toISOString(), rows: state.lastRows.length, counts, cost, failedFiles: [] };
  state.running = false;
  state.phase = phase;
  emit('phase', { phase, counts, cost });
}

function csv(): string {
  const head = ['Lead ID', 'Name', 'Email Address', 'Phone Number', 'Platform', 'Resume'];
  const lines = state.lastRows.map((r) => head.map((h) => `"${(r[h] ?? '').replace(/"/g, '""')}"`).join(','));
  return [head.join(','), ...lines].join('\n');
}

function authorised(req: IncomingMessage, url: URL): boolean {
  if (SCENARIO !== 'auth') return true;
  const header = req.headers.authorization || '';
  return header === `Bearer ${TOKEN}` || url.searchParams.get('token') === TOKEN;
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff' };

function serveStatic(res: ServerResponse, path: string): boolean {
  if (!existsSync(DIST)) return false;
  const clean = normalize(path === '/' ? '/index.html' : path).replace(/^([/\\])+/, '');
  const file = join(DIST, clean);
  if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) return false;
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method || 'GET';
  try {
    if (method === 'GET' && path === '/hello') {
      json(res, 200, { app: 'resume-intake', version: '0.1.0-mock', protocol: 1, dataDir: 'mock', commitConfigured: sinkConfigured, auth: SCENARIO === 'auth' ? 'token' : 'none' });
      return;
    }
    const api = ['/state', '/settings', '/files', '/run', '/cancel', '/commit/retry', '/events', '/results', '/results.csv', '/open'].some((p) => path === p || path.startsWith('/files/'));
    if (!api) {
      if (method === 'GET' && (serveStatic(res, path) || serveStatic(res, '/index.html'))) return;
      json(res, 404, { error: 'Not found.' });
      return;
    }
    if (!authorised(req, url)) { json(res, 401, { error: 'A token is needed.' }); return; }

    if (method === 'GET' && path === '/state') {
      json(res, 200, {
        version: '0.1.0-mock', phase: state.phase, running: state.running, queue: { pdfs: state.files.length, zips: 0, rosters: 0 },
        lastRun: state.lastRun, settingsLoaded: true, google: { ok: true, reason: '' }, llm: { ok: true }, commit: state.commit, configError: null, warnings: [],
      });
    } else if (method === 'GET' && path === '/settings') {
      json(res, 200, { config: state.config, secrets: state.secrets, secretsReady: true });
    } else if (method === 'POST' && path === '/settings') {
      const body = JSON.parse((await readBody(req)).toString() || '{}') as { config?: Record<string, unknown>; secrets?: Record<string, string | null> };
      Object.assign(state.config, body.config || {});
      for (const [k, v] of Object.entries(body.secrets || {})) state.secrets[k] = v ? { set: true, hint: v.slice(-4) } : { set: false, hint: '' };
      json(res, 200, { ok: true });
    } else if (method === 'GET' && path === '/files') {
      json(res, 200, { files: state.files });
    } else if (method === 'POST' && path === '/files') {
      const raw = (await readBody(req)).toString('latin1');
      const names = [...raw.matchAll(/filename="([^"]+)"/g)].map((m) => m[1]);
      for (const name of names) {
        state.files = [...state.files.filter((f) => f.name !== name), { name, size: Math.round(raw.length / Math.max(1, names.length)), modified: new Date().toISOString(), ...(name.endsWith('.zip') ? { entries: ['a.pdf', 'b.pdf'] } : {}) }];
      }
      await sleep(300);
      emit('state', {});
      json(res, 200, { added: names, rejected: [] });
    } else if (method === 'DELETE' && path.startsWith('/files/')) {
      const name = decodeURIComponent(path.slice('/files/'.length));
      state.files = state.files.filter((f) => f.name !== name);
      json(res, 200, { ok: true, name });
    } else if (method === 'POST' && path === '/run') {
      if (state.running) { json(res, 409, { error: 'A run is already in progress.' }); return; }
      const body = JSON.parse((await readBody(req)).toString() || '{}') as Record<string, unknown>;
      const commit = (body.commit || {}) as { enabled?: boolean };
      if (commit.enabled && !sinkConfigured) { json(res, 422, { error: 'Commit is not set up: add the downstream system address and an access token, or turn the commit off.' }); return; }
      void runPipeline(body);
      json(res, 202, { started: true, campaignType: body.campaignType, parallel: body.parallel });
    } else if (method === 'POST' && path === '/cancel') {
      if (!state.running) { json(res, 409, { error: 'No run is in progress.' }); return; }
      state.cancelled = true;
      emit('log', { level: 'info', message: 'Cancel requested.' });
      json(res, 202, { cancelling: true });
    } else if (method === 'POST' && path === '/commit/retry') {
      state.commit = { ...state.commit, status: 'done', lastError: '', counts: { created: 3, skipped: 0 } };
      json(res, 200, state.commit);
    } else if (method === 'GET' && path === '/results') {
      json(res, 200, { available: state.lastRun !== null, summary: state.lastRun, rows: state.lastRows, csvAvailable: state.lastRows.length > 0 });
    } else if (method === 'GET' && path === '/results.csv') {
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
      res.end(csv());
    } else if (method === 'POST' && path === '/open') {
      json(res, 200, { ok: true });
    } else if (method === 'GET' && path === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const after = Number(req.headers['last-event-id'] || url.searchParams.get('lastEventId') || 0) || 0;
      res.write('retry: 3000\n\n');
      for (const frame of frames) if (frame.id > after) write(res, frame);
      clients.add(res);
      const beat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
      req.on('close', () => { clearInterval(beat); clients.delete(res); });
    } else {
      json(res, 405, { error: 'Method not allowed.' });
    }
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : 'Mock server error.' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock intake server on http://127.0.0.1:${PORT} (scenario: ${SCENARIO}${SCENARIO === 'auth' ? `, token: ${TOKEN}` : ''})`);
});
