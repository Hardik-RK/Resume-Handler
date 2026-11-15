/**
 * Local hand-testing server: the real model (OpenRouter, key from INTAKE_OPENROUTER_API_KEY), an in-memory FAKE Drive
 * (nothing is ever uploaded to Google), and the mock CRM as the ingestion sink. Everything comes from the environment
 * (see .env.local, gitignored). Started by scripts/start-local.ps1.
 *
 *   INTAKE_LOCAL_CONFIG_JSON   JSON of non-secret settings to push (models, platforms, campaign types, ...)
 *   MOCK_CRM_PORT              the mock CRM's port (default 47900)
 *   MOCK_CRM_INGESTION_TOKEN   the static token the mock CRM accepts on its ingestion routes
 */
import { startServer } from "@intake/server";
import { createFakeDrive, runBatch } from "./core.ts";
import { CAMPAIGNS_PATH, validateSinkBase } from "./sink.ts";

const env = process.env;
const crm = validateSinkBase(`http://127.0.0.1:${env.MOCK_CRM_PORT || 47900}`);
const sinkToken = env.MOCK_CRM_INGESTION_TOKEN ?? "";
const llmKey = env.INTAKE_OPENROUTER_API_KEY || env.OPENROUTER_API_KEY || "";
const FAKE_FOLDER = "fake-drive-folder";

const running = await startServer(
  {
    engine: {
      runner: (ctx) =>
        runBatch({ ...ctx, drive: createFakeDrive(), options: { ...ctx.options, driveFolderId: FAKE_FOLDER } }),
    },
  },
  env,
);

const config: Record<string, unknown> = env.INTAKE_LOCAL_CONFIG_JSON ? JSON.parse(env.INTAKE_LOCAL_CONFIG_JSON) : {};
config.crmBaseUrl = crm;
// Drive stays fake: every campaign type maps to the in-memory folder, whatever the real setup says.
config.driveFolders = (Array.isArray(config.driveFolders) ? (config.driveFolders as Array<{ name?: string }>) : [{ name: "TECH" }]).map(
  (f) => ({ id: FAKE_FOLDER, name: f.name ?? "TECH" }),
);
try {
  const listed = await fetch(crm + CAMPAIGNS_PATH, { headers: { authorization: `Bearer ${sinkToken}` }, signal: AbortSignal.timeout(10_000) });
  const body = (await listed.json()) as { campaigns?: Array<{ id: number; name: string; type?: string; company?: string }> };
  config.campaigns = (body.campaigns ?? []).map((c) => ({ id: c.id, name: c.name, ...(c.company ? { group: c.company } : {}), ...(c.type ? { type: c.type } : {}) }));
} catch (err) {
  console.error(`Could not read campaigns from the mock CRM at ${crm}: ${err instanceof Error ? err.message : String(err)}`);
}
const secrets: Record<string, string> = {};
if (llmKey) secrets.openrouterApiKey = llmKey;
if (sinkToken) secrets.ingestionToken = sinkToken;
running.engine.settings.apply(config, secrets);

console.log(`Local server ready at ${running.url}  (auth: ${running.engine.auth.mode}; model key ${llmKey ? "set" : "NOT set"}; Drive: fake; sink: ${crm})`);
process.once("SIGINT", () => void running.stop());
process.once("SIGTERM", () => void running.stop());
await running.stopped;
process.exit(0);
