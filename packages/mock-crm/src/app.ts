import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { CrmStore, IngestionError } from "./ingestion.ts";
import { renderHome } from "./html.ts";
import { TokenIssuer } from "./tokens.ts";

export interface MockCrmOptions {
  store?: CrmStore;
  issuer?: TokenIssuer;
  /** Static bearer token accepted on the ingestion routes in addition to signed session tokens. */
  ingestionToken?: string;
  /** Default true. When false the ingestion routes accept any caller (handy for curl experiments). */
  requireAuth?: boolean;
}

export interface MockCrm {
  app: Hono;
  store: CrmStore;
  issuer: TokenIssuer;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearer(header: string | undefined): string {
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match?.[1] ?? "";
}

export function createMockCrm(options: MockCrmOptions = {}): MockCrm {
  const store = options.store ?? new CrmStore();
  const issuer = options.issuer ?? new TokenIssuer();
  const requireAuth = options.requireAuth ?? true;
  const app = new Hono();

  app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type"], allowMethods: ["GET", "POST", "OPTIONS"] }));

  const authorised = (c: Context): string | null => {
    if (!requireAuth) return "anonymous";
    const supplied = bearer(c.req.header("authorization")) || (c.req.header("x-ingestion-token") ?? "").trim();
    if (!supplied) return null;
    if (options.ingestionToken && safeEqual(supplied, options.ingestionToken)) return "environment";
    const claims = issuer.verify(supplied);
    return claims ? claims.sub : null;
  };

  const guarded = (handler: (c: Context, actor: string) => Response | Promise<Response>) => async (c: Context) => {
    const actor = authorised(c);
    if (!actor) return c.json({ error: "Valid ingestion token required." }, 401);
    try {
      return await handler(c, actor);
    } catch (err) {
      if (err instanceof IngestionError) return c.json({ error: err.message, details: err.details }, err.status as 400);
      throw err;
    }
  };

  const body = async (c: Context): Promise<Record<string, unknown>> => {
    try {
      const parsed: unknown = await c.req.json();
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      throw new IngestionError(400, "The request body must be JSON.");
    }
  };

  app.get("/api/ingestion/campaigns", guarded((c) => c.json({ campaigns: store.activeCampaigns() })));

  app.post("/api/ingestion/preflight", guarded(async (c) => {
    const payload = await body(c);
    return c.json(store.preflight(payload.items));
  }));

  app.post("/api/ingestion/batch", guarded(async (c, actor) => {
    const payload = await body(c);
    return c.json(store.commitBatch({ idempotencyKey: payload.idempotencyKey, items: payload.items, actor }));
  }));

  // ── demo identity provider: mints Ed25519-signed session tokens ──
  app.post("/api/uploader/token", async (c) => {
    let sub = "demo-admin";
    let ttl = 3600;
    try {
      const payload = (await c.req.json()) as { sub?: unknown; ttlSeconds?: unknown };
      if (typeof payload.sub === "string" && payload.sub.trim()) sub = payload.sub.trim().slice(0, 120);
      if (typeof payload.ttlSeconds === "number" && payload.ttlSeconds >= 1 && payload.ttlSeconds <= 86_400) ttl = Math.floor(payload.ttlSeconds);
    } catch {
      // an empty body is fine
    }
    const { token, claims } = issuer.issue(sub, ttl);
    return c.json({ token, expiresAt: new Date(claims.exp * 1000).toISOString(), claims });
  });

  app.get("/api/uploader/public-key", (c) => {
    if (c.req.query("format") === "json") return c.json({ algorithm: "Ed25519", pem: issuer.publicKeyPem(), raw: issuer.publicKeyRaw() });
    return c.text(issuer.publicKeyPem());
  });
  app.get("/.well-known/public-key.pem", (c) => c.text(issuer.publicKeyPem()));

  // ── demo views ──
  app.get("/api/candidates", (c) => c.json({ candidates: store.applications, campaigns: store.campaigns, batches: store.batches.length }));
  app.post("/api/admin/reset", (c) => {
    store.reset();
    return c.json({ reset: true });
  });
  app.get("/", (c) => c.html(renderHome(store)));
  app.get("/healthz", (c) => c.json({ ok: true }));

  return { app, store, issuer };
}
