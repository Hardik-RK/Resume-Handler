/**
 * `intake connect`: wire a running server to a running mock CRM for the demo. Mints a demo session token, reads the
 * CRM's campaigns, and pushes the settings the web page needs (CRM address, campaigns, ingestion token, optionally a
 * fake LLM address) to the server's POST /settings. Prints the token to paste into the page in signed mode.
 */
import { CAMPAIGNS_PATH, CommitError, mintDemoToken, validateSinkBase, type FetchLike } from "./sink.ts";

export interface ConnectOptions {
  server: string;
  crm: string;
  llm: string | null;
  fetch?: FetchLike;
}

export interface ConnectResult {
  token: string;
  campaigns: number;
}

const TOKEN_TTL_SECONDS = 86_400;

export async function connect(options: ConnectOptions): Promise<ConnectResult> {
  const fetchImpl = options.fetch ?? fetch;
  const crm = validateSinkBase(options.crm);
  const token = await mintDemoToken(crm, fetchImpl, TOKEN_TTL_SECONDS);

  const listed = await fetchImpl(crm + CAMPAIGNS_PATH, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  if (listed.status !== 200) throw new CommitError("preflight", listed.status, `The CRM answered HTTP ${listed.status} for its campaign list.`);
  const body = (await listed.json().catch(() => null)) as { campaigns?: Array<{ id: number; name: string; type?: string; company?: string }> } | null;
  const campaigns = (body?.campaigns ?? []).map((c) => ({ id: c.id, name: c.name, ...(c.company ? { group: c.company } : {}), ...(c.type ? { type: c.type } : {}) }));

  const config: Record<string, unknown> = { crmBaseUrl: crm, campaigns };
  const secrets: Record<string, string> = { ingestionToken: token };
  if (options.llm) {
    config.llmBaseUrl = options.llm;
    secrets.openrouterApiKey = "offline-demo-key";
  }
  const saved = await fetchImpl(`${options.server.replace(/\/+$/, "")}/settings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ config, secrets }),
    signal: AbortSignal.timeout(15_000),
  });
  if (saved.status !== 200) {
    const detail = saved.status === 401 ? " (is the server running with INTAKE_PUBLIC_KEY_FILE pointing at this CRM's key?)" : "";
    throw new CommitError("preflight", saved.status, `The server refused the settings (HTTP ${saved.status})${detail}.`);
  }
  return { token, campaigns: campaigns.length };
}
