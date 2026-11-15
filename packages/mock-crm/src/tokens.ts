import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

/** Audience claim of every session token this demo issues. The server's signed mode must expect the same value. */
export const TOKEN_AUDIENCE = "resume-intake";
export const TOKEN_ROLE = "admin";
export const MAX_TOKEN_CHARS = 8192;

const B64URL = /^[A-Za-z0-9_-]+$/;

export interface TokenClaims {
  aud: string;
  sub: string;
  role: string;
  iat: number;
  exp: number;
}

/**
 * Token = base64url(JSON claims) + "." + base64url(Ed25519 signature over the base64url payload text).
 * The DEMO key pair is generated at startup and is for demonstration only.
 */
export class TokenIssuer {
  readonly publicKey: KeyObject;
  private readonly privateKey: KeyObject;

  constructor(privatePem?: string) {
    if (privatePem) {
      this.privateKey = createPrivateKey(privatePem);
      this.publicKey = createPublicKey(this.privateKey);
    } else {
      const pair = generateKeyPairSync("ed25519");
      this.privateKey = pair.privateKey;
      this.publicKey = pair.publicKey;
    }
  }

  publicKeyPem(): string {
    return this.publicKey.export({ type: "spki", format: "pem" }).toString();
  }

  /** Raw 32-byte public key, base64url, for configs that prefer it over PEM. */
  publicKeyRaw(): string {
    const der = this.publicKey.export({ type: "spki", format: "der" });
    return Buffer.from(der.subarray(der.length - 32)).toString("base64url");
  }

  issue(sub = "demo-admin", ttlSeconds = 3600, now = Date.now() / 1000): { token: string; claims: TokenClaims } {
    const claims: TokenClaims = { aud: TOKEN_AUDIENCE, sub, role: TOKEN_ROLE, iat: Math.floor(now), exp: Math.floor(now) + ttlSeconds };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = sign(null, Buffer.from(payload, "ascii"), this.privateKey).toString("base64url");
    return { token: `${payload}.${signature}`, claims };
  }

  verify(token: unknown, now = Date.now() / 1000): TokenClaims | null {
    return verifyToken(token, this.publicKey, now);
  }
}

export function verifyToken(token: unknown, publicKey: KeyObject, now = Date.now() / 1000): TokenClaims | null {
  try {
    if (typeof token !== "string" || !token || token.length > MAX_TOKEN_CHARS) return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [payload, signature] = parts as [string, string];
    if (!B64URL.test(payload) || !B64URL.test(signature)) return null;
    if (!verify(null, Buffer.from(payload, "ascii"), publicKey, Buffer.from(signature, "base64url"))) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<TokenClaims>;
    if (!claims || typeof claims !== "object") return null;
    if (claims.aud !== TOKEN_AUDIENCE || claims.role !== TOKEN_ROLE) return null;
    if (typeof claims.exp !== "number" || claims.exp < now) return null;
    return claims as TokenClaims;
  } catch {
    return null;
  }
}
