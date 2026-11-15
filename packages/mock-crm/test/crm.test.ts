import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createMockCrm, type MockCrm } from "../src/app.ts";
import { TOKEN_AUDIENCE, TokenIssuer, verifyToken } from "../src/tokens.ts";

let crm: MockCrm;
let auth: Record<string, string>;

async function post(path: string, body: unknown, headers: Record<string, string> = auth) {
  return crm.app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

const alice = { name: "Alina Alder", email: "Alina.Alder@example.com", phone: "+44 7700 900123", campaignId: 1, source: "Test", stage: "LEAD" };
const bram = { name: "Bram Brightwater", email: "bram@example.com", phone: "+44 7700 900124", campaignId: 1, source: "Test", stage: "LEAD" };

beforeEach(async () => {
  crm = createMockCrm();
  const res = await crm.app.request("/api/uploader/token", { method: "POST" });
  const { token } = (await res.json()) as { token: string };
  auth = { authorization: `Bearer ${token}` };
});

describe("tokens", () => {
  it("mints Ed25519 tokens that verify with the published public key only", async () => {
    const { token, claims } = crm.issuer.issue("someone", 60);
    expect(claims.aud).toBe(TOKEN_AUDIENCE);
    expect(verifyToken(token, crm.issuer.publicKey)).toMatchObject({ sub: "someone", role: "admin" });
    expect(verifyToken(token, generateKeyPairSync("ed25519").publicKey)).toBeNull();
  });

  it("rejects expired, tampered and malformed tokens", () => {
    const issuer = new TokenIssuer();
    const old = issuer.issue("x", 10, 1000).token;
    expect(issuer.verify(old, 2000)).toBeNull();
    const fresh = issuer.issue("x", 60).token;
    const [payload, sig] = fresh.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ aud: TOKEN_AUDIENCE, sub: "x", role: "admin", iat: 0, exp: 9e9 })).toString("base64url");
    expect(issuer.verify(`${forged}.${sig}`)).toBeNull();
    expect(issuer.verify(`${payload}`)).toBeNull();
    expect(issuer.verify("a.b.c")).toBeNull();
    expect(issuer.verify(undefined)).toBeNull();
  });

  it("serves the public key as PEM and JSON", async () => {
    const pem = await (await crm.app.request("/.well-known/public-key.pem")).text();
    expect(pem).toContain("BEGIN PUBLIC KEY");
    expect(pem).toBe(crm.issuer.publicKeyPem());
    const json = (await (await crm.app.request("/api/uploader/public-key?format=json")).json()) as { raw: string; algorithm: string };
    expect(json.algorithm).toBe("Ed25519");
    expect(Buffer.from(json.raw, "base64url")).toHaveLength(32);
  });
});

describe("auth", () => {
  it("answers 401 without a valid token", async () => {
    expect((await post("/api/ingestion/preflight", { items: [alice] }, {})).status).toBe(401);
    expect((await post("/api/ingestion/preflight", { items: [alice] }, { authorization: "Bearer nope" })).status).toBe(401);
  });

  it("accepts the static ingestion token when configured", async () => {
    crm = createMockCrm({ ingestionToken: "static-demo-token" });
    const res = await post("/api/ingestion/preflight", { items: [alice] }, { authorization: "Bearer static-demo-token" });
    expect(res.status).toBe(200);
  });
});

describe("preflight", () => {
  it("marks new people READY and lists campaigns", async () => {
    const res = await post("/api/ingestion/preflight", { items: [alice, bram] });
    expect(await res.json()).toEqual({ ready: 2, total: 2, rows: [{ index: 0, status: "READY" }, { index: 1, status: "READY" }] });
    const campaigns = (await (await crm.app.request("/api/ingestion/campaigns", { headers: auth })).json()) as { campaigns: Array<{ name: string }> };
    expect(campaigns.campaigns.map((c) => c.name)).toEqual(["Backend Engineer", "Teacher", "Sales"]);
  });

  it("flags a repeat of the same email or phone inside one batch as DUPLICATE", async () => {
    const byEmail = { ...bram, email: "ALINA.ALDER@example.com", phone: "+44 7700 900999" };
    const byPhone = { ...bram, email: "other@example.com", phone: "07700 900123" };
    const res = await post("/api/ingestion/preflight", { items: [alice, byEmail, byPhone] });
    const body = (await res.json()) as { rows: Array<{ status: string; reason?: string }> };
    expect(body.rows.map((r) => r.status)).toEqual(["READY", "DUPLICATE", "DUPLICATE"]);
    expect(body.rows[1]?.reason).toContain("row 0");
  });

  it("flags invalid rows as ERROR and does not throw for them", async () => {
    const res = await post("/api/ingestion/preflight", {
      items: [{ name: "No Contact", campaignId: 1 }, { ...alice, campaignId: 99 }, { ...alice, campaignId: 4 }, { ...alice, stage: "BOGUS" }],
    });
    const body = (await res.json()) as { rows: Array<{ status: string; reason: string }> };
    expect(body.rows.map((r) => r.status)).toEqual(["ERROR", "ERROR", "ERROR", "ERROR"]);
    expect(body.rows[1]?.reason).toContain("Unknown campaign");
    expect(body.rows[2]?.reason).toContain("archived");
  });

  it("rejects an empty or oversized items list", async () => {
    expect((await post("/api/ingestion/preflight", { items: [] })).status).toBe(400);
    expect((await post("/api/ingestion/preflight", { items: new Array(1001).fill(alice) })).status).toBe(413);
  });
});

describe("batch and idempotency", () => {
  it("commits READY rows, shows them in the candidate list, then reports DUPLICATE on preflight", async () => {
    const res = await post("/api/ingestion/batch", { idempotencyKey: "k1", items: [alice, bram] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { batchId: number; applications: unknown[]; replayed?: boolean };
    expect(body.batchId).toBe(1);
    expect(body.applications).toHaveLength(2);
    expect(body.replayed).toBeUndefined();
    const list = (await (await crm.app.request("/api/candidates")).json()) as { candidates: Array<{ email: string }> };
    expect(list.candidates.map((c) => c.email)).toEqual(["alina.alder@example.com", "bram@example.com"]);
    const again = (await (await post("/api/ingestion/preflight", { items: [alice] })).json()) as { rows: Array<{ status: string }> };
    expect(again.rows[0]?.status).toBe("DUPLICATE");
    expect(crm.store.applications).toHaveLength(2);
  });

  it("replays the same key with the same payload without creating anything", async () => {
    await post("/api/ingestion/batch", { idempotencyKey: "k1", items: [alice] });
    const replay = await post("/api/ingestion/batch", { idempotencyKey: "k1", items: [alice] });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true, batchId: 1 });
    expect(crm.store.applications).toHaveLength(1);
  });

  it("refuses the same key with a different payload (409)", async () => {
    await post("/api/ingestion/batch", { idempotencyKey: "k1", items: [alice] });
    const res = await post("/api/ingestion/batch", { idempotencyKey: "k1", items: [bram] });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("different payload");
  });

  it("requires an idempotency key", async () => {
    expect((await post("/api/ingestion/batch", { items: [alice] })).status).toBe(400);
    expect((await post("/api/ingestion/batch", { idempotencyKey: "x".repeat(201), items: [alice] })).status).toBe(400);
  });

  it("imports nothing when any row is a duplicate (422)", async () => {
    await post("/api/ingestion/batch", { idempotencyKey: "k1", items: [alice] });
    const res = await post("/api/ingestion/batch", { idempotencyKey: "k2", items: [alice, bram] });
    expect(res.status).toBe(422);
    expect(crm.store.applications).toHaveLength(1);
  });

  it("answers 409 for an identity conflict: email of one person, phone of another", async () => {
    await post("/api/ingestion/batch", { idempotencyKey: "k1", items: [alice, bram] });
    const mixed = { name: "Mixed Up", email: alice.email, phone: bram.phone, campaignId: 2 };
    const res = await post("/api/ingestion/batch", { idempotencyKey: "k2", items: [mixed] });
    expect(res.status).toBe(409);
    const pre = (await (await post("/api/ingestion/preflight", { items: [mixed] })).json()) as { rows: Array<{ status: string }> };
    expect(pre.rows[0]?.status).toBe("CONFLICT");
  });

  it("lets the same person apply to a different campaign", async () => {
    await post("/api/ingestion/batch", { idempotencyKey: "k1", items: [alice] });
    const res = await post("/api/ingestion/batch", { idempotencyKey: "k2", items: [{ ...alice, campaignId: 2 }] });
    expect(res.status).toBe(200);
    expect(new Set(crm.store.applications.map((a) => a.profileId)).size).toBe(1);
  });

  it("accepts the uploader's CSV-style column names", async () => {
    const res = await post("/api/ingestion/batch", {
      idempotencyKey: "csv",
      items: [{ Name: "Carys Castellan", "Email Address": "carys@example.com", "Phone Number": "+44 7700 900200", campaignId: 3, "Lead ID": "abc123def456" }],
    });
    expect(res.status).toBe(200);
    expect(crm.store.applications[0]).toMatchObject({ leadId: "abc123def456", campaignId: 3 });
  });
});

describe("pages", () => {
  it("renders campaigns and candidates with HTML escaped", async () => {
    await post("/api/ingestion/batch", { idempotencyKey: "k1", items: [{ ...alice, name: "<script>x</script>" }] });
    const html = await (await crm.app.request("/")).text();
    expect(html).toContain("Backend Engineer");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x</script>");
  });

  it("resets the store", async () => {
    await post("/api/ingestion/batch", { idempotencyKey: "k1", items: [alice] });
    await crm.app.request("/api/admin/reset", { method: "POST" });
    expect(crm.store.applications).toHaveLength(0);
  });
});
