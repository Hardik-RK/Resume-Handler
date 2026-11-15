/**
 * Commit a finished run to an ingestion API: one item per row, POST /api/ingestion/preflight, then POST
 * /api/ingestion/batch with the READY rows and an idempotency key derived from the run's identities and campaign.
 * The same rows give the same key, so a retry replays instead of duplicating.
 *
 * The token goes only in the Authorization header. Server bodies are never echoed: a failure message is a fixed
 * sentence plus the HTTP status. A commit failure never fails the run.
 */
import { createHash } from "node:crypto";

export const PREFLIGHT_PATH = "/api/ingestion/preflight";
export const BATCH_PATH = "/api/ingestion/batch";
export const CAMPAIGNS_PATH = "/api/ingestion/campaigns";
export const MAX_ITEMS = 1000;
export const NOT_SPECIFIED = "not specified";

export class CommitError extends Error {
  constructor(public stage: "preflight" | "batch", public status: number | null, message: string) {
    super(message);
  }
}

export interface IngestionItem {
  name: string;
  source: string;
  stage: string;
  campaignId: number;
  email?: string;
  phone?: string;
  leadId?: string;
  currentLocation?: string;
  graduation?: string;
  resumeUrl?: string;
}

export interface CommitRequest {
  campaignId: number;
  source: string;
  stage: string;
}

export interface CommitCounts {
  rows: number;
  ready: number;
  duplicate: number;
  conflict: number;
  invalid: number;
}

export interface CommitOutcome {
  counts: CommitCounts;
  created: number;
  skipped: number;
  batchId: number | null;
  idempotencyKey: string;
  /** true when only the preflight ran */
  dryRun: boolean;
}

function text(value: unknown): string {
  return String(value ?? "").split(/\s+/).filter(Boolean).join(" ").trim();
}

export function buildItems(rows: Array<Record<string, unknown>>, request: CommitRequest): { items: IngestionItem[]; keys: string[]; leftOut: number } {
  const items: IngestionItem[] = [];
  const keys: string[] = [];
  let leftOut = 0;
  for (const row of rows) {
    const name = text(row["Name"]);
    const email = text(row["Email Address"]).toLowerCase();
    const phone = text(row["Phone Number"]);
    if (!name || name.toLowerCase() === NOT_SPECIFIED || !(email || phone)) {
      leftOut++;
      continue;
    }
    const item: IngestionItem = { name, source: request.source, stage: request.stage, campaignId: request.campaignId };
    if (email) item.email = email;
    if (phone) item.phone = phone;
    const extras: Array<[keyof IngestionItem, string]> = [["leadId", "Lead ID"], ["currentLocation", "Current Location"], ["graduation", "Graduation"], ["resumeUrl", "Resume"]];
    for (const [key, column] of extras) {
      const value = text(row[column]);
      if (value) (item as unknown as Record<string, string>)[key] = value;
    }
    items.push(item);
    keys.push(identityKey(item));
  }
  return { items, keys, leftOut };
}

/** The email if there is one, else the phone digits, else the lead id. */
export function identityKey(item: Pick<IngestionItem, "email" | "phone" | "leadId">): string {
  if (item.email) return `email:${item.email.toLowerCase()}`;
  const digits = (item.phone ?? "").replace(/\D/g, "");
  if (digits.length >= 7) return `phone:${digits}`;
  return `lead:${item.leadId ?? ""}`;
}

/** JSON as Python's json.dumps(separators=(",", ":"), sort_keys=True) writes it, non-ASCII escaped. */
function canonicalJson(value: { campaignId: number; keys: string[] }): string {
  const body = JSON.stringify({ campaignId: value.campaignId, keys: value.keys });
  return body.replace(/[\u0080-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function idempotencyKey(identityKeys: string[], campaignId: number): string {
  const sorted = [...identityKeys].sort();
  return `intake-${createHash("sha256").update(canonicalJson({ campaignId, keys: sorted }), "utf8").digest("hex").slice(0, 32)}`;
}

const STATUS_MESSAGES: Record<number, string> = {
  401: "The sink no longer accepts this token. Issue a new one.",
  403: "The sink refused the ingestion request (HTTP 403).",
  409: "The sink found identity conflicts that need review there; nothing was imported.",
  413: "The batch is larger than the sink accepts.",
  422: "The sink rejected the batch as duplicate or invalid; nothing was imported.",
  429: "The sink is busy. Retry the commit in a few minutes.",
};

function statusMessage(stage: string, status: number): string {
  const known = STATUS_MESSAGES[status];
  if (known) return known;
  if (status >= 500) return `The sink had an internal error (HTTP ${status}). Retry the commit later.`;
  return `The sink answered HTTP ${status} at the ${stage} step.`;
}

/** http is allowed for loopback only; anything else must be https. Returns the base without a trailing slash. */
export function validateSinkBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CommitError("preflight", null, "The sink address is not a valid URL.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new CommitError("preflight", null, "The sink address must use https (http is allowed only for localhost).");
  }
  if (url.username || url.password) throw new CommitError("preflight", null, "The sink address must not contain credentials.");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export type FetchLike = typeof fetch;

async function post(fetchImpl: FetchLike, url: string, token: string, payload: unknown, stage: "preflight" | "batch"): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new CommitError(stage, null, "The sink could not be reached. The files are kept; retry the commit when it is back.");
  }
  if (response.status !== 200 && response.status !== 201) throw new CommitError(stage, response.status, statusMessage(stage, response.status));
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new CommitError(stage, response.status, "The sink answered with something unexpected.");
  return data as Record<string, unknown>;
}

export interface CommitOptions extends CommitRequest {
  baseUrl: string;
  token: string;
  dryRun?: boolean;
  fetch?: FetchLike;
  onStarted?: (rows: number) => void;
  onPreflight?: (counts: CommitCounts) => void;
}

/** Throws CommitError; the caller records it. */
export async function commitRows(rows: Array<Record<string, unknown>>, options: CommitOptions): Promise<CommitOutcome> {
  const fetchImpl = options.fetch ?? fetch;
  if (!options.token) throw new CommitError("preflight", null, "No sink token is set; use INTAKE_SINK_TOKEN, --token or --mint-token.");
  const base = validateSinkBase(options.baseUrl);
  options.onStarted?.(rows.length);
  const { items, keys, leftOut } = buildItems(rows, options);
  if (items.length > MAX_ITEMS) throw new CommitError("preflight", null, `This run has more rows than one batch takes (${MAX_ITEMS}).`);
  const key = idempotencyKey(keys, options.campaignId);
  const counts: CommitCounts = { rows: rows.length, ready: 0, duplicate: 0, conflict: 0, invalid: leftOut };
  const readyIndexes: number[] = [];
  if (items.length) {
    const report = await post(fetchImpl, base + PREFLIGHT_PATH, options.token, { items }, "preflight");
    const statuses = report["rows"];
    if (!Array.isArray(statuses) || statuses.length !== items.length) throw new CommitError("preflight", 200, "The sink answered with an unexpected preflight result.");
    for (const row of statuses as Array<{ index?: unknown; status?: unknown }>) {
      const index = row?.index;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= items.length) {
        throw new CommitError("preflight", 200, "The sink answered with an unexpected preflight result.");
      }
      if (row.status === "READY") {
        counts.ready++;
        readyIndexes.push(index);
      } else if (row.status === "DUPLICATE") counts.duplicate++;
      else if (row.status === "CONFLICT") counts.conflict++;
      else counts.invalid++;
    }
  }
  options.onPreflight?.({ ...counts });
  let created = 0;
  let batchId: number | null = null;
  if (readyIndexes.length && !options.dryRun) {
    const payload = { idempotencyKey: key, items: readyIndexes.sort((a, b) => a - b).map((i) => items[i]) };
    const answer = await post(fetchImpl, base + BATCH_PATH, options.token, payload, "batch");
    const applications = answer["applications"];
    created = Array.isArray(applications) ? applications.length : 0;
    batchId = typeof answer["batchId"] === "number" ? answer["batchId"] : null;
  }
  return { counts, created, skipped: counts.duplicate + counts.conflict + counts.invalid, batchId, idempotencyKey: key, dryRun: options.dryRun ?? false };
}

/** Find a campaign id by name (case-insensitive) in the sink's campaign list. */
export async function lookupCampaignId(baseUrl: string, token: string, name: string, fetchImpl: FetchLike = fetch): Promise<number> {
  const base = validateSinkBase(baseUrl);
  let response: Response;
  try {
    response = await fetchImpl(base + CAMPAIGNS_PATH, { headers: { authorization: `Bearer ${token}` }, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new CommitError("preflight", null, "The sink could not be reached to look up the campaign.");
  }
  if (response.status !== 200) throw new CommitError("preflight", response.status, statusMessage("campaign lookup", response.status));
  const data = (await response.json().catch(() => null)) as { campaigns?: Array<{ id?: unknown; name?: unknown }> } | null;
  const match = data?.campaigns?.find((c) => typeof c.name === "string" && c.name.toLowerCase() === name.toLowerCase() && typeof c.id === "number");
  if (!match) throw new CommitError("preflight", null, `The sink has no campaign named "${name}". Use --campaign-id.`);
  return match.id as number;
}

/** Ask a demo sink to mint a session token. Only the mock CRM offers this. */
export async function mintDemoToken(baseUrl: string, fetchImpl: FetchLike = fetch, ttlSeconds?: number): Promise<string> {
  const base = validateSinkBase(baseUrl);
  let response: Response;
  try {
    response = await fetchImpl(`${base}/api/uploader/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ttlSeconds ? { ttlSeconds } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new CommitError("preflight", null, "The sink could not be reached to mint a demo token.");
  }
  const data = (await response.json().catch(() => null)) as { token?: unknown } | null;
  if (response.status !== 200 || typeof data?.token !== "string") throw new CommitError("preflight", response.status, "The sink does not issue demo tokens.");
  return data.token;
}
