/**
 * HTTP API of the server (node:http only).
 *
 * Routes (same as the reference engine, minus /update/*):
 *   GET /hello  GET /state  POST /settings  GET|POST /files  DELETE /files/<name>  POST /run  POST /cancel
 *   POST /commit/retry  GET /events (SSE)  GET /results  GET /results.csv  POST /open  POST /shutdown
 * Every route except GET /hello needs credentials according to the auth mode (none | token | signed). Browsers must come
 * from an allowed Origin (exact match, `null` is refused; the page's own origin is always allowed); CORS answers reflect
 * that origin and never `*`. Anything else that is a GET is looked up in the built web UI (when present).
 */
import fs from "node:fs";
import http from "node:http";
import type { Duplex } from "node:stream";
import { bearerToken, originStatus, type Claims } from "./auth";
import { Engine, inBatchDuplicatesOf, nowIso, PipelineUnavailable, validateRunOptions } from "./engine";
import { redact } from "./events";
import { ConfigUnreadable, SettingsInvalid, SettingsRejected, splitUrl } from "./settings-store";
import { serveStatic } from "./static";
import {
  BOUNDARY,
  Budget,
  checkRunLimits,
  displayName,
  HttpError,
  inputEntries,
  maxRequestBytes,
  MB,
  MultipartError,
  RunLimitExceeded,
  sanitiseUploadName,
  sizeOf,
  streamMultipart,
  undoAdded,
  UploadNameError,
  UploadSink,
  UploadTooLarge,
  visibleFiles,
  zipMemberNames,
  type UploadResult,
} from "./uploads";
import path from "node:path";

export const PORT_START = 47831;
export const PORT_END = 47840;
export const JSON_LIMIT = 2 * MB;
export const PREFLIGHT_MAX_AGE = 600;
const DRAIN_LIMIT = 64 * 1024;

type AuthKind = "none" | "bearer" | "bearer_or_query";
type HandlerName =
  | "hello" | "state" | "settings" | "getSettings" | "listFiles" | "uploadFiles" | "run" | "cancel" | "commitRetry"
  | "events" | "results" | "resultsCsv" | "openFolder" | "shutdown" | "deleteFile";

const ROUTES: Record<string, [HandlerName, AuthKind]> = {
  "GET /hello": ["hello", "none"],
  "GET /state": ["state", "bearer"],
  "GET /settings": ["getSettings", "bearer"],
  "POST /settings": ["settings", "bearer"],
  "GET /files": ["listFiles", "bearer"],
  "POST /files": ["uploadFiles", "bearer"],
  "POST /run": ["run", "bearer"],
  "POST /cancel": ["cancel", "bearer"],
  "POST /commit/retry": ["commitRetry", "bearer"],
  "GET /events": ["events", "bearer_or_query"],
  "GET /results": ["results", "bearer"],
  "GET /results.csv": ["resultsCsv", "bearer"],
  "POST /open": ["openFolder", "bearer"],
  "POST /shutdown": ["shutdown", "bearer"],
};
const KNOWN_PATHS = new Set(Object.keys(ROUTES).map((key) => key.slice(key.indexOf(" ") + 1)));

/** Per-request state. */
export class Ctx {
  cors: string | null = null;
  headersSent = false;
  /** unread: the body was not touched; partial: reading stopped early; consumed: read completely. */
  body: "unread" | "partial" | "consumed" = "unread";
  readonly rawPath: string;
  readonly query: URLSearchParams;

  constructor(readonly req: http.IncomingMessage, readonly res: http.ServerResponse, readonly engine: Engine) {
    const target = req.url ?? "/";
    const q = target.indexOf("?");
    this.rawPath = q === -1 ? target : target.slice(0, q);
    this.query = new URLSearchParams(q === -1 ? "" : target.slice(q + 1));
  }

  header(name: string): string | undefined {
    const value = this.req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }
}

function sameOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  const match = /^https?:\/\/([^/\s]+)$/i.exec(origin);
  return match !== null && (match[1] as string).toLowerCase() === host.toLowerCase();
}

function hostAllowed(engine: Engine, host: string | undefined): boolean {
  if (engine.allowedHosts === null) return true;
  if (!host) return false;
  try {
    const name = splitUrl("//" + host).hostname;
    return name !== null && engine.allowedHosts.includes(name);
  } catch {
    return false;
  }
}

function corsHeaders(ctx: Ctx): Record<string, string> {
  if (ctx.cors === null) return {};
  return {
    "Access-Control-Allow-Origin": ctx.cors,
    Vary: "Origin",
    "Access-Control-Expose-Headers": "Content-Disposition, Content-Length",
  };
}

function sendBytes(ctx: Ctx, status: number, body: Buffer | string, contentType: string, extra: Record<string, string> = {}): void {
  if (ctx.headersSent) return;
  const payload = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const declared = Number(ctx.header("content-length") ?? 0);
  const unread = ctx.body !== "consumed" && (Boolean(ctx.header("transfer-encoding")) || declared > DRAIN_LIMIT || ctx.body === "partial");
  const headers: Record<string, string | number> = {
    "Content-Type": contentType,
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...corsHeaders(ctx),
    ...extra,
  };
  if (unread) headers.Connection = "close";
  ctx.res.writeHead(status, headers);
  ctx.headersSent = true;
  ctx.res.end(payload);
}

function sendJson(ctx: Ctx, status: number, payload: unknown, extra: Record<string, string> = {}): void {
  sendBytes(ctx, status, JSON.stringify(payload), "application/json; charset=utf-8", extra);
}

function sendError(ctx: Ctx, err: HttpError): void {
  sendJson(ctx, err.status, { error: err.message, ...err.extra });
}

function preflight(ctx: Ctx): void {
  if (ctx.cors === null) return sendBytes(ctx, 204, "", "text/plain");
  sendBytes(ctx, 204, "", "text/plain", {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": String(PREFLIGHT_MAX_AGE),
  });
}

// ── request bodies ──────────────────────────────────────────────────────────────────────────────────────────────
function contentLength(ctx: Ctx, limit: number): number {
  if (ctx.header("transfer-encoding")) throw new HttpError(411, "Chunked request bodies are not supported.");
  const raw = ctx.header("content-length");
  if (raw === undefined) throw new HttpError(411, "Content-Length is required.");
  if (!/^\s*[+-]?\d+\s*$/.test(raw)) throw new HttpError(400, "Content-Length is not a number.");
  const length = Number(raw);
  if (length < 0) throw new HttpError(400, "Content-Length is not valid.");
  if (length > limit) throw new HttpError(413, "The request is too large.");
  return length;
}

async function readJsonBody(ctx: Ctx, allowEmpty = false, limit = JSON_LIMIT): Promise<unknown> {
  const length = contentLength(ctx, limit);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    if (length > 0) {
      for await (const chunk of ctx.req) {
        chunks.push(chunk as Buffer);
        total += (chunk as Buffer).length;
      }
    }
  } catch {
    total = -1;
  }
  ctx.body = "consumed";
  if (total !== length) throw new HttpError(400, "The request body is incomplete.");
  if (length === 0) {
    if (allowEmpty) return {};
    throw new HttpError(400, "A JSON body is required.");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new HttpError(400, "The body is not valid JSON.");
  }
}

function drainBody(ctx: Ctx): void {
  if (ctx.body !== "unread") return;
  const declared = Number(ctx.header("content-length") ?? 0);
  if (declared > 0 && declared <= DRAIN_LIMIT) ctx.req.resume();
  ctx.body = "consumed";
}

// ── routes ──────────────────────────────────────────────────────────────────────────────────────────────────────
type Handler = (ctx: Ctx, arg: string | null, claims: Claims) => Promise<void> | void;

const handlers: Record<HandlerName, Handler> = {
  hello(ctx) {
    sendJson(ctx, 200, ctx.engine.helloPayload());
  },

  state(ctx) {
    sendJson(ctx, 200, ctx.engine.stateSnapshot());
  },

  getSettings(ctx) {
    sendJson(ctx, 200, ctx.engine.settings.view());
  },

  async settings(ctx) {
    const body = await readJsonBody(ctx);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "Send an object with config and/or secrets.");
    const { config, secrets } = body as Record<string, unknown>;
    try {
      const status = ctx.engine.settings.apply(config, secrets);
      sendJson(ctx, 200, { ok: true, ...status });
    } catch (err) {
      if (err instanceof SettingsRejected) throw new HttpError(422, err.message);
      if (err instanceof SettingsInvalid) throw new HttpError(400, err.message);
      if (err instanceof ConfigUnreadable) throw new HttpError(409, err.message);
      throw err;
    }
  },

  listFiles(ctx) {
    const folder = ctx.engine.dirs.input;
    const items: Array<Record<string, unknown>> = [];
    for (const name of inputEntries(folder)) {
      if (name.startsWith(".")) continue;
      const file = path.join(folder, name);
      let stat: fs.BigIntStats;
      try {
        stat = fs.statSync(file, { bigint: true });
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const item: Record<string, unknown> = {
        name,
        size: Number(stat.size),
        modified: nowIso(new Date(Number(stat.mtimeMs))),
      };
      // The names inside, so the page can show what a zip holds without opening it (null when it cannot be read).
      if (path.extname(name).toLowerCase() === ".zip") item.entries = zipMemberNames(file, Number(stat.size), stat.mtimeNs);
      items.push(item);
    }
    items.sort((a, b) => {
      const x = String(a.name).toLowerCase();
      const y = String(b.name).toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
    sendJson(ctx, 200, { files: items });
  },

  async uploadFiles(ctx) {
    const e = ctx.engine;
    const contentType = ctx.header("content-type") ?? "";
    const match = /^\s*multipart\/form-data/i.test(contentType) ? BOUNDARY.exec(contentType) : null;
    if (match === null) throw new HttpError(415, "Send the files as multipart/form-data.");
    const boundary = Buffer.from((match[1] ?? match[2]) as string, "latin1");
    const length = contentLength(ctx, maxRequestBytes(e.limits));
    const result: UploadResult = { added: [], rejected: [] };
    const sinks: UploadSink[] = [];
    // The folder may have been removed while the engine was idle (cleaned up by hand): make it again instead of failing the upload.
    fs.mkdirSync(e.dirs.input, { recursive: true });
    const present = visibleFiles(e.dirs.input);
    const budget = new Budget(present.length, present.reduce((sum, file) => sum + sizeOf(file), 0), e.limits);

    const onPart = async (_name: string | null, filename: string | null) => {
      if (filename === null) return null;
      let stem: string;
      let ext: string;
      try {
        [stem, ext] = sanitiseUploadName(filename);
      } catch (err) {
        if (!(err instanceof UploadNameError)) throw err;
        result.rejected.push({ name: displayName(filename), reason: err.message });
        return null;
      }
      budget.addFile();
      const sink = await UploadSink.create(e.dirs.input, stem, ext, result, budget, e.limits);
      sinks.push(sink);
      return sink;
    };

    ctx.body = "partial";
    try {
      await streamMultipart(ctx.req, length, boundary, onPart);
      ctx.body = "consumed";
    } catch (err) {
      if (err instanceof MultipartError) {
        await undoAdded(e.dirs.input, result);
        throw new HttpError(400, `The upload could not be read (${err.message}).`);
      }
      if (err instanceof UploadTooLarge || err instanceof RunLimitExceeded) {
        await undoAdded(e.dirs.input, result); // a refused upload leaves nothing behind from this request
        throw new HttpError(413, err.message);
      }
      throw err;
    } finally {
      for (const sink of sinks) await sink.abort();
    }
    if (!result.added.length && !result.rejected.length) throw new HttpError(400, "No files in the upload.");
    if (!result.added.length) throw new HttpError(400, "No file could be added.", { rejected: result.rejected });
    sendJson(ctx, 200, result);
  },

  deleteFile(ctx, name) {
    const file = ctx.engine.inputChild(name);
    if (file === null) throw new HttpError(404, "No such file in the input folder.");
    try {
      fs.unlinkSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, "No such file in the input folder.");
      throw err;
    }
    sendJson(ctx, 200, { ok: true, name: path.basename(file) });
  },

  async run(ctx) {
    const e = ctx.engine;
    const options = validateRunOptions(await readJsonBody(ctx, true), e.settings.settings);
    checkRunLimits(e.dirs.input, options.inputs, e.limits);
    const commit = options.commit;
    if (commit && commit.enabled && !e.commitConfigured()) {
      throw new HttpError(422, "CRM commit is not set up: add the CRM address and an ingestion token, or turn the commit off.");
    }
    const llmProblem = e.llmUrlProblem();
    if (llmProblem !== null) throw new HttpError(422, llmProblem);
    let runner;
    try {
      runner = await e.resolveRunner();
    } catch (err) {
      if (err instanceof PipelineUnavailable) throw new HttpError(503, err.message);
      throw err;
    }
    e.startRun(options, runner);
    sendJson(ctx, 202, { started: true, campaignType: options.campaignType, parallel: options.parallel });
  },

  cancel(ctx) {
    const e = ctx.engine;
    const cancel = e.runActive ? e.currentCancel : null;
    if (cancel === null) throw new HttpError(409, "No run is in progress.");
    cancel.abort();
    e.emit("log", { level: "info", message: "Cancel requested." });
    sendJson(ctx, 202, { cancelling: true });
  },

  /** Send the last finished run's rows to the downstream system again. Same key, so a commit that already went through is replayed. */
  async commitRetry(ctx) {
    const e = ctx.engine;
    if (e.runActive) throw new HttpError(409, "A run is in progress.");
    const request = e.lastCommitRequest;
    if (request === null || e.lastResult === null) throw new HttpError(409, "There is no finished run with a CRM commit to retry.");
    if (!e.commitConfigured()) throw new HttpError(422, "CRM commit is not set up: add the CRM address and an ingestion token first.");
    e.runActive = true; // hold the engine while the commit runs, as a run does
    try {
      const [base, token] = e.commitTarget();
      await e.committer.run(base, token, request, (e.lastResult.rows ?? []) as Array<Record<string, unknown>>, inBatchDuplicatesOf(e.lastResult));
      if (e.committer.status === "done") e.archivePending();
    } finally {
      e.runActive = false;
    }
    sendJson(ctx, 200, e.committer.snapshot(e.commitConfigured()));
  },

  async events(ctx) {
    const e = ctx.engine;
    const last = ctx.header("last-event-id") ?? ctx.query.get("lastEventId") ?? "0";
    const parsed = /^\s*[+-]?\d+\s*$/.test(last) ? Number(last) : 0;
    const after = Number.isSafeInteger(parsed) ? parsed : 0;
    const res = ctx.res;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(ctx),
    });
    ctx.headersSent = true;
    res.flushHeaders();
    const sub = e.bus.subscribe(after);
    let closed = false;
    res.once("close", () => {
      closed = true;
      sub.close();
    });
    const write = async (data: string) => {
      if (closed || res.destroyed) throw new Error("closed");
      if (!res.write(data)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            res.off("drain", done);
            res.off("close", done);
            resolve();
          };
          res.once("drain", done);
          res.once("close", done);
        });
      }
    };
    try {
      await write("retry: 3000\n\n");
      const frame = (event: { id: number; type: string }) => `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      for (const event of sub.replay) await write(frame(event));
      let lastWrite = Date.now();
      while (!e.stopping && !closed) {
        const wait = Math.max(0, lastWrite + e.heartbeatMs - Date.now());
        const event = await sub.get(wait);
        if (event === undefined) {
          await write(": heartbeat\n\n");
          lastWrite = Date.now();
          continue;
        }
        if (event === null) break; // bus closed, or this client fell behind: the page reconnects and replays
        await write(frame(event));
        lastWrite = Date.now();
      }
    } catch {
      /* the page went away */
    } finally {
      sub.close();
      if (!res.writableEnded && !res.destroyed) res.end();
    }
  },

  results(ctx) {
    const e = ctx.engine;
    const result = e.lastResult;
    sendJson(ctx, 200, {
      available: result !== null,
      summary: e.lastSummary,
      rows: result?.rows ?? [],
      csvAvailable: e.resultCsvPath() !== null,
    });
  },

  resultsCsv(ctx) {
    const file = ctx.engine.resultCsvPath();
    if (file === null) throw new HttpError(404, "There is no CSV from the last run.");
    sendBytes(ctx, 200, fs.readFileSync(file), "text/csv; charset=utf-8", { "Content-Disposition": 'attachment; filename="results.csv"' });
  },

  async openFolder(ctx) {
    const e = ctx.engine;
    const body = await readJsonBody(ctx);
    const target = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).target : undefined;
    const names = Object.keys(e.dirs);
    if (typeof target !== "string" || !names.includes(target)) {
      throw new HttpError(400, `Unknown folder: use ${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}.`);
    }
    if (!e.enableOpenFolder) throw new HttpError(501, "Opening folders is not available on this server.");
    const folder = e.dirs[target as keyof typeof e.dirs];
    fs.mkdirSync(folder, { recursive: true });
    try {
      await e.openPath(folder);
    } catch {
      throw new HttpError(500, "The folder could not be opened.");
    }
    sendJson(ctx, 200, { ok: true, target });
  },

  shutdown(ctx) {
    const e = ctx.engine;
    if (!e.enableShutdown) throw new HttpError(403, "Shutting down is not enabled on this server.");
    sendJson(ctx, 200, { ok: true, stopping: true });
    ctx.res.once("finish", () => setImmediate(() => void e.shutdown()));
  },
};

function resolveRoute(method: string, rawPath: string): { name: HandlerName; auth: AuthKind; arg: string | null } {
  const route = ROUTES[`${method} ${rawPath}`];
  if (route) return { name: route[0], auth: route[1], arg: null };
  if (method === "DELETE" && rawPath.startsWith("/files/") && rawPath.length > "/files/".length) {
    let arg: string;
    try {
      arg = decodeURIComponent(rawPath.slice("/files/".length));
    } catch {
      arg = "";
    }
    return { name: "deleteFile", auth: "bearer", arg };
  }
  if (KNOWN_PATHS.has(rawPath) || rawPath.startsWith("/files/")) throw new HttpError(405, "Method not allowed.");
  throw new HttpError(404, "Not found.");
}

async function dispatch(engine: Engine, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const ctx = new Ctx(req, res, engine);
  const method = (req.method ?? "GET").toUpperCase();
  res.once("finish", () => engine.log.info(`${req.socket.remoteAddress ?? "-"} ${method} ${redact(ctx.rawPath)} ${res.statusCode}`));
  try {
    const origin = ctx.header("origin");
    let state = originStatus(origin, engine.allowedOrigins);
    if (state === "denied" && origin && sameOrigin(origin, ctx.header("host"))) state = "allowed";
    if (state === "denied") throw new HttpError(403, "Origin not allowed.");
    if (state === "allowed") ctx.cors = origin ?? null;
    if (!hostAllowed(engine, ctx.header("host"))) throw new HttpError(403, "Host not allowed.");
    if (method === "OPTIONS") return preflight(ctx);

    let route;
    try {
      route = resolveRoute(method, ctx.rawPath);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404 && (method === "GET" || method === "HEAD") && (await serveStatic(ctx, engine.webDir))) return;
      throw err;
    }
    let claims: Claims = {};
    if (route.auth !== "none") {
      let token = bearerToken(ctx.header("authorization"));
      if (token === null && route.auth === "bearer_or_query") token = ctx.query.get("token");
      const found = engine.auth.authenticate(token);
      if (found === null) throw new HttpError(401, "Missing, expired or invalid access token.");
      claims = found;
    }
    await handlers[route.name](ctx, route.arg, claims);
  } catch (err) {
    if (err instanceof HttpError) sendError(ctx, err);
    else {
      engine.log.error(`unhandled error on ${method} ${redact(ctx.rawPath)}: ${err instanceof Error ? err.message : String(err)}`);
      sendError(ctx, new HttpError(500, "The server hit an internal error."));
    }
  } finally {
    drainBody(ctx);
  }
}

export { sendBytes, sendJson };

export function createHttpServer(engine: Engine): http.Server {
  const server = http.createServer({ maxHeaderSize: 65536 }, (req, res) => {
    void dispatch(engine, req, res);
  });
  server.requestTimeout = 0; // uploads of a whole batch can take minutes
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.on("clientError", (_err: Error, socket: Duplex) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    else socket.destroy();
  });
  return server;
}

export interface ListenOptions {
  host?: string;
  /** Ports to try in order (default 47831..47840). Port 0 means any free port (tests). */
  ports?: number[];
}

/** Bind `host` (default 127.0.0.1) on the first free port of `ports`. Resolves with the port. */
export async function listen(engine: Engine, server: http.Server, options: ListenOptions = {}): Promise<number> {
  const host = options.host ?? "127.0.0.1";
  const candidates = options.ports ?? Array.from({ length: PORT_END - PORT_START + 1 }, (_, i) => PORT_START + i);
  if (!candidates.length) throw new Error("no ports to try");
  let lastError: Error | null = null;
  for (const port of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once("error", onError);
        server.listen({ port, host, exclusive: true }, () => {
          server.off("error", onError);
          resolve();
        });
      });
    } catch (err) {
      lastError = err as Error;
      continue;
    }
    const address = server.address();
    engine.port = typeof address === "object" && address ? address.port : port;
    engine.serving = true;
    server.once("close", () => {
      engine.serving = false;
    });
    engine.onStop = () =>
      new Promise<void>((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeAllConnections();
      });
    return engine.port;
  }
  throw new Error(`No free port for the server between ${candidates[0]} and ${candidates[candidates.length - 1]} (${lastError?.message}).`);
}
