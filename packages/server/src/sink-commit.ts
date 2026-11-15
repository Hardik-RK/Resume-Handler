/**
 * Commit a finished run to a downstream system through its ingestion API (the "ingestion" sink).
 *
 * Flow: build one ingestion item per parsed row (name, plus email or phone), POST /api/ingestion/preflight, then
 * POST /api/ingestion/batch with the READY rows only and an idempotency key that depends on the run's identities and
 * the campaign. A retry of the same run sends the same key, so the downstream system replays rather than duplicates.
 *
 * The ingestion token goes only in the Authorization header. It is never logged, never emitted and never stored in
 * the state. Server bodies are not echoed: a failure message is a fixed sentence plus the HTTP status.
 * A commit failure never fails the run; the caller keeps the CSV and records the error for the page.
 */
import crypto from "node:crypto";
import { SettingsRejected, validateSinkBase } from "./settings-store";

export const PREFLIGHT_PATH = "/api/ingestion/preflight";
export const BATCH_PATH = "/api/ingestion/batch";
export const MAX_ITEMS = 1000; // the downstream system's batch size limit
export const CONNECT_TIMEOUT_MS = 10_000;
export const READ_TIMEOUT_MS = 120_000;
export const DEFAULT_SOURCE = "Resume intake";
export const DEFAULT_STAGE = "LEAD";
export const SOURCE_MAX = 120;
export const NOT_SPECIFIED = "not specified";
/** The preflight statuses that matter (any other counts as invalid). */
export const READY = "READY";
export const DUPLICATE = "DUPLICATE";
export const CONFLICT = "CONFLICT";
const STAGE_PATTERN = /^[A-Z][A-Z_]{0,39}$/;
const MAX_CAMPAIGN_ID = 2_147_483_647;

export type Row = Record<string, unknown>;

export interface CommitRequest {
  enabled: boolean;
  campaignId: number | null;
  source: string;
  stage: string;
}

export interface IngestionItem {
  name: string;
  source: string;
  stage: string;
  campaignId: number | null;
  email?: string;
  phone?: string;
  leadId?: string;
  currentLocation?: string;
  graduation?: string;
  resumeUrl?: string;
}

/** A commit step failed. `message` is a fixed, safe sentence; `status` is the HTTP status or null. */
export class CommitError extends Error {
  constructor(readonly stage: string, readonly status: number | null, message: string) {
    super(message);
  }
}

/** Python-style str.strip() for the whitespace that matters here. */
const pyStrip = (s: string) => s.replace(/^[\s\u001c-\u001f\u0085]+|[\s\u001c-\u001f\u0085]+$/g, "");

/** The `commit` object of a POST /run body. null when absent. Throws Error with an operator-facing message. */
export function parseRequest(raw: unknown): CommitRequest | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("commit must be an object.");
  const body = raw as Record<string, unknown>;
  const enabled = "enabled" in body ? body.enabled : false;
  if (typeof enabled !== "boolean") throw new Error("commit.enabled must be true or false.");
  if (!enabled) return { enabled: false, campaignId: null, source: DEFAULT_SOURCE, stage: DEFAULT_STAGE };
  const campaign = body.campaignId;
  if (typeof campaign !== "number" || !Number.isInteger(campaign) || campaign < 1 || campaign > MAX_CAMPAIGN_ID) {
    throw new Error("commit.campaignId must be the id of a campaign (a positive whole number).");
  }
  const source = "source" in body ? body.source : DEFAULT_SOURCE;
  if (typeof source !== "string" || Array.from(source).length > SOURCE_MAX) {
    throw new Error(`commit.source must be text of up to ${SOURCE_MAX} characters.`);
  }
  const stage = "stage" in body ? body.stage : DEFAULT_STAGE;
  if (typeof stage !== "string" || !STAGE_PATTERN.test(pyStrip(stage).toUpperCase())) {
    throw new Error("commit.stage must be a CRM stage name such as LEAD.");
  }
  return { enabled: true, campaignId: campaign, source: pyStrip(source) || DEFAULT_SOURCE, stage: pyStrip(stage).toUpperCase() };
}

/** Collapse whitespace runs to single spaces (Python: " ".join(str(value or "").split()).strip()). */
function text(value: unknown): string {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return "";
  return String(value).split(/[\s\u001c-\u001f\u0085]+/).filter(Boolean).join(" ");
}

/** The identity of a candidate in a run: the email if there is one, else the phone digits, else the lead id. */
export function identityKey(item: Partial<IngestionItem>): string {
  if (item.email) return "email:" + item.email.toLowerCase();
  // The reference's \D is Unicode aware: any decimal digit (Nd) counts, not only 0-9.
  const digits = (item.phone ?? "").replace(/\P{Nd}/gu, "");
  if (Array.from(digits).length >= 7) return "phone:" + digits;
  return "lead:" + (item.leadId ?? "");
}

/** (items, identity keys of the items in the same order, rows left out for lacking a name or a contact). */
export function buildItems(rows: Row[], request: CommitRequest): { items: IngestionItem[]; keys: string[]; leftOut: number } {
  const items: IngestionItem[] = [];
  const keys: string[] = [];
  let leftOut = 0;
  for (const row of rows) {
    const name = text(row["Name"]);
    const email = text(row["Email Address"]).toLowerCase();
    const phone = text(row["Phone Number"]);
    if (!name || name.toLowerCase() === NOT_SPECIFIED || !(email || phone)) {
      leftOut += 1;
      continue;
    }
    const item: IngestionItem = { name, source: request.source, stage: request.stage, campaignId: request.campaignId };
    if (email) item.email = email;
    if (phone) item.phone = phone;
    const optional: Array<[keyof IngestionItem, string]> = [
      ["leadId", "Lead ID"],
      ["currentLocation", "Current Location"],
      ["graduation", "Graduation"],
      ["resumeUrl", "Resume"],
    ];
    for (const [key, column] of optional) {
      const value = text(row[column]);
      if (value) (item as unknown as Record<string, string>)[key] = value;
    }
    items.push(item);
    keys.push(identityKey(item));
  }
  return { items, keys, leftOut };
}

/** Compact JSON with sorted keys and ASCII-only output, the same bytes as Python's
 * json.dumps(obj, separators=(",", ":"), sort_keys=True). */
function canonicalJson(value: unknown): string {
  const ascii = (s: string) => s.replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  const walk = (v: unknown): string => {
    if (Array.isArray(v)) return "[" + v.map(walk).join(",") + "]";
    if (v !== null && typeof v === "object") {
      const entries = Object.keys(v as object).sort().map((k) => ascii(JSON.stringify(k)) + ":" + walk((v as Record<string, unknown>)[k]));
      return "{" + entries.join(",") + "}";
    }
    return ascii(JSON.stringify(v));
  };
  return walk(value);
}

/** 'intake-' + 32 hex digits from the sorted identity keys and the campaign: the same run gives the same key. */
export function idempotencyKey(identityKeys: string[], campaignId: number): string {
  const sorted = [...identityKeys].sort(compareCodePoints);
  const material = canonicalJson({ campaignId, keys: sorted });
  return "intake-" + crypto.createHash("sha256").update(material, "utf8").digest("hex").slice(0, 32);
}

/** Order by code point, like Python's sorted() on str (JS default sort compares UTF-16 units). */
function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) return x.done === y.done ? 0 : x.done ? -1 : 1;
    const cx = (x.value as string).codePointAt(0) as number;
    const cy = (y.value as string).codePointAt(0) as number;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────────────────────────
const STATUS_MESSAGES: Record<number, string> = {
  401: "The CRM no longer accepts this engine's token. Reconnect to issue a new one.",
  403: "The CRM refused the ingestion request (HTTP 403).",
  409: "The CRM found identity conflicts that need review in the CRM; nothing was imported.",
  413: "The batch is larger than the CRM accepts.",
  422: "The CRM rejected the batch as duplicate or invalid; nothing was imported.",
  429: "The CRM is busy. Retry the commit in a few minutes.",
};

function statusMessage(stage: string, status: number): string {
  const known = STATUS_MESSAGES[status];
  if (known) return known;
  if (status >= 500) return `The CRM had an internal error (HTTP ${status}). Retry the commit later.`;
  return `The CRM answered HTTP ${status} at the ${stage} step.`;
}

export type FetchLike = typeof fetch;

async function post(fetchImpl: FetchLike, url: string, token: string, payload: unknown, stage: string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      redirect: "manual",
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS + READ_TIMEOUT_MS),
    });
  } catch {
    throw new CommitError(stage, null, "The CRM could not be reached. The files are kept; retry the commit when it is back.");
  }
  if (response.status !== 200 && response.status !== 201) {
    await response.body?.cancel().catch(() => undefined);
    throw new CommitError(stage, response.status, statusMessage(stage, response.status));
  }
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new CommitError(stage, response.status, "The CRM answered with something unexpected.");
  }
  return data as Record<string, unknown>;
}

export type CommitStatus = "idle" | "running" | "done" | "failed" | "skipped";

export interface CommitSnapshot {
  configured: boolean;
  enabled: boolean;
  status: CommitStatus;
  counts: Record<string, number>;
  lastError: string | null;
  campaignId: number | null;
  idempotencyKey: string | null;
  batchId: number | null;
  tokenRejected: boolean;
}

export type CommitEmit = (type: string, data: Record<string, unknown>) => void;

/** Runs the commit for a run and keeps what the page reads as /state.commit. One commit at a time (the engine holds its
 * run flag while a commit runs). */
export class Committer {
  enabled = false;
  status: CommitStatus = "idle";
  counts: Record<string, number> = {};
  lastError: string | null = null;
  campaignId: number | null = null;
  idempotencyKey: string | null = null;
  batchId: number | null = null;
  /** The last failure was a 401: the page should reconnect (new token). */
  tokenRejected = false;
  /** Duplicates the engine dropped before sending (this run). */
  inBatchDuplicates = 0;
  /** The batch this process committed last, for an idempotent retry. */
  private lastBatch: { key: string; created: number; batchId: number | null } | null = null;

  constructor(private readonly emit: CommitEmit, private readonly fetchImpl: FetchLike = fetch, private readonly log: (m: string) => void = () => {}) {}

  snapshot(configured: boolean): CommitSnapshot {
    return {
      configured: Boolean(configured),
      enabled: this.enabled,
      status: this.status,
      counts: { ...this.counts },
      lastError: this.lastError,
      campaignId: this.campaignId,
      idempotencyKey: this.idempotencyKey,
      batchId: this.batchId,
      tokenRejected: this.tokenRejected,
    };
  }

  beginRun(enabled: boolean): void {
    this.enabled = enabled;
    this.status = enabled ? "idle" : "skipped";
    this.counts = {};
    this.lastError = null;
    this.campaignId = null;
    this.idempotencyKey = null;
    this.batchId = null;
    // A new run reports only what it added: the replay of an earlier batch is for a retry of that same run.
    this.lastBatch = null;
  }

  skip(): void {
    this.status = "skipped";
  }

  /** Commit the run's rows. Never throws: a failure is recorded in the state and emitted as commit_failed.
   * `inBatchDuplicates` is what the pipeline dropped before sending (the same person or the same file twice). */
  async run(baseUrl: unknown, token: unknown, request: CommitRequest, rows: Row[], inBatchDuplicates = 0): Promise<CommitSnapshot> {
    this.enabled = true;
    this.status = "running";
    this.counts = { rows: rows.length };
    this.lastError = null;
    this.campaignId = request.campaignId;
    this.idempotencyKey = null;
    this.batchId = null;
    this.tokenRejected = false;
    this.inBatchDuplicates = Math.trunc(Number(inBatchDuplicates) || 0);
    this.emit("commit_started", { campaignId: request.campaignId, rows: rows.length });
    try {
      if (typeof token !== "string" || !token) {
        throw new CommitError("preflight", null, "No CRM ingestion token is set; add one in the server settings.");
      }
      let base: string;
      try {
        base = validateSinkBase(baseUrl);
      } catch (err) {
        if (err instanceof SettingsRejected) throw new CommitError("preflight", null, err.message);
        throw err;
      }
      await this.commit(base, token, request, rows);
    } catch (err) {
      if (err instanceof CommitError) this.fail(err);
      else {
        // The run must never fail because of the commit.
        this.log(`ingestion commit crashed (${err instanceof Error ? err.constructor.name : "Error"})`);
        this.fail(new CommitError("batch", null, "The CRM commit hit an internal error. Retry the commit."));
      }
    }
    return this.snapshot(true);
  }

  private async commit(base: string, token: string, request: CommitRequest, rows: Row[]): Promise<void> {
    const { items, keys, leftOut } = buildItems(rows, request);
    if (items.length > MAX_ITEMS) {
      throw new CommitError("preflight", null, `This run has more rows than one CRM batch takes (${MAX_ITEMS}).`);
    }
    const key = idempotencyKey(keys, request.campaignId as number);
    this.idempotencyKey = key;

    const inBatch = this.inBatchDuplicates;
    const counts: Record<string, number> = { rows: rows.length, ready: 0, duplicate: 0, conflict: 0, invalid: leftOut, inBatchDuplicates: inBatch };
    const readyIndexes: number[] = [];
    if (items.length) {
      const report = await post(this.fetchImpl, base + PREFLIGHT_PATH, token, { items }, "preflight");
      const statuses = report.rows;
      if (!Array.isArray(statuses) || statuses.length !== items.length) {
        throw new CommitError("preflight", 200, "The CRM answered with an unexpected preflight result.");
      }
      for (const row of statuses) {
        const isObject = typeof row === "object" && row !== null && !Array.isArray(row);
        const index = isObject ? (row as Record<string, unknown>).index : null;
        const status = isObject ? (row as Record<string, unknown>).status : null;
        if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= items.length) {
          throw new CommitError("preflight", 200, "The CRM answered with an unexpected preflight result.");
        }
        if (status === READY) {
          counts.ready = (counts.ready as number) + 1;
          readyIndexes.push(index);
        } else if (status === DUPLICATE) counts.duplicate = (counts.duplicate as number) + 1;
        else if (status === CONFLICT) counts.conflict = (counts.conflict as number) + 1;
        else counts.invalid = (counts.invalid as number) + 1; // BLOCKED, REJECTED, ERROR, or anything new: not committed
      }
    }
    this.counts = { ...counts };
    this.emit("commit_preflight", { ready: counts.ready, duplicate: counts.duplicate, conflict: counts.conflict, invalid: counts.invalid });

    let created = 0;
    let batchId: number | null = null;
    if (readyIndexes.length) {
      const payload = { idempotencyKey: key, items: [...readyIndexes].sort((a, b) => a - b).map((i) => items[i]) };
      const answer = await post(this.fetchImpl, base + BATCH_PATH, token, payload, "batch");
      const applications = answer.applications;
      created = Array.isArray(applications) ? applications.length : 0;
      batchId = typeof answer.batchId === "number" && Number.isInteger(answer.batchId) ? answer.batchId : null;
      this.lastBatch = { key, created, batchId };
    } else if (this.lastBatch && this.lastBatch.key === key) {
      // Everything is already downstream from an earlier attempt of this same run: report that batch again.
      created = this.lastBatch.created;
      batchId = this.lastBatch.batchId;
    }

    const skipped = (counts.duplicate as number) + (counts.conflict as number) + (counts.invalid as number) + inBatch;
    this.status = "done";
    this.counts = { ...counts, created, skipped };
    this.batchId = batchId;
    this.emit("commit_done", { created, skipped, batchId, idempotencyKey: key });
  }

  private fail(err: CommitError): void {
    this.status = "failed";
    this.lastError = err.message;
    this.tokenRejected = err.status === 401;
    this.emit("commit_failed", { stage: err.stage, status: err.status, message: err.message });
    this.log(`ingestion commit failed at the ${err.stage} step (status ${err.status})`);
  }
}
