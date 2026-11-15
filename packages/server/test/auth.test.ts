/** Token verification, bearer parsing, origin rules and the three auth modes. Token cases are golden: the Python reference decided them. */
import { describe, expect, it } from "vitest";
import { bearerToken, createAuthenticator, originStatus, parsePublicKey, verifyToken, MAX_TOKEN_CHARS } from "../src/auth";
import { b64url, claimsFor, makeSigner, signClaims } from "./helpers";
import fixtures from "./golden/fixtures.json";

const publicKey = parsePublicKey(fixtures.publicKeyPem);

describe("golden: verifyToken matches the reference on every case", () => {
  for (const c of fixtures.tokens) {
    it(c.name, () => {
      const got = verifyToken(c.token, publicKey, { now: fixtures.NOW, audience: fixtures.AUDIENCE });
      expect(got).toEqual(c.claims);
    });
  }

  it("covers both accepted and refused outcomes", () => {
    expect(fixtures.tokens.filter((t) => t.claims !== null).length).toBeGreaterThan(4);
    expect(fixtures.tokens.filter((t) => t.claims === null).length).toBeGreaterThan(20);
  });
});

describe("golden: bearerToken", () => {
  for (const c of fixtures.bearer) {
    it(JSON.stringify(c.header), () => {
      expect(bearerToken(c.header)).toBe(c.token);
    });
  }
});

describe("golden: originStatus", () => {
  for (const c of fixtures.origins) {
    it(JSON.stringify(c.origin), () => {
      expect(originStatus(c.origin, c.allowed)).toBe(c.status);
    });
  }
});

describe("verifyToken", () => {
  it("rejects non-string input and oversized tokens", () => {
    for (const bad of [undefined, null, 5, {}, [], ""]) expect(verifyToken(bad, publicKey)).toBeNull();
    expect(verifyToken("A".repeat(MAX_TOKEN_CHARS + 1), publicKey)).toBeNull();
  });

  it("the expiry boundary is exact", () => {
    const signer = makeSigner();
    const now = Date.now() / 1000;
    const token = signClaims(signer, { aud: "resume-intake", sub: "a", role: "admin", exp: now + 60 });
    expect(verifyToken(token, signer.publicKey, { now })).not.toBeNull();
    expect(verifyToken(token, signer.publicKey, { now: now + 120 })).toBeNull();
  });

  it("audience and role are configurable", () => {
    const signer = makeSigner();
    const token = signClaims(signer, claimsFor({ aud: "other-app", role: "editor" }));
    expect(verifyToken(token, signer.publicKey)).toBeNull();
    expect(verifyToken(token, signer.publicKey, { audience: "other-app", requiredRole: "editor" })).not.toBeNull();
  });

  it("a signature over different bytes than the payload text is refused", () => {
    const signer = makeSigner();
    const payload = b64url(JSON.stringify(claimsFor()));
    const forged = `${payload}.${b64url(Buffer.alloc(64, 1))}`;
    expect(verifyToken(forged, signer.publicKey)).toBeNull();
  });
});

describe("parsePublicKey", () => {
  it("refuses a key that is not Ed25519", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => parsePublicKey(rsa)).toThrow(/Ed25519/);
  });
});

describe("auth modes", () => {
  it("none: always passes, claims are local", () => {
    const auth = createAuthenticator({ mode: "none" });
    expect(auth.authenticate(null)).not.toBeNull();
    expect(auth.authenticate("anything")).not.toBeNull();
  });

  it("token: only the exact configured token passes", () => {
    const auth = createAuthenticator({ mode: "token", token: "static-token-0123456789" });
    expect(auth.authenticate("static-token-0123456789")).not.toBeNull();
    for (const bad of [null, "", "static-token-012345678", "static-token-01234567890", "STATIC-TOKEN-0123456789"]) expect(auth.authenticate(bad)).toBeNull();
  });

  it("token: a short or missing configured token is refused at startup", () => {
    expect(() => createAuthenticator({ mode: "token", token: "short" })).toThrow(/at least/);
    expect(() => createAuthenticator({ mode: "token" })).toThrow();
  });

  it("signed: needs a key, then verifies tokens", () => {
    expect(() => createAuthenticator({ mode: "signed" })).toThrow(/public key/);
    const signer = makeSigner();
    const auth = createAuthenticator({ mode: "signed", publicKey: signer.publicKey });
    expect(auth.authenticate(signClaims(signer, claimsFor()))).not.toBeNull();
    expect(auth.authenticate(signClaims(makeSigner(), claimsFor()))).toBeNull();
    expect(auth.authenticate(null)).toBeNull();
  });
});
