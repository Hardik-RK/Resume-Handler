import { createHash } from "node:crypto";

export const MAX_BATCH_SIZE = 1000;
export const STAGES = ["LEAD", "SCREENING", "INTERVIEW", "OFFER", "HIRED", "REJECTED"] as const;

export interface Campaign {
  id: number;
  name: string;
  company: string;
  type: string;
  status: "ACTIVE" | "ARCHIVED";
}

export interface Application {
  id: number;
  campaignId: number;
  profileId: number;
  leadId: string;
  name: string;
  email: string;
  phone: string;
  phoneKey: string;
  source: string;
  stage: string;
  currentLocation: string;
  graduation: string;
  resumeUrl: string;
  batchKey: string;
  createdAt: string;
}

interface Profile {
  id: number;
  canonicalLeadId: string;
}

export type RowStatus = "READY" | "DUPLICATE" | "CONFLICT" | "BLOCKED" | "REJECTED" | "ERROR";

export interface PreflightRow {
  index: number;
  status: RowStatus;
  reason?: string;
  details?: unknown;
}

export interface NormalizedItem {
  leadId: string;
  email: string;
  phone: string;
  phoneKey: string;
  name: string;
  source: string;
  stage: string;
  campaignId: number | null;
  campaign: string;
  currentLocation: string;
  graduation: string;
  resumeUrl: string;
}

export class IngestionError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

type Json = Record<string, unknown>;

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).replace(/\s+/g, " ").trim();
}

function pick(item: Json, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = item[key];
    if (value !== undefined && value !== null) return value;
  }
  return "";
}

export function normalizeEmail(value: unknown): string {
  return text(value).toLowerCase();
}

/** Last ten digits, the same identity the uploader's Lead ID uses. Fewer than seven digits is not a phone. */
export function normalizePhoneKey(value: unknown): string {
  const digits = text(value).replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-10) : "";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableHash(value: unknown): string {
  return sha256(JSON.stringify(value));
}

export function normalizeItem(input: unknown): NormalizedItem {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new IngestionError(422, "Each item must be an object.");
  const item = input as Json;
  const email = normalizeEmail(pick(item, "email", "emailAddress", "Email Address"));
  const phone = text(pick(item, "phone", "phoneNumber", "Phone Number"));
  const phoneKey = normalizePhoneKey(phone);
  const suppliedLead = text(pick(item, "leadId", "Lead ID"));
  const leadId = suppliedLead || (email || phoneKey ? `derived-${sha256(`${email}|${phoneKey}`).slice(0, 24)}` : "");
  const rawCampaign = pick(item, "campaignId", "campaign_id");
  const campaignId = rawCampaign === "" ? null : Number(rawCampaign);
  const stage = text(pick(item, "stage", "Stage")).toUpperCase().replace(/[ -]+/g, "_") || "LEAD";
  const normalized: NormalizedItem = {
    leadId,
    email,
    phone,
    phoneKey,
    name: text(pick(item, "name", "Name")),
    source: text(pick(item, "source", "Source")),
    stage,
    campaignId: campaignId !== null && Number.isInteger(campaignId) ? campaignId : null,
    campaign: text(pick(item, "campaign", "campaignName")),
    currentLocation: text(pick(item, "currentLocation")),
    graduation: text(pick(item, "graduation")),
    resumeUrl: text(pick(item, "resumeUrl")),
  };
  if (!normalized.leadId || (!normalized.email && !normalized.phoneKey)) {
    throw new IngestionError(422, "Each application needs a lead ID, email, or phone number.");
  }
  if (!normalized.name) throw new IngestionError(422, "Each application needs a name.");
  if (!(STAGES as readonly string[]).includes(stage)) throw new IngestionError(422, `Unknown stage: ${stage}.`);
  return normalized;
}

export interface BatchResult {
  batchId: number;
  idempotencyKey: string;
  applications: Array<{ id: number; applicationKey: string; profileId: number; campaignId: number }>;
  assignment: { assigned: number; unassigned: number };
  replayed?: boolean;
}

interface StoredBatch {
  id: number;
  key: string;
  requestHash: string;
  actor: string;
  createdAt: string;
  result: BatchResult;
}

interface Classified {
  row: PreflightRow;
  item?: NormalizedItem;
  campaign?: Campaign;
  profileId?: number;
}

export class CrmStore {
  campaigns: Campaign[];
  applications: Application[] = [];
  batches: StoredBatch[] = [];
  private profiles: Profile[] = [];
  private identifiers = new Map<string, number>(); // "KIND|value" -> profile id
  private nextApplication = 1;
  private nextProfile = 1;
  private nextBatch = 1;

  constructor(campaigns: Campaign[] = defaultCampaigns()) {
    this.campaigns = campaigns;
  }

  reset(): void {
    this.applications = [];
    this.batches = [];
    this.profiles = [];
    this.identifiers.clear();
    this.nextApplication = this.nextProfile = this.nextBatch = 1;
  }

  activeCampaigns(): Campaign[] {
    return this.campaigns.filter((c) => c.status !== "ARCHIVED");
  }

  private identifierKeys(item: NormalizedItem): string[] {
    const keys: string[] = [];
    if (item.leadId) keys.push(`LEAD_ID|${item.leadId.toLowerCase()}`);
    if (item.email) keys.push(`EMAIL|${item.email}`);
    if (item.phoneKey) keys.push(`PHONE_KEY|${item.phoneKey}`);
    return keys;
  }

  private resolveCampaign(item: NormalizedItem): Campaign {
    let campaign: Campaign | undefined;
    if (item.campaignId !== null && item.campaignId > 0) campaign = this.campaigns.find((c) => c.id === item.campaignId);
    else if (item.campaign) campaign = this.campaigns.find((c) => c.name.toLowerCase() === item.campaign.toLowerCase());
    if (!campaign) throw new IngestionError(422, `Unknown campaign: ${item.campaign || item.campaignId || "(missing)"}.`);
    if (campaign.status === "ARCHIVED") throw new IngestionError(422, `Campaign is archived: ${campaign.company} - ${campaign.name}.`);
    return campaign;
  }

  preflight(items: unknown): { ready: number; total: number; rows: PreflightRow[] } {
    if (!Array.isArray(items) || items.length === 0) throw new IngestionError(400, "items must be a non-empty array.");
    if (items.length > MAX_BATCH_SIZE) throw new IngestionError(413, `A batch may contain at most ${MAX_BATCH_SIZE} applications.`);
    const rows = this.classify(items).map((r) => r.row);
    return { ready: rows.filter((r) => r.status === "READY").length, total: rows.length, rows };
  }

  private classify(items: unknown[]): Classified[] {
    const claimed = new Map<string, number>(); // "campaign|identifier" -> row index
    const out: Classified[] = [];
    items.forEach((raw, index) => {
      try {
        const item = normalizeItem(raw);
        const campaign = this.resolveCampaign(item);
        const keys = this.identifierKeys(item);
        const profileIds = [...new Set(keys.map((k) => this.identifiers.get(k)).filter((v): v is number => v !== undefined))];
        if (profileIds.length > 1) {
          out.push({
            row: {
              index,
              status: "CONFLICT",
              reason: "Identity identifiers point to different candidate profiles.",
              details: { index, campaignId: campaign.id, leadId: item.leadId, email: item.email, phoneKey: item.phoneKey, profileIds },
            },
          });
          return;
        }
        const clash = keys.map((k) => claimed.get(`${campaign.id}|${k}`)).find((v) => v !== undefined);
        if (clash !== undefined) {
          out.push({ row: { index, status: "DUPLICATE", reason: `Matches row ${clash} in this batch by email, phone, or lead ID.` } });
          return;
        }
        for (const k of keys) claimed.set(`${campaign.id}|${k}`, index);
        const profileId = profileIds[0];
        if (profileId !== undefined && this.applications.some((a) => a.campaignId === campaign.id && a.profileId === profileId)) {
          out.push({ row: { index, status: "DUPLICATE", reason: "Application already exists for this campaign and candidate." } });
          return;
        }
        out.push({ row: { index, status: "READY" }, item, campaign, ...(profileId !== undefined ? { profileId } : {}) });
      } catch (err) {
        if (!(err instanceof IngestionError)) throw err;
        out.push({ row: { index, status: "ERROR", reason: err.message } });
      }
    });
    return out;
  }

  commitBatch(input: { idempotencyKey?: unknown; items?: unknown; actor?: string }): BatchResult {
    const key = text(input.idempotencyKey);
    if (!key || key.length > 200) throw new IngestionError(400, "idempotencyKey is required and must be 200 characters or fewer.");
    const items = input.items;
    if (!Array.isArray(items) || items.length === 0) throw new IngestionError(400, "items must be a non-empty array.");
    if (items.length > MAX_BATCH_SIZE) throw new IngestionError(413, `A batch may contain at most ${MAX_BATCH_SIZE} applications.`);
    const requestHash = stableHash(items);
    const previous = this.batches.find((b) => b.key === key);
    if (previous) {
      if (previous.requestHash !== requestHash) throw new IngestionError(409, "This idempotency key was already used with a different payload.");
      return { ...previous.result, replayed: true };
    }
    const classified = this.classify(items);
    if (classified.some((c) => c.row.status === "CONFLICT")) {
      throw new IngestionError(409, "Identity conflicts need review before this batch can be imported.", { rows: classified.map((c) => c.row) });
    }
    const invalid = classified.filter((c) => c.row.status !== "READY");
    if (invalid.length) {
      throw new IngestionError(422, "The batch contains duplicate or invalid applications; nothing was imported.", { rows: invalid.map((c) => c.row) });
    }
    const batchId = this.nextBatch++;
    const now = new Date().toISOString();
    const applications: BatchResult["applications"] = [];
    for (const entry of classified) {
      const item = entry.item as NormalizedItem;
      const campaign = entry.campaign as Campaign;
      let profileId = entry.profileId;
      if (profileId === undefined) {
        profileId = this.nextProfile++;
        this.profiles.push({ id: profileId, canonicalLeadId: item.leadId });
      }
      for (const k of this.identifierKeys(item)) if (!this.identifiers.has(k)) this.identifiers.set(k, profileId);
      const app: Application = {
        id: this.nextApplication++,
        campaignId: campaign.id,
        profileId,
        leadId: item.leadId,
        name: item.name,
        email: item.email,
        phone: item.phone,
        phoneKey: item.phoneKey,
        source: item.source,
        stage: item.stage,
        currentLocation: item.currentLocation,
        graduation: item.graduation,
        resumeUrl: item.resumeUrl,
        batchKey: key,
        createdAt: now,
      };
      this.applications.push(app);
      applications.push({ id: app.id, applicationKey: `${campaign.id}:${item.leadId}`, profileId, campaignId: campaign.id });
    }
    const result: BatchResult = { batchId, idempotencyKey: key, applications, assignment: { assigned: 0, unassigned: applications.length } };
    this.batches.push({ id: batchId, key, requestHash, actor: input.actor ?? "resume_uploader", createdAt: now, result });
    return result;
  }
}

export function defaultCampaigns(): Campaign[] {
  return [
    { id: 1, name: "Backend Engineer", company: "Northwind Demo Co", type: "TECH", status: "ACTIVE" },
    { id: 2, name: "Teacher", company: "Northwind Demo Co", type: "TEACHER", status: "ACTIVE" },
    { id: 3, name: "Sales", company: "Northwind Demo Co", type: "SALES", status: "ACTIVE" },
    { id: 4, name: "Operations Analyst", company: "Northwind Demo Co", type: "OPERATIONS", status: "ARCHIVED" },
  ];
}
