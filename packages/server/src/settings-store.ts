/**
 * Server settings.
 *
 * - Config (the shared parameters the page pushes, plus server-local options) lives in <config dir>/config.json. Writes are
 *   atomic (temp file, fsync, rename). A config file that cannot be read is never overwritten: it is kept and the error is
 *   reported, and writes are refused until it is fixed.
 * - Secrets (LLM key, Google client secrets, Google token, ingestion token) are encrypted with AES-256-GCM into a vault file
 *   next to config.json. The key comes from INTAKE_SECRETS_KEY (64 hex characters or base64 of 32 bytes) or from a generated
 *   key file (secrets.key, mode 0600). If neither is usable they stay in memory and a warning is reported in /state.
 *   Secrets are never written to config.json, logs or the data folders, and the API only ever reports whether one is set.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { registerSecret } from "./events";

export const SECRET_NAMES = ["openrouterApiKey", "googleClientSecrets", "googleTokenJson", "ingestionToken"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];
export const CONFIG_SCHEMA = 1;
export const MAX_SECRET_CHARS = 256 * 1024;
export const MAX_TOKEN_CHARS = 512;
export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost"];
export const LLM_HOST = "openrouter.ai";
export const MEMORY_WARNING =
  "No secure store is available: secrets are kept in memory only and must be sent again after the server restarts.";

/** config.json exists but cannot be read. It is left untouched and writes are refused (HTTP 409). */
export class ConfigUnreadable extends Error {}

/** Bad input (HTTP 400). */
export class SettingsInvalid extends Error {}

/** A setting the server will not accept (HTTP 422). The message is fit to show the operator. */
export class SettingsRejected extends SettingsInvalid {}

// ── URL rules ───────────────────────────────────────────────────────────────────────────────────────────────────
export interface UrlParts {
  scheme: string;
  netloc: string;
  path: string;
  query: string;
  fragment: string;
  username: string | null;
  password: string | null;
  hostname: string | null;
  port: number | null;
}

/** Split a URL the way Python's urllib.parse.urlsplit does (netloc is kept as typed). Throws when the port is bad. */
export function splitUrl(raw: string): UrlParts {
  // urlsplit drops leading C0 controls and spaces, and removes tab, CR and LF anywhere.
  let rest = raw.replace(/^[\u0000- ]+/, "").replace(/[\t\r\n]/g, "");
  let scheme = "";
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(rest);
  if (schemeMatch) {
    scheme = (schemeMatch[1] as string).toLowerCase();
    rest = rest.slice(schemeMatch[0].length);
  }
  let netloc = "";
  if (rest.startsWith("//")) {
    const end = rest.slice(2).search(/[/?#]/);
    netloc = end === -1 ? rest.slice(2) : rest.slice(2, 2 + end);
    rest = end === -1 ? "" : rest.slice(2 + end);
  }
  let fragment = "";
  const hash = rest.indexOf("#");
  if (hash !== -1) {
    fragment = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }
  let query = "";
  const q = rest.indexOf("?");
  if (q !== -1) {
    query = rest.slice(q + 1);
    rest = rest.slice(0, q);
  }
  const at = netloc.lastIndexOf("@");
  const userinfo = at === -1 ? null : netloc.slice(0, at);
  const hostinfo = at === -1 ? netloc : netloc.slice(at + 1);
  let username: string | null = null;
  let password: string | null = null;
  if (userinfo !== null) {
    const colon = userinfo.indexOf(":");
    username = colon === -1 ? userinfo : userinfo.slice(0, colon);
    password = colon === -1 ? null : userinfo.slice(colon + 1);
  }
  let hostname: string | null = null;
  let portText: string | null = null;
  if (hostinfo.startsWith("[")) {
    const close = hostinfo.indexOf("]");
    if (close !== -1) {
      hostname = hostinfo.slice(1, close);
      const tail = hostinfo.slice(close + 1);
      if (tail.startsWith(":")) portText = tail.slice(1);
    } else {
      hostname = hostinfo;
    }
  } else {
    const colon = hostinfo.indexOf(":");
    hostname = colon === -1 ? hostinfo : hostinfo.slice(0, colon);
    if (colon !== -1) portText = hostinfo.slice(colon + 1);
  }
  hostname = hostname ? hostname.toLowerCase() : null;
  let port: number | null = null;
  if (portText) {
    if (!/^[0-9]+$/.test(portText)) throw new Error("Port could not be cast to integer value");
    port = Number(portText);
    if (port < 0 || port > 65535) throw new Error("Port out of range 0-65535");
  }
  return { scheme, netloc, path: rest, query, fragment, username, password, hostname, port };
}

function parts(raw: unknown, label: string): UrlParts {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 300) {
    throw new SettingsRejected(`${label} must be a web address.`);
  }
  let p: UrlParts;
  try {
    p = splitUrl(raw.trim());
  } catch {
    throw new SettingsRejected(`${label} is not a valid address.`);
  }
  if (p.username || p.password || p.query || p.fragment || !p.hostname) {
    throw new SettingsRejected(`${label} must not contain a user name, a query or a fragment.`);
  }
  return p;
}

/** crmBaseUrl: the downstream system's origin. https only; plain http only for 127.0.0.1 or localhost (tests, local demos). No path. */
export function validateSinkBase(raw: unknown): string {
  const p = parts(raw, "crmBaseUrl");
  if (p.path !== "" && p.path !== "/") throw new SettingsRejected("crmBaseUrl must be the CRM origin only (no path).");
  if (p.scheme === "https" || (p.scheme === "http" && LOOPBACK_HOSTS.includes(p.hostname as string))) {
    return `${p.scheme}://${p.netloc}`;
  }
  throw new SettingsRejected("crmBaseUrl must use https (plain http is allowed only for 127.0.0.1 or localhost).");
}

/** llmBaseUrl allowlist: https://openrouter.ai (any path), or http://127.0.0.1:<port> for tests and the offline demo. */
export function validateLlmBaseUrl(raw: unknown): string {
  const p = parts(raw, "llmBaseUrl");
  const clean = (raw as string).trim().replace(/\/+$/, "");
  if (p.scheme === "https" && p.hostname === LLM_HOST && (p.port === null || p.port === 443)) return clean;
  if (p.scheme === "http" && p.hostname === "127.0.0.1") return clean;
  throw new SettingsRejected(
    "llmBaseUrl is not allowed: use https://openrouter.ai/api/v1 (the only LLM provider the server supports).",
  );
}

// ── files ───────────────────────────────────────────────────────────────────────────────────────────────────────
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Windows can refuse a rename while an antivirus or indexer holds the file; a short retry clears it. */
function renameWithRetry(src: string, dst: string, attempts = 8): void {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.renameSync(src, dst);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") || attempt === attempts - 1) throw err;
      sleepSync(50 * (attempt + 1));
    }
  }
}

/** Write a file atomically: temp file in the same folder, fsync, rename. A failure leaves the old file and no temp file. */
export function atomicWriteBytes(file: string, data: Uint8Array | string, mode?: number): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(16).toString("hex")}.tmp`);
  try {
    const fd = fs.openSync(tmp, "wx", mode);
    try {
      fs.writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameWithRetry(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    throw err;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** {"schemaVersion": 1, "settings": {...shared parameters...}, "engine": {...local options...}} in config.json. */
export class ConfigStore {
  settings: Record<string, unknown> = {};
  engine: Record<string, unknown> = {};
  error: string | null = null;
  unreadable = false;

  constructor(readonly file: string, private readonly log: (message: string) => void = () => {}) {}

  load(): void {
    this.settings = {};
    this.engine = {};
    this.error = null;
    this.unreadable = false;
    if (!fs.existsSync(this.file)) return;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(this.file));
      const data: unknown = JSON.parse(text);
      if (!isRecord(data)) throw new TypeError("the file does not hold a JSON object");
      const settings = data.settings ?? {};
      const engine = data.engine ?? {};
      if (!isRecord(settings) || !isRecord(engine)) throw new TypeError("unexpected structure");
      this.settings = settings;
      this.engine = engine;
    } catch (err) {
      this.unreadable = true;
      const kind = err instanceof Error ? err.constructor.name : "Error";
      this.error = `config.json could not be read (${kind}). It was left untouched; fix or remove it and restart the server.`;
      this.log(`config.json could not be read (${kind}); it was left untouched`);
    }
  }

  save(settings?: Record<string, unknown>, engine?: Record<string, unknown>): void {
    if (this.unreadable) throw new ConfigUnreadable(this.error ?? "config.json could not be read.");
    const newSettings = { ...(settings ?? this.settings) };
    for (const name of SECRET_NAMES) delete newSettings[name]; // secrets never reach the file, even if sent by mistake
    const newEngine = { ...(engine ?? this.engine) };
    const payload = { schemaVersion: CONFIG_SCHEMA, settings: newSettings, engine: newEngine };
    atomicWriteBytes(this.file, JSON.stringify(payload, null, 2));
    this.settings = newSettings;
    this.engine = newEngine;
  }
}

// ── secret vault (AES-256-GCM) ──────────────────────────────────────────────────────────────────────────────────
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function parseSecretsKey(text: string): Buffer {
  const trimmed = text.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === KEY_BYTES && /^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) return decoded;
  throw new Error("INTAKE_SECRETS_KEY must be 64 hex characters or the base64 of 32 random bytes.");
}

export function encryptSecret(key: Buffer, name: string, value: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(name, "utf8")); // binds the ciphertext to its name
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function decryptSecret(key: Buffer, name: string, blob: string): string {
  const raw = Buffer.from(blob, "base64");
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("vault entry is too short");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(name, "utf8"));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
}

export interface Vault {
  get(name: string): string | null;
  put(name: string, value: string): void;
  remove(name: string): void;
}

/** Secrets encrypted with AES-256-GCM, stored as JSON on disk. */
export class EncryptedVault implements Vault {
  constructor(readonly file: string, private readonly key: Buffer) {
    if (key.length !== KEY_BYTES) throw new Error("The vault key must be 32 bytes.");
  }

  private read(): Record<string, string> {
    if (!fs.existsSync(this.file)) return {};
    try {
      const data: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const items = isRecord(data) ? data.items : undefined;
      if (!isRecord(items)) throw new TypeError("items is not an object");
      return Object.fromEntries(Object.entries(items).filter((e): e is [string, string] => typeof e[1] === "string"));
    } catch (err) {
      throw new ConfigUnreadable("The secret vault file could not be read and was left untouched.", { cause: err });
    }
  }

  private write(items: Record<string, string>): void {
    atomicWriteBytes(this.file, JSON.stringify({ schemaVersion: 1, items }), 0o600);
  }

  get(name: string): string | null {
    const blob = this.read()[name];
    return blob ? decryptSecret(this.key, name, blob) : null;
  }

  put(name: string, value: string): void {
    const items = this.read();
    items[name] = encryptSecret(this.key, name, value);
    this.write(items);
  }

  remove(name: string): void {
    if (!fs.existsSync(this.file)) return;
    const items = this.read();
    if (name in items) {
      delete items[name];
      this.write(items);
    }
  }
}

/** The vault key: INTAKE_SECRETS_KEY, else the key file (created with mode 0600 on first use). Throws for a bad key. */
export function resolveSecretsKey(keyFile: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  const fromEnv = env.INTAKE_SECRETS_KEY;
  if (fromEnv && fromEnv.trim()) return parseSecretsKey(fromEnv);
  if (fs.existsSync(keyFile)) return parseSecretsKey(fs.readFileSync(keyFile, "utf8"));
  const key = crypto.randomBytes(KEY_BYTES);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  try {
    fs.writeFileSync(keyFile, key.toString("base64"), { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return parseSecretsKey(fs.readFileSync(keyFile, "utf8"));
    throw err;
  }
  return key;
}

/** Keeps the secret values in memory and mirrors them to the vault. */
export class SecretStore {
  private values_: Record<string, string> = {};
  warnings: string[] = [];

  constructor(private readonly vault: Vault | null) {}

  backendName(): string {
    return this.vault !== null ? "vault" : "memory";
  }

  private warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  load(): void {
    this.warnings = [];
    const values: Record<string, string> = {};
    for (const name of SECRET_NAMES) {
      const value = this.readOne(name);
      if (value) {
        values[name] = value;
        registerSecret(value);
      }
    }
    this.values_ = values;
    if (this.vault === null) this.warn(MEMORY_WARNING);
  }

  private readOne(name: string): string | null {
    if (this.vault === null) return null;
    try {
      return this.vault.get(name) || null;
    } catch {
      this.warn(`${name} could not be read from the secret vault.`);
      return null;
    }
  }

  values(): Record<string, string> {
    return { ...this.values_ };
  }

  presence(): Record<SecretName, boolean> {
    return Object.fromEntries(SECRET_NAMES.map((name) => [name, Boolean(this.values_[name])])) as Record<SecretName, boolean>;
  }

  update(changes: Record<string, string | null>): void {
    for (const [name, value] of Object.entries(changes)) {
      if (value === null) {
        this.deleteOne(name);
        delete this.values_[name];
        continue;
      }
      let stored = false;
      if (this.vault !== null) {
        try {
          this.vault.put(name, value);
          stored = true;
        } catch {
          this.warn(`${name} could not be saved to the secret vault; it is kept in memory only.`);
        }
      }
      if (!stored) this.warn(`${name} is kept in memory only and must be sent again after a restart.`);
      this.values_[name] = value;
      registerSecret(value);
    }
  }

  private deleteOne(name: string): void {
    if (this.vault === null) return;
    try {
      this.vault.remove(name);
    } catch {
      this.warn(`${name} could not be removed from the secret vault.`);
    }
  }
}

/** The production secret store: an encrypted vault next to config.json. A bad INTAKE_SECRETS_KEY throws; a folder that cannot be
 * written degrades to memory only (the warning shows in /state). */
export function createSecretStore(configDir: string, env: NodeJS.ProcessEnv = process.env): SecretStore {
  const keyFile = path.join(configDir, "secrets.key");
  let key: Buffer;
  try {
    key = resolveSecretsKey(keyFile, env);
  } catch (err) {
    if (env.INTAKE_SECRETS_KEY?.trim() || fs.existsSync(keyFile)) throw err;
    return new SecretStore(null);
  }
  return new SecretStore(new EncryptedVault(path.join(configDir, "secrets.vault.json"), key));
}

function normaliseSecret(name: string, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  let text: string;
  if (typeof value === "object") text = JSON.stringify(value);
  else if (typeof value === "string") text = value;
  else throw new SettingsInvalid(`${name} has an unsupported type.`);
  if (text.length > MAX_SECRET_CHARS) throw new SettingsInvalid(`${name} is too large.`);
  if (name === "openrouterApiKey") {
    if (Array.from(text).length < 8 || /\s/.test(text)) throw new SettingsInvalid("The OpenRouter key looks invalid.");
  } else if (name === "ingestionToken") {
    const length = Array.from(text).length;
    if (length < 16 || length > MAX_TOKEN_CHARS || /\s/.test(text)) throw new SettingsInvalid("The ingestion token looks invalid.");
  } else {
    try {
      JSON.parse(text);
    } catch {
      throw new SettingsInvalid(`${name} must be valid JSON.`);
    }
  }
  return text;
}

const textOf = (v: unknown, max: number): boolean => typeof v === "string" && Array.from(v).length <= max;

/** campaigns: up to 500 of {id, name, group?, type?, driveFolderId?}. */
export function validateCampaigns(raw: unknown): void {
  if (!Array.isArray(raw) || raw.length > 500) throw new SettingsRejected("campaigns must be a list of up to 500 campaigns.");
  for (const c of raw) {
    const o = isRecord(c) ? c : null;
    const idOk = o !== null && ((typeof o.id === "number" && Number.isFinite(o.id)) || (typeof o.id === "string" && o.id !== "" && textOf(o.id, 64)));
    const nameOk = o !== null && typeof o.name === "string" && o.name.trim() !== "" && textOf(o.name, 200);
    const optOk = o !== null && [["group", 120], ["type", 120], ["driveFolderId", 200]].every(([k, max]) => o[k as string] === undefined || o[k as string] === null || textOf(o[k as string], max as number));
    if (!idOk || !nameOk || !optOk) throw new SettingsRejected("Each campaign needs an id and a name (group, type and driveFolderId are optional text).");
  }
}

/** platforms / campaignTypes: up to 200 names, as text or {name}. */
export function validateNameList(raw: unknown, label: string): void {
  if (!Array.isArray(raw) || raw.length > 200) throw new SettingsRejected(label + " must be a list of up to 200 names.");
  for (const item of raw) {
    const name = typeof item === "string" ? item : isRecord(item) ? item.name : undefined;
    if (typeof name !== "string" || !name.trim() || !textOf(name, 120)) throw new SettingsRejected(label + " must hold names of up to 120 characters.");
  }
}

export interface SettingsStatus {
  settingsLoaded: boolean;
  secrets: Record<SecretName, boolean>;
  configError: string | null;
  warnings: string[];
  secretStore: string;
}

export class SettingsStore {
  constructor(readonly config: ConfigStore, readonly secrets: SecretStore) {}

  load(): void {
    this.config.load();
    this.secrets.load();
  }

  get settings(): Record<string, unknown> {
    return this.config.settings;
  }

  get configError(): string | null {
    return this.config.error;
  }

  secretSnapshot(): Record<string, string> {
    return this.secrets.values();
  }

  /** Store what the page pushed. Throws SettingsInvalid for bad input, SettingsRejected for a refused URL, ConfigUnreadable
   * when config cannot be written. Nothing is written when anything is refused. */
  apply(config: unknown, secrets: unknown): SettingsStatus {
    const none = (v: unknown) => v === undefined || v === null;
    if (none(config) && none(secrets)) throw new SettingsInvalid("Nothing to save: send config and/or secrets.");
    if (!none(config) && !isRecord(config)) throw new SettingsInvalid("config must be an object.");
    if (!none(secrets) && !isRecord(secrets)) throw new SettingsInvalid("secrets must be an object.");
    let changes: Record<string, string | null> = {};
    if (isRecord(secrets)) {
      const unknown = Object.keys(secrets).filter((key) => !(SECRET_NAMES as readonly string[]).includes(key)).sort();
      if (unknown.length) throw new SettingsInvalid(`Unknown secret: ${unknown.join(", ")}.`);
      changes = Object.fromEntries(Object.entries(secrets).map(([name, value]) => [name, normaliseSecret(name, value)]));
    }
    const merged = isRecord(config) ? this.checkedConfig(config) : null;
    if (merged !== null && this.config.unreadable) throw new ConfigUnreadable(this.config.error ?? "config.json could not be read.");
    if (Object.keys(changes).length) this.secrets.update(changes);
    if (merged !== null) this.config.save(merged);
    return this.status();
  }

  /** Merge the pushed keys into the saved settings (null removes a key), after checking the URLs sent. Merging keeps a
   * partial push (for example only crmBaseUrl) from erasing the other saved settings. */
  private checkedConfig(config: Record<string, unknown>): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...this.config.settings, ...config };
    for (const [key, value] of Object.entries(config)) if (value === null) delete merged[key];
    const empty = (v: unknown) => v === undefined || v === null || v === "";
    if (!empty(config.crmBaseUrl)) merged.crmBaseUrl = validateSinkBase(config.crmBaseUrl);
    if (!empty(config.llmBaseUrl)) merged.llmBaseUrl = validateLlmBaseUrl(config.llmBaseUrl);
    if (!empty(config.campaigns)) validateCampaigns(config.campaigns);
    for (const key of ["platforms", "campaignTypes"] as const) if (!empty(config[key])) validateNameList(config[key], key);
    return merged;
  }

  /** What GET /settings and GET /state report: saved non-secret config, and which secrets are set (never values). */
  view(): { config: Record<string, unknown>; secrets: Record<string, { set: boolean }>; secretsReady: boolean } {
    const presence = this.secrets.presence();
    return {
      config: structuredClone(this.settings),
      secrets: Object.fromEntries(SECRET_NAMES.map((n) => [n, { set: presence[n] }])),
      secretsReady: this.secrets.backendName() === "vault",
    };
  }

  status(): SettingsStatus {
    return {
      settingsLoaded: Object.keys(this.settings).length > 0,
      secrets: this.secrets.presence(),
      configError: this.configError,
      warnings: [...this.secrets.warnings],
      secretStore: this.secrets.backendName(),
    };
  }
}
