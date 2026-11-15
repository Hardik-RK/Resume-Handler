/**
 * Authentication and origin rules.
 *
 * Modes:
 *   none    no credentials; the server binds 127.0.0.1 only (local use)
 *   token   a static bearer token (INTAKE_TOKEN)
 *   signed  an Ed25519-signed session token issued by a downstream system, verified offline with a configured public key:
 *             token  = base64url(JSON claims) + "." + base64url(Ed25519 signature over the base64url payload text)
 *             claims = {aud, sub, role, iat, exp}
 *
 * Anything unusual is rejected; a token can never crash the request handler.
 */
import crypto from "node:crypto";
import fs from "node:fs";

export const DEFAULT_AUDIENCE = "resume-intake";
export const DEFAULT_REQUIRED_ROLE = "admin";
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:47831",
  "http://127.0.0.1:47831",
];
export const MAX_TOKEN_CHARS = 8192;
export const MIN_STATIC_TOKEN_CHARS = 16;

export type AuthMode = "none" | "token" | "signed";
export type Claims = Record<string, unknown>;

const B64URL = /^[A-Za-z0-9_-]+$/;
const BEARER = /^\s*Bearer\s+(\S+)\s*$/i;

export interface VerifyOptions {
  /** Seconds since the epoch; defaults to the current time. */
  now?: number;
  audience?: string;
  requiredRole?: string;
}

/** Parse an Ed25519 public key given as PEM (SPKI). */
export function parsePublicKey(pem: string): crypto.KeyObject {
  const key = crypto.createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("The public key is not an Ed25519 key.");
  return key;
}

export function loadPublicKey(file: string): crypto.KeyObject {
  return parsePublicKey(fs.readFileSync(file, "utf8"));
}

function b64urlDecode(text: string): Buffer {
  if (!text || !B64URL.test(text)) throw new Error("not base64url");
  if (text.length % 4 === 1) throw new Error("bad base64url length");
  return Buffer.from(text, "base64url");
}

/** The claims when the token is genuine, unexpired, for this audience and role; null otherwise. */
export function verifyToken(token: unknown, publicKey: crypto.KeyObject, options: VerifyOptions = {}): Claims | null {
  try {
    if (typeof token !== "string" || !token || token.length > MAX_TOKEN_CHARS) return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [payloadText, signatureText] = parts as [string, string];
    if (!B64URL.test(payloadText)) return null;
    const signature = b64urlDecode(signatureText);
    // The issuer signs the payload text itself.
    if (!crypto.verify(null, Buffer.from(payloadText, "ascii"), publicKey, signature)) return null;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const claims: unknown = JSON.parse(decoder.decode(b64urlDecode(payloadText)));
    if (typeof claims !== "object" || claims === null || Array.isArray(claims)) return null;
    const c = claims as Claims;
    if (c.aud !== (options.audience ?? DEFAULT_AUDIENCE) || c.role !== (options.requiredRole ?? DEFAULT_REQUIRED_ROLE)) return null;
    const exp = c.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
    if (exp < (options.now ?? Date.now() / 1000)) return null;
    return c;
  } catch {
    return null;
  }
}

export function bearerToken(header: string | undefined | null): string | null {
  if (!header) return null;
  const match = BEARER.exec(header);
  return match ? (match[1] ?? null) : null;
}

/** Constant-time comparison of two secrets of any length. */
export function secretsEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a, "utf8").digest();
  const hb = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

export type OriginStatus = "absent" | "allowed" | "denied";

/** 'absent' (no Origin header: a non-browser client), 'allowed' (exact match) or 'denied' (anything else, including null). */
export function originStatus(origin: string | undefined | null, allowed: readonly string[]): OriginStatus {
  if (origin === undefined || origin === null) return "absent";
  if (origin === "" || origin === "null") return "denied";
  return allowed.includes(origin) ? "allowed" : "denied";
}

export interface Authenticator {
  mode: AuthMode;
  /** Claims for a request, or null when the credentials are missing or wrong. */
  authenticate(token: string | null): Claims | null;
}

export interface AuthSettings {
  mode: AuthMode;
  /** token mode: the static bearer token. */
  token?: string;
  /** signed mode: the Ed25519 public key. */
  publicKey?: crypto.KeyObject;
  audience?: string;
  requiredRole?: string;
}

export function createAuthenticator(settings: AuthSettings): Authenticator {
  switch (settings.mode) {
    case "none":
      return { mode: "none", authenticate: () => ({ sub: "local", role: DEFAULT_REQUIRED_ROLE }) };
    case "token": {
      const expected = settings.token ?? "";
      if (expected.length < MIN_STATIC_TOKEN_CHARS) {
        throw new Error(`INTAKE_TOKEN must be at least ${MIN_STATIC_TOKEN_CHARS} characters.`);
      }
      return {
        mode: "token",
        authenticate: (token) => (token && secretsEqual(token, expected) ? { sub: "token", role: DEFAULT_REQUIRED_ROLE } : null),
      };
    }
    case "signed": {
      const key = settings.publicKey;
      if (!key) throw new Error("Signed auth needs an Ed25519 public key (INTAKE_PUBLIC_KEY or INTAKE_PUBLIC_KEY_FILE).");
      const options: VerifyOptions = {};
      if (settings.audience !== undefined) options.audience = settings.audience;
      if (settings.requiredRole !== undefined) options.requiredRole = settings.requiredRole;
      return { mode: "signed", authenticate: (token) => (token ? verifyToken(token, key, options) : null) };
    }
  }
}
