/**
 * Résumé extraction pipeline: the only entry point the server calls is `runBatch(ctx)` (port of pipeline/__init__.py).
 *
 * Stages
 *   1. discover input/ (PDF, zip, roster files; roster files are reported and not processed here)
 *   2. unpack zips safely into a private temp folder, keyed by content hash
 *   3. per file, in a worker pool: parse (cache first), optional JD score; the decision is made here
 *   4. kept files go to Drive from a second pool as results complete (overlapping, not a phase)
 *   5. dedupe, batch CSV in output/, JD rejects moved to database/ (unless dry run). The files read are listed in
 *      result.processed; the server moves them to processed/ once the run (and its commit) has succeeded.
 *
 * Nothing here talks to a downstream system. Secrets are read from ctx.secrets only and never written anywhere.
 * Candidate text and identity never go into logs or events; file names are sent in `file` events for the page,
 * and every log line is redacted.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asCompleted, CancelFlag, RateGate, TaskPool, type TaskHandle } from "./concurrency.js";
import * as cacheMod from "./cache.js";
import { resolveConfig } from "./config.js";
import * as csvout from "./csvout.js";
import * as drive from "./drive.js";
import { Cancelled, DailyQuotaExceeded, DriveAuthError, ZipRejected, errorMessage, errorName, llmMetaOf, type LlmMeta } from "./errors.js";
import * as jd from "./jd.js";
import * as llm from "./llm.js";
import * as parse from "./parse.js";
import { localStamp } from "./pyjson.js";
import { type Dict, getd, or } from "./pyish.js";
import { redact, secretValues } from "./redact.js";
import { metric, writeUsage, type UsageMetric } from "./usage.js";
import * as zipsMod from "./zips.js";
import type { DriveFactory, EventSink, FileStatus, Phase, RunContext, RunResult } from "./types.js";

const MB = zipsMod.MB;

function newResult(): RunResult {
  return {
    rows: [],
    csvPath: null,
    counts: {},
    cost: { tokens: 0, usd: 0 },
    failedFiles: [],
    cancelled: false,
    error: null,
    retryPath: null,
    runId: "",
    processed: [],
  };
}

class Emitter {
  private readonly started = performance.now();

  constructor(
    private readonly sink: EventSink | undefined,
    private readonly secrets: string[],
  ) {}

  private send(event: Parameters<EventSink>[0]): void {
    if (!this.sink) return;
    try {
      this.sink(event);
    } catch {
      /* a failing sink never fails the run */
    }
  }

  phase(name: Phase, extra: Record<string, unknown> = {}): void {
    this.send({ type: "phase", data: { phase: name, ...extra } });
  }

  log(message: string): void {
    this.send({ type: "log", data: { message: redact(message, this.secrets) } });
  }

  file(name: string, status: FileStatus, detail = ""): void {
    this.send({ type: "file", data: { name, status, detail: redact(detail, this.secrets) } });
  }

  progress(done: number, total: number, stage: string): void {
    const elapsed = (performance.now() - this.started) / 1000;
    const eta = done ? (elapsed / done) * (total - done) : null;
    this.send({
      type: "progress",
      data: {
        done,
        total,
        elapsed: Math.round(elapsed * 10) / 10,
        eta: eta !== null ? Math.round(eta * 10) / 10 : null,
        stage,
      },
    });
  }

  cost(tokens: number, usd: number): void {
    this.send({ type: "cost", data: { tokens: Math.trunc(tokens), usd: Math.round(usd * 1e6) / 1e6 } });
  }
}

function defaultCacheDir(): string {
  const base = process.env["APPDATA"] || os.homedir();
  return path.join(base, "ResumeIntake", "cache");
}

async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function providerName(baseUrl: string): string {
  const u = (baseUrl || "").toLowerCase();
  if (["localhost", "127.0.0.1", "11434", "ollama"].some((k) => u.includes(k))) return "Ollama";
  if (u.includes("deepinfra")) return "DeepInfra";
  if (u.includes("openrouter")) return "OpenRouter";
  if (u.includes("groq")) return "Groq";
  if (u.includes("together")) return "Together";
  return "AI model";
}

function uniquePath(folder: string, name: string): string {
  const { name: stem, ext } = path.parse(name);
  let target = path.join(folder, name);
  let n = 1;
  while (fs.existsSync(target)) {
    target = path.join(folder, `${stem}_${n}${ext}`);
    n++;
  }
  return target;
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fs.promises.rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await fs.promises.copyFile(from, to);
    await fs.promises.unlink(from);
  }
}

interface Item {
  sha: string;
  path: string;
  display: string;
  source: string;
}

export interface Discovered {
  pdf: string[];
  zip: string[];
  roster: string[];
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Files in the input folder; `only` (names or relative posix paths) limits a batch to the files it covers. */
export function discover(inputDir: string | null | undefined, only?: string[] | null): Discovered {
  let files = inputDir && fs.existsSync(inputDir) ? walkFiles(inputDir) : [];
  if (only && only.length > 0) {
    const wanted = new Set(only.map(String));
    files = files.filter((p) => wanted.has(path.basename(p)) || wanted.has(path.relative(inputDir!, p).split(path.sep).join("/")));
  }
  const ext = (p: string): string => path.extname(p).toLowerCase();
  return {
    pdf: files.filter((p) => ext(p) === ".pdf").sort(byPath),
    zip: files.filter((p) => ext(p) === ".zip").sort(byPath),
    roster: files.filter((p) => [".xlsx", ".csv"].includes(ext(p))).sort(byPath),
  };
}

/** Every PDF and zip the run read, rejected zips included (a refused archive is reported per file, not kept). */
function processedFiles(found: Discovered): string[] {
  return [...found.pdf, ...found.zip];
}

function fail(emit: Emitter, result: RunResult, message: string): RunResult {
  emit.phase("failed", { detail: message });
  emit.log(message);
  result.error = message;
  return result;
}

/**
 * Run one batch. Always resolves to a RunResult; an unexpected failure is reported as a failed phase with the
 * exception type only (no message text, which could carry résumé content).
 */
export async function runBatch(ctx: RunContext): Promise<RunResult> {
  try {
    return await run(ctx);
  } catch (exc) {
    const emit = new Emitter(ctx.emit, []);
    const message = `unexpected error in the pipeline (${errorName(exc)})`;
    emit.phase("failed", { detail: message });
    const result = newResult();
    result.error = message;
    return result;
  }
}

class Counts {
  readonly values: Record<string, number> = {};
  inc(key: string, by = 1): void {
    this.values[key] = (this.values[key] ?? 0) + by;
  }
}

async function run(ctx: RunContext): Promise<RunResult> {
  const secrets: Dict = { ...(ctx.secrets ?? {}) };
  const options: Dict = { ...(ctx.options ?? {}) };
  const cfg = resolveConfig(ctx.config as Record<string, unknown>) as unknown as Dict;
  const secretList = secretValues(secrets);
  const emit = new Emitter(ctx.emit, secretList);
  const result = newResult();
  const stop = new CancelFlag(ctx.cancelled);

  const dirs: Record<string, string | null> = {};
  for (const name of ["input", "output", "old", "database", "logs", "cache"] as const) {
    const value = (ctx.dirs as unknown as Record<string, string | undefined> | undefined)?.[name];
    dirs[name] = value ? value : null;
  }
  for (const name of ["input", "output", "old", "database", "logs"]) {
    if (dirs[name] === null) return fail(emit, result, `workspace folder '${name}' is not configured`);
    fs.mkdirSync(dirs[name]!, { recursive: true });
  }
  const cacheDir = dirs["cache"] ?? defaultCacheDir();
  const inputDir = dirs["input"]!;
  const outputDir = dirs["output"]!;
  const databaseDir = dirs["database"]!;

  const apiKey: string = secrets["openrouterApiKey"] || "";
  if (!apiKey) return fail(emit, result, "OpenRouter key is not set");

  const optionsCampaign = String(or(options["campaignType"], or(cfg["defaultCampaignType"], ""))).trim().toUpperCase();
  const platform = String(or(options["platform"], "")).trim();
  const runId =
    "run-" + new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z") + "-" + crypto.randomBytes(4).toString("hex");
  result.runId = runId;

  // Google token first: a bad token must stop the run before any résumé is read or paid for.
  const driveSource: DriveFactory | undefined = ctx.drive;
  let driveClient: DriveFactory;
  if (driveSource === undefined) {
    emit.phase("preparing", { detail: "checking Google token" });
    try {
      const credentials = await drive.loadCredentials(or(secrets["googleTokenJson"], ""));
      driveClient = drive.createGoogleDrive(credentials);
    } catch (exc) {
      if (exc instanceof DriveAuthError) return fail(emit, result, exc.message);
      throw exc;
    }
  } else {
    driveClient = driveSource;
  }
  const configuredFolders = cfg["driveFolders"] || {};
  let folderDefault: string | undefined;
  if (Array.isArray(configuredFolders)) {
    // [{name, id}] as the settings store keeps it
    folderDefault = configuredFolders.find(
      (f) => f && typeof f === "object" && String(f.name ?? "").trim().toUpperCase() === optionsCampaign,
    )?.id;
  } else {
    folderDefault = (configuredFolders as Record<string, string>)[optionsCampaign]; // {campaign type: folder id}
  }
  const folderId = String(or(options["driveFolderId"], or(folderDefault, ""))).trim();
  if (!folderId) return fail(emit, result, "Choose a Drive folder for this run");

  const parallel = Math.max(1, Math.min(32, Math.trunc(Number(or(options["parallel"], cfg["maxConcurrency"])))));
  const driveWorkers = Math.max(1, Math.min(16, Math.trunc(Number(cfg["driveConcurrency"]))));
  let jdEnabled = "jdFilter" in options ? Boolean(options["jdFilter"]) : Boolean(cfg["jdFilterEnabled"]);
  const jdThreshold = Math.trunc(Number(or(options["jdThreshold"], cfg["jdThreshold"])));
  const dryRun = "dryRun" in options ? Boolean(options["dryRun"]) : Boolean(cfg["jdDryRun"]);
  const jdText = String(or(options["jd"], or(((cfg["jdByRole"] as Dict) || {})[optionsCampaign], ""))).trim();
  if (jdEnabled && !jdText) {
    emit.log("JD screening is on but no job description is set; screening skipped");
    jdEnabled = false;
  }

  const llmCfg: llm.LlmCfg = {
    LLM_API_KEY: apiKey,
    LLM_BASE_URL: cfg["llmBaseUrl"],
    LLM_PRIMARY_MODEL: cfg["modelExtract"],
    LLM_PRIMARY_VISION_MODEL: cfg["modelVision"],
    LLM_FALLBACK_MODEL: cfg["modelFallback"],
    LLM_FALLBACK_VISION_MODEL: cfg["modelFallbackVision"],
    LLM_SCORING_MODEL: cfg["modelScoring"],
    LLM_PROMPT_MODE: cfg["promptMode"],
    LLM_RESPONSE_FORMAT: cfg["responseFormat"],
    LLM_REASONING_EFFORT: cfg["reasoningEffort"],
    LLM_VISION_REASONING_EFFORT: cfg["visionReasoningEffort"],
    LLM_FALLBACK_REASONING_EFFORT: cfg["fallbackReasoningEffort"],
    LLM_FALLBACK_VISION_REASONING_EFFORT: cfg["fallbackVisionReasoningEffort"],
    LLM_MAX_OUTPUT_TOKENS: cfg["maxOutputTokens"],
    LLM_FALLBACK_MAX_OUTPUT_TOKENS: cfg["fallbackMaxOutputTokens"],
    LLM_MAX_RETRIES: cfg["maxRetries"],
    OPENROUTER_REQUIRE_PARAMETERS: cfg["requireParameters"],
    OPENROUTER_ALLOW_FALLBACKS: cfg["allowFallbacks"],
    OPENROUTER_DATA_COLLECTION: cfg["dataCollection"],
    OPENROUTER_ZDR: cfg["zdr"],
    OPENROUTER_PROVIDER_ORDER: cfg["providerOrder"],
    OPENROUTER_SORT: cfg["sort"],
    CRM_CAMPAIGN_TYPE: optionsCampaign,
    EXTRACT_ATS: cfg["extractAts"],
    VISION_DPI: cfg["visionDpi"],
    _LLM_RUN_ID: runId,
  };
  const scoringModel = llmCfg["LLM_SCORING_MODEL"] as string;
  const primaryKey = `${llm.modelFor(llmCfg)}/${llm.modelFor(llmCfg, true)}`;
  const fallbackKey = `${llm.modelFor(llmCfg, false, true)}/${llm.modelFor(llmCfg, true, true)}`;
  const jdSha = jdEnabled ? crypto.createHash("sha256").update(jdText, "utf8").digest("hex") : "";

  // ── discovery and zips ────────────────────────────────────────────────
  emit.phase("preparing", { detail: "reading input folder" });
  const found = discover(inputDir, options["inputs"] as string[] | undefined);
  if (found.roster.length) {
    emit.log(`${found.roster.length} roster file(s) found; roster matching is not part of the web edition and they were ignored`);
  }
  if (!found.pdf.length && !found.zip.length) {
    emit.phase("done", { detail: "no résumés in input/" });
    result.counts = { files: 0 };
    return result;
  }

  const limits: zipsMod.ZipLimits = {
    maxEntries: Math.trunc(Number(cfg["zipMaxEntries"])),
    maxEntryBytes: Math.trunc(Number(cfg["zipMaxEntryMb"]) * MB),
    maxTotalBytes: Math.trunc(Number(cfg["zipMaxTotalMb"]) * MB),
    maxRatio: Number(cfg["zipMaxRatio"]),
  };
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "intake_resume_"));
  const counts = new Counts();
  const zipRejected: string[] = [];
  try {
    const items: Item[] = [];
    const seen = new Set<string>();
    for (const file of found.pdf) {
      const sha = await sha256File(file);
      if (seen.has(sha)) {
        counts.inc("duplicate_content");
        continue;
      }
      seen.add(sha);
      items.push({ sha, path: file, display: path.basename(file), source: "input" });
    }
    for (const zpath of found.zip) {
      let extracted: zipsMod.ZipResult;
      try {
        extracted = await zipsMod.extractZip(zpath, workDir, limits);
      } catch (exc) {
        if (exc instanceof ZipRejected) {
          zipRejected.push(zpath);
          counts.inc("zip_rejected");
          emit.file(path.basename(zpath), "skipped", `archive rejected: ${exc.message}`);
          continue;
        }
        throw exc;
      }
      for (const [name, reason] of extracted.skipped) {
        counts.inc("zip_entries_skipped");
        emit.file(name, "skipped", reason);
      }
      for (const ef of extracted.files) {
        if (seen.has(ef.sha256)) {
          counts.inc("duplicate_content");
          continue;
        }
        seen.add(ef.sha256);
        items.push({ sha: ef.sha256, path: ef.path, display: ef.displayName, source: ef.source });
      }
    }
    const total = items.length;
    if (!total) {
      emit.phase("done", { detail: "no readable résumés" });
      result.counts = { ...counts.values, files: 0 };
      result.processed = processedFiles(found);
      return result;
    }

    // ── shared infrastructure for this run ───────────────────────────
    const cache = new cacheMod.ParseCache(path.join(cacheDir, "parse-cache.jsonl"));
    const gate = new RateGate(parallel, Number(cfg["cooldownSeconds"]));
    const tr = new llm.Transport({
      http: ctx.http ?? llm.createFetchClient(),
      gate,
      cancel: stop,
      readTimeouts: cfg["readTimeouts"],
      visionReadTimeouts: cfg["visionReadTimeouts"],
      connectTimeout: Number(cfg["connectTimeout"]),
      onRetry: (message) => emit.log(message),
    });
    const fields = llm.loadFields(ctx.fields);
    const uploader = new drive.DriveUploader({ client: driveClient, cancel: stop, runId });
    const provider = providerName(cfg["llmBaseUrl"]);

    interface WorkResult {
      item: Item;
      row: Dict;
      meta: LlmMeta;
      fresh: boolean;
      jdResult: jd.ScoreResult | null;
      jdMeta: LlmMeta;
      jdFresh: boolean;
      text: string;
      vision: boolean;
    }

    const work = async (item: Item): Promise<WorkResult> => {
      tr.checkCancel();
      const key = cacheMod.extractKey(item.sha, primaryKey, fallbackKey, optionsCampaign);
      const hit = cache.get<Dict>(key);
      let row: Dict;
      let text: string;
      let vision: boolean;
      let meta: LlmMeta;
      let fresh: boolean;
      if (hit !== null) {
        row = hit["row"];
        text = getd(hit, "text", "");
        vision = getd(hit, "vision", false);
        meta = {};
        fresh = false;
      } else {
        const extracted = await parse.extractResume(item.path, llmCfg, tr, fields, item.sha.slice(0, 12));
        meta = (extracted._llm_meta as LlmMeta | undefined) ?? {};
        text = extracted._resume_text ?? "";
        vision = extracted._use_vision ?? false;
        delete extracted._llm_meta;
        delete extracted._resume_text;
        delete extracted._use_vision;
        row = extracted;
        cache.put(key, { row, text, vision, meta });
        fresh = true;
      }
      row = { ...row };
      let jdResult: jd.ScoreResult | null = null;
      let jdMeta: LlmMeta = {};
      let jdFresh = false;
      if (jdEnabled) {
        const jdKey = cacheMod.scoreKey(item.sha, scoringModel, jdSha);
        const cachedScore = cache.get<Dict>(jdKey);
        if (cachedScore !== null) {
          jdResult = cachedScore["result"];
        } else {
          const [scored, scoredMeta] = await jd.scoreResume(item.sha.slice(0, 12), jdText, llmCfg, tr, text, text ? null : row);
          jdResult = scored;
          jdMeta = scoredMeta ?? {};
          if (Object.keys(jdMeta).length && !String(jdResult.reason ?? "").startsWith("scoring failed")) {
            cache.put(jdKey, { result: jdResult });
          }
          jdFresh = Object.keys(jdMeta).length > 0;
        }
      }
      return { item, row, meta, fresh, jdResult, jdMeta, jdFresh, text, vision };
    };

    // ── pipeline ─────────────────────────────────────────────────────
    const stage = jdEnabled ? "screening" : "parsing"; // JD scoring runs inside the same worker
    emit.phase(stage, { total, detail: jdEnabled ? "parsing and JD screening" : "" });
    emit.progress(0, total, stage);
    const pool = new TaskPool(parallel);
    const drivePool = new TaskPool(driveWorkers);
    const handles = items.map((item) => pool.submit(() => work(item)));
    const indexOf = new Map<TaskHandle<WorkResult>, number>(handles.map((h, i) => [h, i]));
    const keptRows = new Map<number, Dict>(); // index -> row (CSV candidate)
    const uploadHandles = new Map<TaskHandle<drive.UploadRecord>, number>(); // handle -> index
    let uploadingStarted = false;
    const quarantined: Array<{ sha256: string; name: string; source: string; reason: string }> = [];
    const rejectedNames: csvout.IndexEntry[] = [];
    const metrics: UsageMetric[] = [];
    let tokenTotal = 0;
    let usdTotal = 0;
    let scored = 0;
    let cannot = 0;
    let done = 0;
    let stopReason: "cancelled" | "quota" | "jd_abort" | null = null;

    const addCost = (meta: LlmMeta | null | undefined, kind: string, sha: string): void => {
      if (!meta || Object.keys(meta).length === 0) return;
      tokenTotal += Math.trunc(Number(meta.total_tokens) || 0);
      usdTotal += Number(meta.cost) || 0;
      metrics.push(metric(sha, meta, kind));
      if (Math.trunc(Number(meta.reasoning_tokens) || 0) > 0 && !meta["fallback_used"]) {
        // Primary calls run with reasoning off; thinking tokens would silently raise the cost.
        emit.log(`warning: ${kind} call used ${Math.trunc(Number(meta.reasoning_tokens))} reasoning tokens with reasoning off`);
      }
      emit.cost(tokenTotal, usdTotal);
    };

    try {
      for await (const handle of asCompleted(handles)) {
        const index = indexOf.get(handle)!;
        const item = items[index]!;
        if (stop.isSet()) {
          stopReason = stopReason ?? "cancelled";
          break;
        }
        const settled = handle.result!;
        if (settled.cancelled) continue;
        if (!settled.ok) {
          const exc = settled.error;
          if (exc instanceof Cancelled) {
            stopReason = stopReason ?? "cancelled";
            stop.set();
            break;
          }
          if (exc instanceof DailyQuotaExceeded) {
            stopReason = "quota";
            stop.set();
            emit.log("provider daily quota reached; run stopped, completed work is cached");
            break;
          }
          done++;
          const reason = redact(`${errorName(exc)}: ${errorMessage(exc).slice(0, 160)}`, secretList);
          addCost(llmMetaOf(exc), "extract", item.sha);
          quarantined.push({ sha256: item.sha, name: item.display, source: item.source, reason });
          counts.inc("quarantined");
          emit.file(item.display, "quarantined", reason);
          emit.progress(done, total, "parsing");
          continue;
        }

        const res = settled.value;
        done++;
        addCost(res.meta, "extract", item.sha);
        if (res.jdFresh) addCost(res.jdMeta, "score", item.sha);
        if (res.jdResult !== null) {
          scored++;
          if (res.jdResult.verdict === "cannot_determine") cannot++;
          if (scored >= jd.MIN_SCORED && cannot / scored > jd.CANNOT_DETERMINE_LIMIT) {
            emit.log(
              `JD scorer returned cannot_determine for ${cannot} of ${scored} résumés; the scorer is not usable, so the run is stopped`,
            );
            stopReason = "jd_abort";
            stop.set();
            break;
          }
        }

        const row = res.row;
        const rejected = jdEnabled && res.jdResult !== null && !jd.passes(res.jdResult, jdThreshold);
        if (rejected && !dryRun) {
          const target = uniquePath(databaseDir, item.display);
          try {
            await moveFile(item.path, target);
          } catch {
            /* the file stays where it is */
          }
          rejectedNames.push({
            filename: item.display,
            score: res.jdResult!.score,
            missing_critical: res.jdResult!.missing_critical ?? [],
            reason: res.jdResult!.reason ?? "",
          });
          counts.inc("jd_rejected");
          emit.file(item.display, "rejected", `JD score ${res.jdResult!.score}`);
        } else {
          if (rejected) {
            // dry run: reported, but uploaded like everything else
            counts.inc("jd_would_reject");
            emit.file(item.display, "scored", `JD ${res.jdResult!.score} (dry run, kept)`);
          } else if (res.jdResult !== null) {
            emit.file(item.display, "scored", `JD ${res.jdResult.score}`);
          }
          keptRows.set(index, row);
          counts.inc("parsed");
          emit.file(item.display, "parsed", !res.fresh ? "cached" : "");
          if (!uploadingStarted) {
            uploadingStarted = true;
            emit.phase("uploading", { detail: "Drive uploads run alongside parsing" });
          }
          uploadHandles.set(
            drivePool.submit(() => uploader.upload(item.path, item.sha, item.display, folderId)),
            index,
          );
        }
        emit.progress(done, total, "parsing");
      }
    } finally {
      for (const handle of handles) handle.cancel();
      await pool.shutdown();
    }

    if (stop.isSet()) {
      for (const handle of uploadHandles.keys()) handle.cancel();
    }

    // wait for the uploads (cancelled ones are skipped)
    for await (const handle of asCompleted([...uploadHandles.keys()])) {
      const index = uploadHandles.get(handle)!;
      const item = items[index]!;
      const settled = handle.result!;
      if (settled.cancelled) continue;
      if (!settled.ok) {
        const exc = settled.error;
        if (exc instanceof Cancelled) continue;
        const reason = drive.driveErrorReason(exc);
        result.failedFiles.push({ name: item.display, reason });
        counts.inc("upload_failed");
        emit.file(item.display, "upload_failed", reason);
        continue;
      }
      const record = settled.value;
      keptRows.get(index)!["Resume"] = record.url;
      counts.inc(record.created ? "uploaded" : "reused_existing");
      emit.file(item.display, "uploaded", record.created ? "new" : "already in Drive");
    }
    await drivePool.shutdown();

    if (stopReason !== null) {
      result.cancelled = stopReason === "cancelled";
      if (stopReason === "quota") {
        fail(
          emit,
          result,
          "Provider daily quota reached; switch model or add credit, then run again. " +
            "Finished résumés are cached and will not be paid for twice.",
        );
      } else if (stopReason === "jd_abort") {
        fail(
          emit,
          result,
          "The JD scorer returned cannot_determine for too many résumés " + "(over 30%). Check the scoring model before running again.",
        );
      } else {
        emit.phase("cancelled", { detail: "cancelled; finished résumés are cached" });
      }
    } else {
      emit.phase("done");
    }

    // ── dedupe, CSV, side effects ────────────────────────────────────
    const rows: Dict[] = [];
    const leadIds = new Set<string>();
    const identities = new Set<string>();
    const today = localStamp("minute");
    const prepared: Array<[number, Dict, string, string]> = [];
    for (const index of [...keptRows.keys()].sort((a, b) => a - b)) {
      const row = keptRows.get(index)!;
      const phone = csvout.normalizePhoneE164(row["Phone Number"] ?? "");
      row["Phone Number"] = phone;
      const lid = csvout.leadId(row["Email Address"] ?? "", phone, row["Name"] ?? "");
      prepared.push([index, row, lid, csvout.phoneKey(phone)]);
    }
    const dupIndexes = new Set<number>();
    for (const [index, , lid, pk] of prepared) {
      const identity = pk || lid;
      if (identities.has(identity)) {
        dupIndexes.add(index);
        continue;
      }
      identities.add(identity);
    }
    for (const [index, row, lid] of prepared) {
      if (dupIndexes.has(index)) continue;
      if (leadIds.has(lid)) {
        dupIndexes.add(index);
        continue;
      }
      leadIds.add(lid);
      const out: Dict = { "Lead ID": lid, Date: today, Platform: platform };
      for (const [k, v] of Object.entries(row)) if (!String(k).startsWith("_")) out[k] = v;
      if (!("Resume" in out)) out["Resume"] = "";
      rows.push(out);
    }
    for (const index of dupIndexes) emit.file(items[index]!.display, "duplicate", "same person already in this batch");
    counts.values["in_batch_duplicates"] = dupIndexes.size;

    if (rows.length && stopReason === null) {
      const columns = ["Lead ID", "Date", "Name", "Email Address", "Phone Number", "Platform", "Current Location", "Graduation"];
      for (const out of rows) {
        for (const key of Object.keys(out)) if (!columns.includes(key) && key !== "Resume") columns.push(key);
      }
      columns.push("Resume");
      result.csvPath = csvout.writeBatchCsv(outputDir, rows, columns, provider);
    }

    if (quarantined.length) result.retryPath = csvout.writeRetryList(outputDir, quarantined);
    if (rejectedNames.length) {
      csvout.appendDatabaseIndex(databaseDir, rejectedNames, "Run", "Campaign", runId, optionsCampaign);
    }
    if (cfg["writeUsageLog"] && metrics.length) {
      writeUsage(
        outputDir,
        runId,
        { requests: metrics.length, cost: Math.round(usdTotal * 1e8) / 1e8, total_tokens: tokenTotal, rate_limit_trips: gate.trips },
        metrics,
      );
    }
    if (zipRejected.length) counts.values["zip_rejected"] = zipRejected.length;

    if (stopReason === null) result.processed = processedFiles(found);

    result.rows = rows;
    result.counts = { ...counts.values, files: total, rows: rows.length, jd_scored: scored, jd_cannot_determine: cannot };
    result.cost = { tokens: tokenTotal, usd: Math.round(usdTotal * 1e6) / 1e6 };
    result.failedFiles = [...result.failedFiles, ...quarantined.map((q) => ({ name: q.name, reason: q.reason }))];
    emit.cost(tokenTotal, usdTotal);
    emit.progress(done, total, "done");
    return result;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
