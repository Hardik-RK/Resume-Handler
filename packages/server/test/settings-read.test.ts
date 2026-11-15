/** GET /settings and the config/secrets fields of GET /state: auth, no leaks, campaigns round trip and validation. */
import { describe, expect, it } from "vitest";
import { request, startServer } from "./helpers";

const KEY = "sk-or-v1-0123456789abcdef0123456789";
const INGEST = "ingest-token-0123456789abcdef";
const CAMPAIGNS = [
  { id: 7, name: "Backend 2026", group: "Tech", type: "TECH", driveFolderId: "folder-1" },
  { id: "c-8", name: "Design" },
];

describe("GET /settings", () => {
  it("needs credentials", async () => {
    const s = await startServer();
    expect((await request(s.port, "GET", "/settings")).status).toBe(401);
  });

  it("is empty before anything is saved", async () => {
    const s = await startServer();
    const body = (await s.get("/settings", s.authed())).json();
    expect(body.config).toEqual({});
    expect(body.secrets).toEqual({
      openrouterApiKey: { set: false },
      googleClientSecrets: { set: false },
      googleTokenJson: { set: false },
      ingestionToken: { set: false },
    });
    expect(body.secretsReady).toBe(true);
  });

  it("round trips campaigns, platforms, campaign types and the sink base, and never leaks a secret", async () => {
    const s = await startServer();
    const config = { campaigns: CAMPAIGNS, platforms: ["Demo", { name: "Other" }], campaignTypes: ["TECH", "DESIGN"], crmBaseUrl: "https://sink.example.test", maxConcurrency: 3 };
    const saved = await s.post("/settings", s.authed({ json: { config, secrets: { openrouterApiKey: KEY, ingestionToken: INGEST } } }));
    expect(saved.status).toBe(200);
    const body = (await s.get("/settings", s.authed())).json();
    expect(body.config).toEqual(config);
    expect(body.secrets.openrouterApiKey).toEqual({ set: true });
    expect(body.secrets.ingestionToken).toEqual({ set: true });
    expect(body.secrets.googleTokenJson).toEqual({ set: false });
    const state = (await s.get("/state", s.authed())).json();
    expect(state.config).toEqual(config);
    expect(state.secrets).toEqual(body.secrets);
    for (const text of [JSON.stringify(body), JSON.stringify(state)]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(INGEST);
    }
  });

  it("the returned config is a copy: mutating it does not change the store", async () => {
    const s = await startServer();
    s.engine.settings.apply({ campaigns: CAMPAIGNS }, null);
    const view = s.engine.settings.view();
    (view.config.campaigns as unknown[]).length = 0;
    expect((s.engine.settings.settings.campaigns as unknown[]).length).toBe(2);
  });
});

describe("POST /settings validation of the lists", () => {
  const push = (s: Awaited<ReturnType<typeof startServer>>, config: unknown) => s.post("/settings", s.authed({ json: { config } }));

  for (const bad of [
    { campaigns: "nope" },
    { campaigns: [{ name: "no id" }] },
    { campaigns: [{ id: 1 }] },
    { campaigns: [{ id: 1, name: "  " }] },
    { campaigns: [{ id: 1, name: "x", group: 5 }] },
    { campaigns: [{ id: 1, name: "x", driveFolderId: "d".repeat(201) }] },
    { campaigns: [{ id: "i".repeat(65), name: "x" }] },
    { campaigns: Array.from({ length: 501 }, (_, i) => ({ id: i, name: "n" })) },
    { campaigns: ["text"] },
    { platforms: "Demo" },
    { platforms: [""] },
    { platforms: [5] },
    { platforms: Array.from({ length: 201 }, () => "p") },
    { campaignTypes: [{ id: 1 }] },
  ]) {
    it(`refuses ${JSON.stringify(bad).slice(0, 60)}`, async () => {
      const s = await startServer();
      const res = await push(s, bad);
      expect(res.status).toBe(422);
      expect(s.engine.settings.settings).toEqual({});
    });
  }

  it("accepts the limits exactly and null removes a list", async () => {
    const s = await startServer();
    expect((await push(s, { campaigns: Array.from({ length: 500 }, (_, i) => ({ id: i, name: "n" })) })).status).toBe(200);
    expect((await push(s, { campaigns: null })).status).toBe(200);
    expect("campaigns" in s.engine.settings.settings).toBe(false);
  });

  it("a plain-http sink base is still refused", async () => {
    const s = await startServer();
    expect((await push(s, { crmBaseUrl: "http://sink.example.test" })).status).toBe(422);
  });
});
