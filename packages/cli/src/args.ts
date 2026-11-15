import { parseArgs } from "node:util";

export class UsageError extends Error {}

export const EXIT = { ok: 0, failed: 1, usage: 2, partial: 3, cancelled: 130 } as const;

export interface RunArgs {
  command: "run";
  inputs: string[];
  campaign: string;
  campaignId: number | null;
  source: string;
  stage: string;
  dryRun: boolean;
  fake: boolean;
  sink: string | null;
  token: string | null;
  mintToken: boolean;
  workdir: string | null;
  parallel: number | null;
  jdFile: string | null;
  platform: string;
  driveFolder: string | null;
  plain: boolean;
  json: boolean;
}
export interface ServeArgs { command: "serve"; port: number | null; open: boolean; fake: boolean }
export interface AppArgs { command: "app"; url: string | null; port: number | null; serve: boolean; fake: boolean }
export interface FakeLlmArgs { command: "fake-llm"; port: number }
export interface ConnectArgs { command: "connect"; server: string | null; crm: string; llm: string | null }
export interface HelpArgs { command: "help"; topic: string | null }
export interface VersionArgs { command: "version" }
export type ParsedArgs = RunArgs | ServeArgs | AppArgs | FakeLlmArgs | ConnectArgs | HelpArgs | VersionArgs;

export const DEFAULT_SOURCE = "Resume Intake";
export const DEFAULT_STAGE = "LEAD";

export const USAGE = `intake - résumé intake from the terminal

Usage
  intake run <folder-or-zip...> [options]   read résumés, write a CSV, optionally commit to a sink
  intake serve [--port N] [--no-open] [--fake]  start the local server and open the web UI (--fake: offline model and Drive)
  intake app [--url URL] [--serve] [--fake]   open the web UI in a standalone browser window (Edge/Chrome app mode)
  intake fake-llm [--port N]                offline stand-in LLM endpoint, so a server can run with no keys (demo)
  intake connect [--server URL] [--crm URL] [--llm URL]
                                            point a running server at a mock CRM and print a demo session token
  intake help | --version

Options for "run"
  --campaign <name>        campaign or role type, e.g. "Backend Engineer" (also used to find the sink campaign)
  --campaign-id <n>        sink campaign id (skips the lookup by name)
  --source <text>          source label sent to the sink (default "${DEFAULT_SOURCE}")
  --stage <NAME>           sink stage (default ${DEFAULT_STAGE})
  --platform <text>        platform label stored with each row
  --dry-run                score without dropping anyone, and only preflight the sink (nothing is committed)
  --fake                   offline: deterministic fake LLM and fake Drive, no keys needed
  --sink <url>             base URL of an ingestion API (preflight + idempotent batch)
  --token <token>          sink bearer token (prefer the INTAKE_SINK_TOKEN environment variable)
  --mint-token             ask the sink for a demo session token (mock CRM only)
  --parallel <n>           concurrent reads, 1 to 16
  --jd <file>              job description text file for scoring
  --drive-folder <id>      Drive folder for kept files
  --workdir <dir>          working folder (default ./.intake-cli)
  --plain                  line-by-line output instead of the live display
  --json                   one JSON event per line on stdout

Environment
  INTAKE_OPENROUTER_API_KEY   LLM key (not needed with --fake)
  INTAKE_SINK_TOKEN           sink bearer token

Exit codes
  0 success   1 the run failed   2 bad usage   3 finished but some files or the commit failed   130 cancelled
`;

function toInt(value: string | undefined, name: string, low: number, high: number): number | null {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value)) throw new UsageError(`${name} must be a whole number.`);
  const n = Number(value);
  if (n < low || n > high) throw new UsageError(`${name} must be from ${low} to ${high}.`);
  return n;
}

export function parseCli(argv: string[]): ParsedArgs {
  const [first, ...rest] = argv;
  if (first === undefined || first === "help" || first === "--help" || first === "-h") {
    return { command: "help", topic: rest[0] ?? null };
  }
  if (first === "--version" || first === "-v" || first === "version") return { command: "version" };

  try {
    switch (first) {
      case "run": {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            campaign: { type: "string" },
            "campaign-id": { type: "string" },
            source: { type: "string" },
            stage: { type: "string" },
            platform: { type: "string" },
            "dry-run": { type: "boolean" },
            fake: { type: "boolean" },
            sink: { type: "string" },
            token: { type: "string" },
            "mint-token": { type: "boolean" },
            parallel: { type: "string" },
            jd: { type: "string" },
            "drive-folder": { type: "string" },
            workdir: { type: "string" },
            plain: { type: "boolean" },
            json: { type: "boolean" },
            help: { type: "boolean", short: "h" },
          },
        });
        if (values.help) return { command: "help", topic: "run" };
        if (positionals.length === 0) throw new UsageError("Give at least one folder or zip to read: intake run <folder-or-zip...>");
        const stage = (values.stage ?? DEFAULT_STAGE).trim().toUpperCase();
        if (!/^[A-Z][A-Z_]{0,39}$/.test(stage)) throw new UsageError("--stage must be a stage name such as LEAD.");
        const source = (values.source ?? DEFAULT_SOURCE).trim() || DEFAULT_SOURCE;
        if (source.length > 120) throw new UsageError("--source must be up to 120 characters.");
        const campaignId = toInt(values["campaign-id"], "--campaign-id", 1, 2_147_483_647);
        if (values.sink !== undefined) assertUrl(values.sink, "--sink");
        if (values["mint-token"] && values.sink === undefined) throw new UsageError("--mint-token needs --sink.");
        if (values.token !== undefined && values["mint-token"]) throw new UsageError("Use either --token or --mint-token, not both.");
        if ((values.token !== undefined || campaignId !== null) && values.sink === undefined) throw new UsageError("--token and --campaign-id need --sink.");
        return {
          command: "run",
          inputs: positionals,
          campaign: (values.campaign ?? "").trim(),
          campaignId,
          source,
          stage,
          dryRun: values["dry-run"] ?? false,
          fake: values.fake ?? false,
          sink: values.sink ?? null,
          token: values.token ?? null,
          mintToken: values["mint-token"] ?? false,
          workdir: values.workdir ?? null,
          parallel: toInt(values.parallel, "--parallel", 1, 16),
          jdFile: values.jd ?? null,
          platform: values.platform ?? "",
          driveFolder: values["drive-folder"] ?? null,
          plain: values.plain ?? false,
          json: values.json ?? false,
        };
      }
      case "serve": {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { port: { type: "string" }, "no-open": { type: "boolean" }, fake: { type: "boolean" }, help: { type: "boolean", short: "h" } },
        });
        if (values.help) return { command: "help", topic: "serve" };
        if (positionals.length) throw new UsageError(`Unexpected argument "${positionals[0]}".`);
        return { command: "serve", port: toInt(values.port, "--port", 1, 65535), open: !values["no-open"], fake: values.fake ?? false };
      }
      case "app": {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { url: { type: "string" }, port: { type: "string" }, serve: { type: "boolean" }, fake: { type: "boolean" }, help: { type: "boolean", short: "h" } },
        });
        if (values.help) return { command: "help", topic: "app" };
        if (positionals.length) throw new UsageError(`Unexpected argument "${positionals[0]}".`);
        if (values.url !== undefined) assertUrl(values.url, "--url");
        return { command: "app", url: values.url ?? null, port: toInt(values.port, "--port", 1, 65535), serve: values.serve ?? false, fake: values.fake ?? false };
      }
      case "fake-llm": {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { port: { type: "string" }, help: { type: "boolean", short: "h" } } });
        if (values.help) return { command: "help", topic: "fake-llm" };
        if (positionals.length) throw new UsageError(`Unexpected argument "${positionals[0]}".`);
        return { command: "fake-llm", port: toInt(values.port, "--port", 0, 65535) ?? 47920 };
      }
      case "connect": {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { server: { type: "string" }, crm: { type: "string" }, llm: { type: "string" }, help: { type: "boolean", short: "h" } } });
        if (values.help) return { command: "help", topic: "connect" };
        if (positionals.length) throw new UsageError(`Unexpected argument "${positionals[0]}".`);
        for (const [flag, v] of [["--server", values.server], ["--crm", values.crm], ["--llm", values.llm]] as const) if (v !== undefined) assertUrl(v, flag);
        return { command: "connect", server: values.server ?? null, crm: values.crm ?? "http://127.0.0.1:47900", llm: values.llm ?? null };
      }
      default:
        throw new UsageError(`Unknown command "${first}". Run "intake help".`);
    }
  } catch (err) {
    if (err instanceof UsageError) throw err;
    // parseArgs throws TypeError-like errors with a code for unknown or malformed options
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new UsageError(message ?? "Invalid arguments.");
  }
}

function assertUrl(value: string, name: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`${name} must be a full URL such as http://127.0.0.1:47900.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UsageError(`${name} must start with http:// or https://.`);
}
