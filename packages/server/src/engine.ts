/**
 * The engine: workspace folders, settings, the run lifecycle (one run at a time), the ingestion commit and the
 * event bus. The HTTP layer (http.ts) is a thin shell around it.
 */
import fs from "node:fs";
import path from "node:path";
import { createAuthenticator, DEFAULT_ALLOWED_ORIGINS, type Authenticator } from "./auth";
import type { EventSink, RunContext, RunOptions, RunResult, WorkspaceDirs } from "@intake/core";
import { EventBus, redact } from "./events";
import { createLogger, silentLogger, type Logger } from "./logger";
import { configDir as defaultConfigDir, configFile, dataDir as defaultDataDir, ensureDataDirs, type DataDirs } from "./paths";
import { ConfigStore, createSecretStore, SecretStore, SettingsRejected, SettingsStore, validateLlmBaseUrl, validateSinkBase } from "./settings-store";
import { Committer, parseRequest, type CommitRequest, type FetchLike, type Row } from "./sink-commit";
import { DEFAULT_LIMITS, HttpError, inputEntries, uniqueIn, type Limits } from "./uploads";
import { APP_ID, PROTOCOL, VERSION } from "./version";

export const HEARTBEAT_MS = 15_000;
const TERMINAL = new Set(["done", "failed", "cancelled"]);

export class PipelineUnavailable extends Error {}

export type Runner = (ctx: RunContext) => Promise<RunResult> | RunResult;

export interface EngineOptions {
  /** Workspace folder (default: INTAKE_DATA_DIR or ./.intake-data). */
  dataRoot?: string;
  /** Where config.json and the secret vault live (default: INTAKE_CONFIG_DIR or <data>/.config). */
  configDir?: string;
  secretStore?: SecretStore;
  auth?: Authenticator;
  allowedOrigins?: readonly string[];
  /** Host names the Host header may carry. null: no check (hosted modes behind a proxy). Default: loopback names. */
  allowedHosts?: readonly string[] | null;
  heartbeatMs?: number;
  /** Replaces @intake/core's runBatch (tests, demos). */
  runner?: Runner;
  limits?: Partial<Limits>;
  fetch?: FetchLike;
  /** Built web UI folder served at "/" (null: none). */
  webDir?: string | null;
  /** POST /open may open a folder in the OS file manager (local mode only). */
  enableOpenFolder?: boolean;
  openPath?: (folder: string) => Promise<void>;
  /** POST /shutdown stops the server. */
  enableShutdown?: boolean;
  logger?: Logger;
  env?: NodeJS.ProcessEnv;
}

export const nowIso = (date = new Date()): string => date.toISOString().replace(/\.\d{3}Z$/, "+00:00");

export interface RunSummary {
  phase: string;
  finishedAt: string;
  rows?: number;
  counts?: Record<string, number>;
  cost?: unknown;
  failedFiles?: unknown[];
  detail?: string;
}

export function summariseResult(result: RunResult | null | undefined, phase: string): RunSummary {
  return {
    phase,
    finishedAt: nowIso(),
    rows: (result?.rows ?? []).length,
    counts: result?.counts ?? {},
    cost: result?.cost ?? null,
    failedFiles: result?.failedFiles ?? [],
  };
}

/** The server's side of POST /run: validate the body into run options, or throw HttpError(400). */
export function validateRunOptions(body: unknown, config: Record<string, unknown>): RunOptions & { commit: CommitRequest | null; inputs: string[] } {
  if (body === undefined || body === null) body = {};
  if (typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "The run options must be a JSON object.");
  const b = body as Record<string, unknown>;

  const text = (key: string, limit: number, fallback = ""): string => {
    const value = key in b ? b[key] : fallback;
    if (value === null || value === undefined) return fallback;
    if (typeof value !== "string" || Array.from(value).length > limit) throw new HttpError(400, `${key} is not valid.`);
    return value;
  };
  const flag = (key: string, fallback: boolean): boolean => {
    const value = key in b ? b[key] : fallback;
    if (typeof value !== "boolean") throw new HttpError(400, `${key} must be true or false.`);
    return value;
  };
  const number = (key: string, fallback: number, low: number, high: number): number => {
    const value = key in b ? b[key] : fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || !(low <= value && value <= high)) {
      throw new HttpError(400, `${key} must be a number from ${low} to ${high}.`);
    }
    return value;
  };

  const rawInputs = b.inputs;
  if (rawInputs !== undefined && rawInputs !== null) {
    if (
      !Array.isArray(rawInputs) ||
      rawInputs.length > 500 ||
      rawInputs.some((n) => typeof n !== "string" || !n || Array.from(n).length > 255 || n.includes("..") || n.includes("\\"))
    ) {
      throw new HttpError(400, "inputs must be a list of up to 500 file names from the input folder.");
    }
  }
  const inputs = [...((rawInputs as string[] | undefined | null) ?? [])];
  let commit: CommitRequest | null;
  try {
    commit = parseRequest(b.commit);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  const jd = b.jd;
  if (jd !== undefined && jd !== null && (typeof jd !== "string" || Array.from(jd).length > 200_000)) throw new HttpError(400, "jd is not valid.");
  const configuredParallel = config.maxConcurrency;
  const defaultParallel = Number.isInteger(configuredParallel) && (configuredParallel as number) >= 1 && (configuredParallel as number) <= 16 ? (configuredParallel as number) : 5;
  const configuredThreshold = config.jdThreshold;
  const defaultThreshold = typeof configuredThreshold === "number" ? configuredThreshold : 0;
  return {
    campaignType: text("campaignType", 120, String(config.defaultCampaignType || "")),
    platform: text("platform", 120),
    jd: (jd as string | null | undefined) || "",
    parallel: Math.trunc(number("parallel", defaultParallel, 1, 16)),
    dryRun: flag("dryRun", Boolean(config.jdDryRun)),
    jdFilter: flag("jdFilter", Boolean(config.jdFilterEnabled)),
    jdThreshold: number("jdThreshold", defaultThreshold, 0, 100),
    driveFolderId: text("driveFolderId", 200),
    inputs,
    commit,
  };
}

/** Duplicates the pipeline dropped before sending: the same person twice, or the same file bytes twice. */
export function inBatchDuplicatesOf(result: RunResult | null | undefined): number {
  const counts = (result?.counts ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => Math.trunc(Number(v) || 0);
  return n(counts.in_batch_duplicates ?? counts.inBatchDuplicates) + n(counts.duplicate_content ?? counts.duplicateContent);
}

export class Engine {
  readonly dirs: DataDirs;
  readonly dataRoot: string;
  readonly configDir: string;
  readonly settings: SettingsStore;
  readonly auth: Authenticator;
  readonly allowedOrigins: readonly string[];
  readonly allowedHosts: readonly string[] | null;
  readonly heartbeatMs: number;
  readonly limits: Limits;
  readonly bus = new EventBus();
  readonly committer: Committer;
  readonly log: Logger;
  readonly webDir: string | null;
  readonly enableOpenFolder: boolean;
  readonly enableShutdown: boolean;
  readonly openPath: (folder: string) => Promise<void>;
  readonly runner: Runner | undefined;

  stopping = false;
  phase = "idle";
  runActive = false;
  currentCancel: AbortController | null = null;
  runPromise: Promise<void> | null = null;
  lastResult: RunResult | null = null;
  lastSummary: RunSummary | null = null;
  /** Set by the HTTP layer once it listens. */
  port: number | null = null;
  serving = false;
  /** Called by POST /shutdown and by shutdown(): the HTTP layer closes the listener. */
  onStop: (() => Promise<void>) | null = null;
  /** The commit of the last finished run, for POST /commit/retry. */
  lastCommitRequest: CommitRequest | null = null;
  /** The last run's input files, moved to processed/ once it succeeded. */
  pendingArchive: string[] = [];
  private pipelineEnd: { phase?: string; detail?: string } = {};

  constructor(options: EngineOptions = {}) {
    const env = options.env ?? process.env;
    this.dataRoot = path.resolve(options.dataRoot ?? defaultDataDir(env));
    this.dirs = ensureDataDirs(this.dataRoot);
    this.configDir = path.resolve(options.configDir ?? defaultConfigDir(this.dataRoot, env));
    this.log = options.logger ?? silentLogger;
    const store = options.secretStore ?? createSecretStore(this.configDir, env);
    this.settings = new SettingsStore(new ConfigStore(configFile(this.configDir), (m) => this.log.warn(m)), store);
    this.settings.load();
    this.auth = options.auth ?? createAuthenticator({ mode: "none" });
    this.allowedOrigins = options.allowedOrigins ?? this.configuredOrigins();
    this.allowedHosts = options.allowedHosts === undefined ? (this.auth.mode === "none" ? ["127.0.0.1", "localhost"] : null) : options.allowedHosts;
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
    this.webDir = options.webDir ?? null;
    this.enableOpenFolder = options.enableOpenFolder ?? this.auth.mode === "none";
    this.enableShutdown = options.enableShutdown ?? this.auth.mode === "none";
    this.openPath = options.openPath ?? defaultOpenPath;
    this.runner = options.runner;
    this.committer = new Committer((type, data) => this.emit(type, data), options.fetch ?? fetch, (m) => this.log.warn(m));
  }

  private configuredOrigins(): readonly string[] {
    const raw = this.settings.config.engine.allowedOrigins;
    if (Array.isArray(raw) && raw.length && raw.every((o) => typeof o === "string" && /^https?:\/\/[^/\s]+$/.test(o))) return raw as string[];
    if (raw !== undefined) this.log.warn("config.json engine.allowedOrigins is not a valid list; the defaults are used");
    return DEFAULT_ALLOWED_ORIGINS;
  }

  queueCounts(): { pdfs: number; zips: number; rosters: number } {
    const counts = { pdfs: 0, zips: 0, rosters: 0 };
    for (const name of inputEntries(this.dirs.input)) {
      if (name.startsWith(".") || !isFileSafe(path.join(this.dirs.input, name))) continue;
      const ext = path.extname(name).toLowerCase();
      if (ext === ".pdf") counts.pdfs += 1;
      else if (ext === ".zip") counts.zips += 1;
      else if (ext === ".xlsx" || ext === ".csv") counts.rosters += 1;
    }
    return counts;
  }

  stateSnapshot(): Record<string, unknown> {
    const presence = this.settings.secrets.presence();
    const googleOk = presence.googleTokenJson;
    return {
      ...this.settings.view(),
      version: VERSION,
      phase: this.phase,
      running: this.runActive,
      queue: this.queueCounts(),
      lastRun: this.lastSummary,
      settingsLoaded: Object.keys(this.settings.settings).length > 0,
      google: { ok: googleOk, reason: googleOk ? "" : "Google sign-in is not set up yet." },
      llm: { ok: presence.openrouterApiKey },
      commit: this.committer.snapshot(this.commitConfigured()),
      configError: this.settings.configError,
      warnings: [...this.settings.secrets.warnings],
      secretStore: this.settings.secrets.backendName(),
    };
  }

  helloPayload(): Record<string, unknown> {
    return {
      app: APP_ID,
      version: VERSION,
      protocol: PROTOCOL,
      port: this.port,
      dataDir: this.dataRoot,
      commitConfigured: this.commitConfigured(),
      auth: this.auth.mode,
    };
  }

  /** The file `name` directly inside input/, or null. Nothing with a separator, a dot prefix or a link. */
  inputChild(name: unknown): string | null {
    if (typeof name !== "string" || !name || name.startsWith(".") || name === "." || name === "..") return null;
    if (/[/\\:\0]/.test(name)) return null;
    const candidate = path.join(this.dirs.input, name);
    if (path.dirname(candidate) !== this.dirs.input) return null;
    try {
      if (fs.lstatSync(candidate).isSymbolicLink() || !fs.statSync(candidate).isFile()) return null;
    } catch {
      return null;
    }
    return candidate;
  }

  /** The last run's CSV, only when it exists inside the workspace. */
  resultCsvPath(): string | null {
    const raw = this.lastResult?.csvPath;
    if (!raw) return null;
    try {
      const file = fs.realpathSync(raw);
      const root = fs.realpathSync(this.dataRoot);
      const rel = path.relative(root, file);
      if (!fs.statSync(file).isFile() || rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
      return file;
    } catch {
      return null;
    }
  }

  emit(type: string, data: Record<string, unknown> = {}) {
    if (type === "phase" && "phase" in data) this.phase = String(data.phase);
    return this.bus.publish(type, data);
  }

  newRunContext(options: RunOptions): { ctx: RunContext; controller: AbortController } {
    this.pipelineEnd = {};
    const controller = new AbortController();
    const emit: EventSink = (event) => {
      // The pipeline announces its own end before the run is over (no counts, the run flag still set). Only the worker
      // announces the end, once, with the counts and after the engine is free, so a client can start the next run.
      if (event.type === "phase" && TERMINAL.has(String(event.data.phase))) {
        this.pipelineEnd = { phase: String(event.data.phase), detail: String(event.data.detail ?? "") };
        return;
      }
      this.emit(event.type, event.data as unknown as Record<string, unknown>);
    };
    const { input, output, old, database, logs } = this.dirs;
    const dirs: WorkspaceDirs = { input, output, old, database, logs, cache: path.join(this.dataRoot, ".cache") };
    const ctx: RunContext = {
      dirs,
      config: structuredClone(this.settings.settings),
      secrets: this.settings.secretSnapshot(),
      options: { ...options },
      emit,
      cancelled: controller.signal,
    };
    return { ctx, controller };
  }

  async runWorker(ctx: RunContext, runner: Runner): Promise<void> {
    const commitRequest = (ctx.options.commit ?? null) as CommitRequest | null;
    let result: RunResult | null = null;
    let final: Record<string, unknown>;
    try {
      this.emit("phase", { phase: "preparing" });
      result = await runner(ctx);
      const error = result?.error;
      const end = this.pipelineEnd;
      let phase: string;
      if (ctx.cancelled.aborted) phase = "cancelled";
      else if (error || end.phase === "failed") phase = "failed";
      else phase = "done";
      const summary = summariseResult(result, phase);
      this.lastResult = result;
      this.lastSummary = summary;
      final = { phase, counts: summary.counts, cost: summary.cost };
      if (phase === "failed") final.detail = redact(String(error || end.detail || "The run failed.")).slice(0, 300);
      else if (end.detail) final.detail = end.detail;
      if (phase === "failed") summary.detail = final.detail as string; // the poll fallback in the page reads it from /state
    } catch (err) {
      const message = err instanceof Error ? err.message || err.name : String(err);
      const detail = redact(message).slice(0, 300);
      this.log.error(`run failed: ${detail}`);
      this.lastSummary = { phase: "failed", finishedAt: nowIso(), detail };
      final = { phase: "failed", detail };
    }
    try {
      await this.finishCommit(commitRequest, String(final.phase), result); // never throws: the committer records errors
    } catch {
      this.log.error("ingestion commit step crashed");
    }
    this.runActive = false; // free the engine first, then announce the end
    this.currentCancel = null;
    this.emit("phase", final);
  }

  /** (base URL, ingestion token) as saved. The token is read from the secret store and never logged. */
  commitTarget(): [unknown, unknown] {
    return [this.settings.settings.crmBaseUrl, this.settings.secretSnapshot().ingestionToken];
  }

  commitConfigured(): boolean {
    const [base, token] = this.commitTarget();
    try {
      validateSinkBase(base);
    } catch (err) {
      if (err instanceof SettingsRejected) return false;
      throw err;
    }
    return Boolean(token);
  }

  /** Move the given input files into processed/. Never deletes: a name clash gets a number. Returns the count. */
  archiveProcessed(files: readonly string[]): number {
    let sourceRoot: string;
    try {
      sourceRoot = fs.realpathSync(this.dirs.input);
    } catch {
      return 0;
    }
    let moved = 0;
    for (const raw of files) {
      try {
        if (fs.lstatSync(raw).isSymbolicLink() || !fs.statSync(raw).isFile()) continue;
        const rel = path.relative(sourceRoot, fs.realpathSync(raw));
        if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
        const target = uniqueIn(this.dirs.processed, path.basename(raw));
        try {
          fs.renameSync(raw, target);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
          fs.copyFileSync(raw, target);
          fs.unlinkSync(raw);
        }
        moved += 1;
      } catch {
        this.log.warn("a processed input file could not be moved; it stays in input/");
      }
    }
    return moved;
  }

  /** Archive the last finished run's files, once its commit (or the run itself, with commit off) has succeeded. */
  archivePending(): void {
    const files = this.pendingArchive;
    this.pendingArchive = [];
    if (files.length) this.archiveProcessed(files);
  }

  /** Run the commit for a finished run. Called by the worker while the run still holds the engine. The run's input files
   * move to processed/ only after success: at once with commit off, after the commit otherwise (a failed commit keeps
   * them, with the CSV, until a retry succeeds). */
  private async finishCommit(request: CommitRequest | null, phase: string, result: RunResult | null): Promise<void> {
    this.lastCommitRequest = null;
    this.pendingArchive = phase === "done" ? [...(result?.processed ?? [])] : [];
    if (!request || !request.enabled) {
      if (phase === "done") this.archivePending();
      return;
    }
    if (phase !== "done") {
      this.committer.skip(); // a failed or cancelled run is not committed; its CSV is kept as before
      return;
    }
    this.lastCommitRequest = { ...request };
    const [base, token] = this.commitTarget();
    await this.committer.run(base, token, request, (result?.rows ?? []) as Row[], inBatchDuplicatesOf(result));
    if (this.committer.status === "done") this.archivePending();
  }

  /** Start a run in the background. The caller has validated the request; this checks the engine is free. */
  startRun(options: ReturnType<typeof validateRunOptions>, runner: Runner): void {
    const commit = options.commit;
    if (this.runActive) throw new HttpError(409, "A run is already in progress.");
    const { ctx, controller } = this.newRunContext(options);
    this.runActive = true;
    this.currentCancel = controller;
    this.phase = "preparing";
    this.committer.beginRun(Boolean(commit && commit.enabled));
    this.runPromise = this.runWorker(ctx, runner);
  }

  async resolveRunner(): Promise<Runner> {
    if (this.runner) return this.runner;
    let mod: { runBatch?: unknown };
    try {
      mod = await import("@intake/core");
    } catch (err) {
      throw new PipelineUnavailable(`The extraction pipeline is not installed in this build (${redact(err instanceof Error ? err.message : String(err))}).`);
    }
    if (typeof mod.runBatch !== "function") throw new PipelineUnavailable("The extraction pipeline has no runBatch entry point.");
    return mod.runBatch as Runner;
  }

  llmUrlProblem(): string | null {
    const url = this.settings.settings.llmBaseUrl;
    if (url === undefined || url === null || url === "") return null;
    try {
      validateLlmBaseUrl(url);
    } catch (err) {
      if (err instanceof SettingsRejected) return err.message;
      throw err;
    }
    return null;
  }

  /** Graceful stop: cancel the running batch, wait for it (up to 20 s), close streams, stop the listener. */
  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.currentCancel?.abort();
    const running = this.runPromise;
    if (running && this.runActive) {
      await Promise.race([running.catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, 20_000).unref())]);
    }
    this.bus.close();
    if (this.onStop) await this.onStop();
  }
}

function isFileSafe(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

async function defaultOpenPath(folder: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [folder], { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** An engine for the production entry point: logs to <data>/logs/engine.log and stderr. */
export function createEngine(options: EngineOptions = {}): Engine {
  const env = options.env ?? process.env;
  const root = path.resolve(options.dataRoot ?? defaultDataDir(env));
  const dirs = ensureDataDirs(root);
  return new Engine({ ...options, logger: options.logger ?? createLogger({ logsDir: dirs.logs }), dataRoot: root });
}
