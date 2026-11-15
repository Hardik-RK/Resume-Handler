#!/usr/bin/env tsx
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createMockCrm } from "./app.ts";

export const DEFAULT_PORT = 47900;

/** Starts the mock CRM. Env: MOCK_CRM_PORT, MOCK_CRM_DATA_DIR (where public_key.pem is written), MOCK_CRM_INGESTION_TOKEN, MOCK_CRM_OPEN=1. */
export function start(env: NodeJS.ProcessEnv = process.env) {
  const port = Number(env.MOCK_CRM_PORT ?? DEFAULT_PORT);
  const dataDir = resolve(env.MOCK_CRM_DATA_DIR ?? "demo-data");
  const crm = createMockCrm({
    ...(env.MOCK_CRM_INGESTION_TOKEN ? { ingestionToken: env.MOCK_CRM_INGESTION_TOKEN } : {}),
    requireAuth: env.MOCK_CRM_OPEN !== "1",
  });
  mkdirSync(dataDir, { recursive: true });
  const keyFile = join(dataDir, "public_key.pem");
  writeFileSync(keyFile, crm.issuer.publicKeyPem());
  const server = serve({ fetch: crm.app.fetch, port, hostname: "127.0.0.1" }, (info) => {
    console.log(`mock CRM listening on http://127.0.0.1:${info.port}`);
    console.log(`DEMO public key (Ed25519) written to ${keyFile}`);
    console.log(`  also at http://127.0.0.1:${info.port}/.well-known/public-key.pem`);
    console.log(`  mint a session token: POST http://127.0.0.1:${info.port}/api/uploader/token`);
  });
  return { ...crm, server, keyFile, port };
}

const entry = process.argv[1] ?? "";
if (/server\.(ts|js)$/.test(entry)) start();
