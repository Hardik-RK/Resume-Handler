import fs from "node:fs";
import path from "node:path";
import type { DriveFactory, HttpClient, PipelineEvent, RunContext, RunOptions, WorkspaceDirs } from "../../src/index.js";
import { makePdf, resumeLines } from "./make-pdf.js";

export interface TestCtx extends Omit<RunContext, "dirs"> {
  dirs: Required<WorkspaceDirs>;
  events: PipelineEvent[];
  controller: AbortController;
  root: string;
  fileEvents(status?: string): Array<{ name: string; status: string; detail: string }>;
  phases(): string[];
}

export function makeCtx(
  root: string,
  opts: {
    http?: HttpClient;
    drive?: DriveFactory;
    config?: Record<string, unknown>;
    options?: RunOptions;
    secrets?: Record<string, unknown>;
    onEvent?: (event: PipelineEvent, ctx: TestCtx) => void;
    noDrive?: boolean;
  } = {},
): TestCtx {
  const dirs = {
    input: path.join(root, "input"),
    output: path.join(root, "output"),
    old: path.join(root, "old"),
    database: path.join(root, "database"),
    logs: path.join(root, "logs"),
    cache: path.join(root, "cache"),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const events: PipelineEvent[] = [];
  const controller = new AbortController();
  const ctx: TestCtx = {
    dirs,
    config: {
      llmBaseUrl: "http://127.0.0.1:9/api/v1",
      modelExtract: "test/extractor",
      modelFallback: "test/extractor",
      modelVision: "test/extractor",
      modelFallbackVision: "test/extractor",
      modelScoring: "test/scorer",
      maxConcurrency: 4,
      driveConcurrency: 3,
      maxRetries: 1,
      cooldownSeconds: 0.5,
      jdFilterEnabled: false,
      jdDryRun: true,
      jdThreshold: 50,
      writeUsageLog: true,
      ...(opts.config ?? {}),
    },
    options: { campaignType: "TECH", platform: "Unstop", driveFolderId: "folder-1", parallel: 4, ...(opts.options ?? {}) },
    secrets: { openrouterApiKey: "sk-test-key-0123456789", googleTokenJson: "{}", ...(opts.secrets ?? {}) },
    emit: (event) => {
      events.push(event);
      opts.onEvent?.(event, ctx);
    },
    cancelled: controller.signal,
    ...(opts.http ? { http: opts.http } : {}),
    ...(opts.noDrive ? {} : opts.drive ? { drive: opts.drive } : {}),
    events,
    controller,
    root,
    fileEvents: (status) =>
      events.flatMap((e) => (e.type === "file" && (status === undefined || e.data.status === status) ? [e.data] : [])),
    phases: () => events.flatMap((e) => (e.type === "phase" ? [e.data.phase] : [])),
  };
  return ctx;
}

export function writePdf(file: string, lines: string[]): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, makePdf([{ lines }]));
  return file;
}

/** `n` synthetic candidate PDFs (Test Person A.., cand<i>@example.com, 98765432<ii>) in `folder`. */
export function candidatePdfs(folder: string, n: number, start = 0): string[] {
  const out: string[] = [];
  for (let i = start; i < start + n; i++) {
    out.push(
      writePdf(
        path.join(folder, `cv${i}.pdf`),
        resumeLines(`Test Person ${String.fromCharCode(65 + i)}`, `cand${i}@example.com`, `98765432${String(i).padStart(2, "0")}`),
      ),
    );
  }
  return out;
}
