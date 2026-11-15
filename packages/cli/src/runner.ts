import fs from "node:fs";
import path from "node:path";
import { EXIT, type RunArgs } from "./args.ts";
import type { DriveClient, HttpClient, RunContext, RunResult } from "./core.ts";
import { formatEvent, summaryLines } from "./plain.ts";
import { Store, exitCodeFor, type CliEvent } from "./progress.ts";
import { redactText } from "./redact.ts";
import { CommitError, commitRows, lookupCampaignId, mintDemoToken, type FetchLike } from "./sink.ts";
import { InputError, stageInputs } from "./workspace.ts";

/** The slice of @intake/core the CLI uses; tests can inject a replacement. */
export interface CoreApi {
  runBatch(ctx: RunContext): Promise<RunResult>;
  createFakeLlm(): HttpClient;
  createFakeDrive(): DriveClient;
}

export interface Output {
  write(text: string): unknown;
}

export interface CliIO {
  stdout: Output;
  stderr: Output;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  cwd: string;
  signal?: AbortSignal;
  fetch?: FetchLike;
  core?: CoreApi;
  /** Renders the live display; returns a function that stops it. Absent: always plain output. */
  startLiveUi?: (store: Store, title: string) => Promise<() => Promise<void>>;
}

const FAKE_KEY = "fake-key-offline";

export async function runCommand(args: RunArgs, io: CliIO): Promise<number> {
  const core: CoreApi = io.core ?? ((await import("./core.ts")) as unknown as CoreApi);
  const fail = (message: string, code: number): number => {
    io.stderr.write(`intake: ${message}\n`);
    return code;
  };

  const apiKey = args.fake ? FAKE_KEY : (io.env.INTAKE_OPENROUTER_API_KEY ?? io.env.OPENROUTER_API_KEY ?? "");
  if (!apiKey) return fail("No LLM key. Set INTAKE_OPENROUTER_API_KEY, or use --fake to run offline.", EXIT.usage);

  let jd = "";
  if (args.jdFile) {
    try {
      jd = fs.readFileSync(path.resolve(io.cwd, args.jdFile), "utf8");
    } catch {
      return fail(`Cannot read the job description file: ${args.jdFile}`, EXIT.usage);
    }
  }

  // Sink: settle the token and campaign before spending anything on the LLM.
  let sinkToken = "";
  let campaignId: number | null = args.campaignId;
  if (args.sink) {
    try {
      sinkToken = args.token ?? io.env.INTAKE_SINK_TOKEN ?? "";
      if (!sinkToken && args.mintToken) sinkToken = await mintDemoToken(args.sink, io.fetch);
      if (!sinkToken) return fail("The sink needs a token: set INTAKE_SINK_TOKEN, or pass --token or --mint-token.", EXIT.usage);
      if (campaignId === null) {
        if (!args.campaign) return fail("--sink needs --campaign <name> or --campaign-id <n>.", EXIT.usage);
        campaignId = await lookupCampaignId(args.sink, sinkToken, args.campaign, io.fetch);
      }
    } catch (err) {
      if (err instanceof CommitError) return fail(redactText(err.message, [sinkToken]), EXIT.failed);
      throw err;
    }
  }

  let workspace;
  try {
    workspace = stageInputs(args.inputs, path.resolve(io.cwd, args.workdir ?? ".intake-cli"));
  } catch (err) {
    if (err instanceof InputError) return fail(err.message, EXIT.usage);
    throw err;
  }

  const secrets = [apiKey, sinkToken];
  const store = new Store();
  let stopUi: (() => Promise<void>) | null = null;
  const live = !args.json && !args.plain && io.isTTY && io.startLiveUi !== undefined;
  let lastProgress = "";
  const publish = (event: CliEvent): void => {
    store.dispatch(event);
    if (args.json) io.stdout.write(`${JSON.stringify(event)}\n`);
    else if (!live) {
      if (event.type === "progress") {
        // plain output: one line per change in done/stage, not per tick
        const key = `${event.data.done}/${event.data.total}/${event.data.stage}`;
        if (key === lastProgress) return;
        lastProgress = key;
      }
      const line = formatEvent(event);
      if (line) io.stdout.write(`${redactText(line, secrets)}\n`);
    }
  };
  if (live) stopUi = await io.startLiveUi!(store, args.fake ? "(fake provider, offline)" : "");

  const controller = new AbortController();
  io.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  if (io.signal?.aborted) controller.abort();

  const options: Record<string, unknown> = {
    campaignType: args.campaign,
    platform: args.platform,
    jd,
    dryRun: args.dryRun,
    ...(args.parallel !== null ? { parallel: args.parallel } : {}),
    ...(args.driveFolder ? { driveFolderId: args.driveFolder } : args.fake ? { driveFolderId: "fake-folder" } : {}),
  };
  const ctx: RunContext = {
    dirs: workspace.dirs,
    config: {},
    secrets: { openrouterApiKey: apiKey },
    options,
    emit: (event) => publish(event),
    cancelled: controller.signal,
    ...(args.fake ? { http: core.createFakeLlm(), drive: core.createFakeDrive() } : {}),
  };

  let result: RunResult | null = null;
  try {
    result = await core.runBatch(ctx);
  } catch (err) {
    const message = redactText(err instanceof Error ? err.message : String(err), secrets).slice(0, 300);
    publish({ type: "phase", data: { phase: "failed", detail: message || "The run failed." } });
  }

  if (result) {
    publish({ type: "result", data: { csvPath: result.csvPath, rows: result.rows.length, error: result.error, cancelled: result.cancelled } });
    if (result.error && store.getState().phase !== "failed") publish({ type: "phase", data: { phase: "failed", detail: redactText(result.error, secrets) } });
    if (args.sink && campaignId !== null && !result.cancelled && !result.error && result.rows.length > 0) {
      try {
        const outcome = await commitRows(result.rows, {
          baseUrl: args.sink,
          token: sinkToken,
          campaignId,
          source: args.source,
          stage: args.stage,
          dryRun: args.dryRun,
          ...(io.fetch ? { fetch: io.fetch } : {}),
          onStarted: (rows) => publish({ type: "commit_started", data: { campaignId: campaignId as number, rows, dryRun: args.dryRun } }),
          onPreflight: (c) => publish({ type: "commit_preflight", data: { ready: c.ready, duplicate: c.duplicate, conflict: c.conflict, invalid: c.invalid } }),
        });
        publish({ type: "commit_done", data: { created: outcome.created, skipped: outcome.skipped, batchId: outcome.batchId, idempotencyKey: outcome.idempotencyKey } });
      } catch (err) {
        if (!(err instanceof CommitError)) throw err;
        publish({ type: "commit_failed", data: { stage: err.stage, status: err.status, message: redactText(err.message, secrets) } });
      }
    }
  }

  if (stopUi) await stopUi();
  const state = store.getState();
  if (!args.json) for (const line of summaryLines(state)) io.stdout.write(`${redactText(line, secrets)}\n`);
  return exitCodeFor(state);
}
