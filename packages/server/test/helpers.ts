/** Shared test helpers: a real server on an ephemeral 127.0.0.1 port, signed tokens, a throw-away data folder. */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { createAuthenticator, type Authenticator } from "../src/auth";
import type { RunContext, RunResult } from "@intake/core";
import { Engine, type EngineOptions } from "../src/engine";
import { createHttpServer, listen } from "../src/http";
import { SecretStore, type Vault } from "../src/settings-store";

export const ORIGIN = "https://app.example.test";
export const AUDIENCE = "resume-intake";

export class MemoryVault implements Vault {
  items = new Map<string, string>();
  get(name: string) {
    return this.items.get(name) ?? null;
  }
  put(name: string, value: string) {
    this.items.set(name, value);
  }
  remove(name: string) {
    this.items.delete(name);
  }
}

export const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

export interface Signer {
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
}

export function makeSigner(): Signer {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return { privateKey, publicKey };
}

/** Same format a downstream issuer produces: base64url(JSON) "." base64url(signature over the payload text). */
export function signClaims(signer: Signer, claims: Record<string, unknown>): string {
  const payload = b64url(JSON.stringify(claims));
  return `${payload}.${b64url(crypto.sign(null, Buffer.from(payload, "ascii"), signer.privateKey))}`;
}

export function claimsFor(over: Record<string, unknown> = {}, expIn = 900): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: AUDIENCE, sub: "operator@example.test", role: "admin", iat: now, exp: now + expIn, ...over };
}

export interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  json(): any;
  text(): string;
}

export interface RequestOptions {
  token?: string | null;
  origin?: string | null;
  json?: unknown;
  data?: Buffer | string;
  contentType?: string;
  headers?: Record<string, string>;
  timeout?: number;
}

export function request(port: number, method: string, urlPath: string, options: RequestOptions = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.origin !== null) headers.Origin = options.origin ?? ORIGIN;
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    let body: Buffer | undefined;
    if (options.json !== undefined) {
      body = Buffer.from(JSON.stringify(options.json));
      headers["Content-Type"] ??= "application/json";
    } else if (options.data !== undefined) {
      body = Buffer.from(options.data);
    }
    if (options.contentType) headers["Content-Type"] = options.contentType;
    if (body) headers["Content-Length"] = String(body.length);
    else if (method === "POST") headers["Content-Length"] = "0";
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers, agent: false, timeout: options.timeout ?? 10_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf, json: () => JSON.parse(buf.toString("utf8")), text: () => buf.toString("utf8") });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    if (body) req.write(body);
    req.end();
  });
}

export function pdfResult(over: Partial<RunResult> = {}): RunResult {
  return {
    rows: [{ file: "a.pdf", name: "Asha Rao", score: 82 }],
    csvPath: null,
    counts: { ok: 1, failed: 0 },
    cost: { tokens: 1234, usd: 0.0123 },
    failedFiles: [],
    cancelled: false,
    error: null,
    retryPath: null,
    runId: "run-test",
    processed: [],
    ...over,
  };
}

export type TestRunner = (ctx: RunContext) => Promise<RunResult> | RunResult;

export class Running {
  runner: TestRunner = () => pdfResult();
  constructor(
    readonly engine: Engine,
    readonly server: http.Server,
    readonly port: number,
    readonly root: string,
    readonly signer: Signer,
    readonly token: string,
  ) {}

  get(p: string, o: RequestOptions = {}) {
    return request(this.port, "GET", p, o);
  }
  post(p: string, o: RequestOptions = {}) {
    return request(this.port, "POST", p, o);
  }
  delete(p: string, o: RequestOptions = {}) {
    return request(this.port, "DELETE", p, o);
  }
  /** Request options carrying the valid token. */
  authed(o: RequestOptions = {}): RequestOptions {
    return { token: this.token, ...o };
  }
  get inputDir() {
    return this.engine.dirs.input;
  }
  get sinkRunning() {
    return this.engine.runActive;
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});
export const onCleanup = (fn: () => Promise<void> | void) => cleanups.push(fn);

export function tempDir(prefix = "intake-server-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  onCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export interface StartOptions extends Partial<EngineOptions> {
  root?: string;
  signer?: Signer;
  auth?: Authenticator;
  runner?: TestRunner;
}

/** A running server in signed-token mode (the interesting one), with an injectable runner. */
export async function startServer(options: StartOptions = {}): Promise<Running> {
  const root = options.root ?? tempDir();
  const signer = options.signer ?? makeSigner();
  const auth = options.auth ?? createAuthenticator({ mode: "signed", publicKey: signer.publicKey, audience: AUDIENCE });
  let holder: Running | null = null;
  const { root: _r, signer: _s, ...engineOptions } = options;
  const engine = new Engine({
    dataRoot: path.join(root, "Data"),
    configDir: path.join(root, "AppData"),
    secretStore: new SecretStore(new MemoryVault()),
    auth,
    allowedOrigins: [ORIGIN, "http://localhost:5173"],
    allowedHosts: ["127.0.0.1", "localhost"],
    heartbeatMs: 200,
    webDir: null,
    runner: (ctx) => (holder as Running).runner(ctx),
    ...engineOptions,
  });
  const server = createHttpServer(engine);
  const port = await listen(engine, server, { ports: [0] });
  const token = signClaims(signer, claimsFor());
  holder = new Running(engine, server, port, root, signer, token);
  if (options.runner) holder.runner = options.runner;
  onCleanup(async () => {
    await engine.shutdown();
  });
  return holder;
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function multipart(parts: Array<[string, string | null, Buffer | string]>, boundary = "BOUNDARY123"): { body: Buffer; contentType: string } {
  const chunks: Buffer[] = [];
  for (const [name, filename, content] of parts) {
    let disposition = `form-data; name="${name}"`;
    if (filename !== null) disposition += `; filename="${filename}"`;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\nContent-Type: application/octet-stream\r\n\r\n`, "utf8"), Buffer.from(content), Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export const PDF = Buffer.concat([Buffer.from("%PDF-1.4 test resume\n"), Buffer.alloc(200, "x")]);
