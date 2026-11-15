/**
 * Google Drive upload for the pipeline (port of pipeline/drive.py).
 *
 * - Credentials come from the signed-in admin's token JSON (secret "googleTokenJson"); the token's own scope is
 *   used and never widened. A failed refresh raises DriveAuthError before any parsing.
 * - Dedupe is by content: every file is stored with appProperties.contentSha256, and one batched folder listing
 *   per folder per run builds the sha -> file map. A matching hash reuses the file.
 * - A name clash with a different file gets a per-run suffix, so a generic "CV.pdf" never reuses another
 *   candidate's file.
 * - Files are created PRIVATE: no permissions call is ever made.
 * - 403/429/5xx retry with exponential backoff that stops immediately on cancel.
 *
 * The transport is behind the `DriveClient` interface (types.ts): `createGoogleDrive()` speaks the REST API with
 * plain `fetch`; `createFakeDrive()` is the in-memory stand-in used by tests and the demo.
 */
import fs from "node:fs";
import { CancelFlag } from "./concurrency.js";
import { Cancelled, DriveAuthError, errorName } from "./errors.js";
import type { DriveClient, DriveFactory, DriveFile } from "./types.js";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
export const RETRY_STATUSES = new Set([403, 429, 500, 502, 503, 504]);

/** A Drive API failure with its HTTP status. */
export class DriveHttpError extends Error {
  override name = "HttpError";
  constructor(
    readonly status: number,
    message = `Drive HTTP ${status}`,
  ) {
    super(message);
  }
}

export interface GoogleCredentials {
  accessToken(): Promise<string>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const REFRESH_THRESHOLD_MS = (3 * 60 + 45) * 1000;

/** Build Google credentials from the token JSON and refresh them when needed. Throws DriveAuthError. */
export async function loadCredentials(
  tokenJson: string | Record<string, unknown> | null | undefined,
  options: { fetch?: FetchLike; now?: () => number } = {},
): Promise<GoogleCredentials> {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  let info: Record<string, any>;
  try {
    const parsed = typeof tokenJson === "string" ? JSON.parse(tokenJson) : { ...(tokenJson ?? {}) };
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("not an object");
    info = parsed as Record<string, any>;
  } catch {
    throw new DriveAuthError("Google token invalid: the token is not valid JSON");
  }
  if (!info["refresh_token"]) throw new DriveAuthError("Google token invalid: no refresh token; sign in again");
  if (!info["client_id"] || !info["client_secret"]) throw new DriveAuthError("Google token invalid: the token is incomplete");

  let token: string | null = info["token"] || info["access_token"] || null;
  let expiry: number | null = null;
  if (typeof info["expiry"] === "string") {
    const parsed = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(info["expiry"]) ? info["expiry"] : info["expiry"] + "Z");
    expiry = Number.isNaN(parsed) ? null : parsed;
  }
  const valid = (): boolean => !!token && (expiry === null || now() < expiry - REFRESH_THRESHOLD_MS);

  const refresh = async (): Promise<void> => {
    const res = await doFetch(String(info["token_uri"] || "https://oauth2.googleapis.com/token"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: String(info["client_id"]),
        client_secret: String(info["client_secret"]),
        refresh_token: String(info["refresh_token"]),
      }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`refresh failed (${res.status})`);
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error("no access token in the refresh reply");
    token = data.access_token;
    expiry = now() + (Number(data.expires_in) || 3600) * 1000;
  };

  try {
    if (!valid()) await refresh();
  } catch {
    throw new DriveAuthError("Google token invalid: refresh failed; sign in again");
  }
  return {
    async accessToken() {
      if (!valid()) {
        try {
          await refresh();
        } catch {
          throw new DriveAuthError("Google token invalid: refresh failed; sign in again");
        }
      }
      return token!;
    },
  };
}

const quote = (value: string): string => String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

/** Google Drive v3 over REST (list a folder, create a file with a resumable upload). */
export function createGoogleDrive(credentials: GoogleCredentials, options: { fetch?: FetchLike } = {}): DriveClient {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const auth = async (): Promise<Record<string, string>> => ({ Authorization: `Bearer ${await credentials.accessToken()}` });
  return {
    async listFolder(folderId, pageToken) {
      const params = new URLSearchParams({
        q: `'${quote(folderId)}' in parents and trashed=false`,
        fields: "nextPageToken, files(id, name, webViewLink, appProperties)",
        pageSize: "1000",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await doFetch(`${API}/files?${params.toString()}`, { headers: await auth() });
      if (!res.ok) throw new DriveHttpError(res.status);
      return (await res.json()) as { files: DriveFile[]; nextPageToken?: string | null };
    },
    async createFile(request) {
      const bytes = await fs.promises.readFile(request.path);
      const metadata = { name: request.name, parents: request.parents, appProperties: request.appProperties };
      const init = await doFetch(`${UPLOAD_API}/files?uploadType=resumable&fields=id,webViewLink,name`, {
        method: "POST",
        headers: {
          ...(await auth()),
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": request.mimeType,
          "X-Upload-Content-Length": String(bytes.length),
        },
        body: JSON.stringify(metadata),
      });
      if (!init.ok) throw new DriveHttpError(init.status);
      const location = init.headers.get("location");
      if (!location) throw new DriveHttpError(502, "Drive gave no upload location");
      const put = await doFetch(location, {
        method: "PUT",
        headers: { "Content-Type": request.mimeType, "Content-Length": String(bytes.length) },
        body: bytes,
      });
      if (!put.ok) throw new DriveHttpError(put.status);
      return (await put.json()) as DriveFile;
    },
  };
}

interface FolderIndex {
  bySha: Map<string, DriveFile>;
  names: Set<string>;
}

export interface UploadRecord {
  id: string;
  url: string;
  created: boolean;
  name: string;
}

export interface UploaderOptions {
  /** a client or a factory for one */
  client: DriveFactory;
  cancel: CancelFlag;
  runId: string;
  maxAttempts?: number;
  backoffBase?: number;
  log?: (message: string) => void;
  rng?: () => number;
}

export class DriveUploader {
  readonly stats = { created: 0, reused: 0, retries: 0 };
  private readonly cancel: CancelFlag;
  private readonly runId: string;
  private readonly maxAttempts: number;
  private readonly backoffBase: number;
  private readonly rng: () => number;
  private readonly clientSource: DriveFactory;
  private svc: DriveClient | null = null;
  private readonly folders = new Map<string, Promise<FolderIndex>>();

  constructor(options: UploaderOptions) {
    if (!options.client) throw new Error("DriveUploader needs a client or a client factory");
    this.clientSource = options.client;
    this.cancel = options.cancel;
    this.runId = options.runId;
    this.maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? 4));
    this.backoffBase = options.backoffBase ?? 2.0;
    this.rng = options.rng ?? Math.random;
  }

  service(): DriveClient {
    if (!this.svc) this.svc = typeof this.clientSource === "function" ? this.clientSource() : this.clientSource;
    return this.svc;
  }

  /** One batched listing per folder per run. */
  private index(folderId: string): Promise<FolderIndex> {
    let pending = this.folders.get(folderId);
    if (!pending) {
      pending = (async () => {
        const svc = this.service();
        const bySha = new Map<string, DriveFile>();
        const names = new Set<string>();
        let token: string | undefined;
        for (;;) {
          const page = await svc.listFolder(folderId, token);
          for (const item of page.files ?? []) {
            names.add(item.name ?? "");
            const sha = item.appProperties?.["contentSha256"] ?? "";
            if (sha && !bySha.has(sha)) bySha.set(sha, item);
          }
          token = page.nextPageToken ?? undefined;
          if (!token) break;
        }
        return { bySha, names };
      })();
      this.folders.set(folderId, pending);
      // a failed listing must be retried by the next upload, not cached
      pending.catch(() => this.folders.delete(folderId));
    }
    return pending;
  }

  private freeName(folder: FolderIndex, name: string): string {
    const dot = name.lastIndexOf(".");
    const [stem, suffix] = dot === -1 ? [name, ""] : [name.slice(0, dot), name.slice(dot)];
    let candidate = name;
    let n = 1;
    while (folder.names.has(candidate)) {
      const tag = (this.runId.split("-").pop() || "run").slice(0, 6);
      candidate = n === 1 ? `${stem}_${tag}${suffix}` : `${stem}_${tag}_${n}${suffix}`;
      n++;
    }
    folder.names.add(candidate);
    return candidate;
  }

  /** Return {id, url, created, name}. Reuses an existing file with the same content hash. */
  async upload(filePath: string, sha256: string, displayName: string, folderId: string): Promise<UploadRecord> {
    if (this.cancel.isSet()) throw new Cancelled();
    const folder = await this.index(folderId);
    const existing = folder.bySha.get(sha256);
    const name = existing === undefined ? this.freeName(folder, displayName || `${sha256.slice(0, 12)}.pdf`) : "";
    if (existing !== undefined) {
      this.stats.reused++;
      return {
        id: existing.id,
        url: existing.webViewLink || `https://drive.google.com/file/d/${existing.id}/view`,
        created: false,
        name: existing.name ?? "",
      };
    }

    let created: DriveFile | undefined;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        created = await this.service().createFile({
          name,
          parents: [folderId],
          appProperties: { contentSha256: sha256, uploaderRun: this.runId.slice(0, 64) },
          path: filePath,
          mimeType: "application/pdf",
        });
        break;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status !== undefined && RETRY_STATUSES.has(status) && attempt < this.maxAttempts - 1) {
          this.stats.retries++;
          await this.wait(this.backoffBase ** attempt * (0.8 + 0.4 * this.rng()));
          continue;
        }
        throw error;
      }
    }
    if (!created) throw new Error("upload gave no result");
    folder.bySha.set(sha256, created);
    this.stats.created++;
    return {
      id: created.id,
      url: created.webViewLink || `https://drive.google.com/file/d/${created.id}/view`,
      created: true,
      name: created.name ?? name,
    };
  }

  private async wait(seconds: number): Promise<void> {
    if (await this.cancel.wait(seconds * 1000)) throw new Cancelled();
  }
}

/** Short, PII-free reason for a failed upload. */
export function driveErrorReason(exc: unknown): string {
  const status = (exc as { status?: number } | null)?.status;
  if (status) return `Drive error ${status}`;
  return errorName(exc).replace(/\s+/g, " ").slice(0, 80);
}
