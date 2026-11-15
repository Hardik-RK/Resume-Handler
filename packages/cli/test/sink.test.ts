import { describe, expect, it } from "vitest";
import { createMockCrm } from "../../mock-crm/src/app.ts";
import { CommitError, buildItems, commitRows, idempotencyKey, identityKey, lookupCampaignId, mintDemoToken, validateSinkBase } from "../src/sink.ts";

const row = (name: string, email: string, phone: string, extra: Record<string, unknown> = {}) => ({
  Name: name, "Email Address": email, "Phone Number": phone, "Lead ID": `lead-${email}`, ...extra,
});
const ROWS = [row("Alina Alder", "alina.alder@example.com", "+447700900101"), row("Bram Brightwater", "bram@example.com", "+447700900102")];
const request = { campaignId: 1, source: "Test", stage: "LEAD" };

function crmFetch() {
  const crm = createMockCrm();
  const fetchImpl = ((url: string | URL, init?: RequestInit) => crm.app.request(String(url).replace(/^https?:\/\/[^/]+/, ""), init)) as typeof fetch;
  return { crm, fetchImpl };
}

describe("items and keys", () => {
  it("leaves out rows with no name, a placeholder name, or no contact", () => {
    const { items, leftOut } = buildItems([row("", "a@example.com", ""), row("Not Specified", "b@example.com", ""), row("Has Name", "", ""), row("Ok", "c@example.com", "")], request);
    expect(items.map((i) => i.name)).toEqual(["Ok"]);
    expect(leftOut).toBe(3);
  });

  it("lowercases email, carries optional fields, and builds identities", () => {
    const { items, keys } = buildItems([row("X", "MiXed@Example.com", "", { "Current Location": "Leeds", Resume: "https://example.com/r.pdf" })], request);
    expect(items[0]).toMatchObject({ email: "mixed@example.com", currentLocation: "Leeds", resumeUrl: "https://example.com/r.pdf", campaignId: 1 });
    expect(keys).toEqual(["email:mixed@example.com"]);
    expect(identityKey({ phone: "+44 7700 900101" })).toBe("phone:447700900101");
    expect(identityKey({ phone: "12", leadId: "L9" })).toBe("lead:L9");
  });

  it("gives the same idempotency key for the same people in any order, and differs by campaign", () => {
    const a = idempotencyKey(["email:a", "email:b"], 1);
    expect(a).toMatch(/^intake-[0-9a-f]{32}$/);
    expect(idempotencyKey(["email:b", "email:a"], 1)).toBe(a);
    expect(idempotencyKey(["email:a", "email:b"], 2)).not.toBe(a);
  });

  it("matches the reference key for a known input", () => {
    // Golden values from the Python reference formula (json.dumps with compact separators and sorted keys, ASCII-escaped).
    expect(idempotencyKey(["email:a@example.com"], 1)).toBe("intake-6cc290691d498e12534130b9f291e1c8");
    expect(idempotencyKey(["phone:447700900101", "email:zoë@example.com", "lead:"], 42)).toBe("intake-b9eaf5b8bb9f1a4e54ca41aa10dd1d77");
  });

  it("validates the sink address", () => {
    expect(validateSinkBase("http://127.0.0.1:47900/")).toBe("http://127.0.0.1:47900");
    expect(validateSinkBase("https://crm.example.com/api-root/")).toBe("https://crm.example.com/api-root");
    expect(() => validateSinkBase("http://crm.example.com")).toThrow(/https/);
    expect(() => validateSinkBase("https://user:pw@crm.example.com")).toThrow(/credentials/);
    expect(() => validateSinkBase("nope")).toThrow(CommitError);
  });
});

describe("commit against the mock CRM", () => {
  it("preflights, commits, and replays the same run without duplicating", async () => {
    const { crm, fetchImpl } = crmFetch();
    const token = await mintDemoToken("http://127.0.0.1:1", fetchImpl);
    const first = await commitRows(ROWS, { ...request, baseUrl: "http://127.0.0.1:1", token, fetch: fetchImpl });
    expect(first).toMatchObject({ counts: { ready: 2, duplicate: 0 }, created: 2, skipped: 0, batchId: 1 });
    expect(crm.store.applications).toHaveLength(2);
    // The same run again: preflight now says DUPLICATE for both, nothing new is committed.
    const second = await commitRows(ROWS, { ...request, baseUrl: "http://127.0.0.1:1", token, fetch: fetchImpl });
    expect(second).toMatchObject({ counts: { ready: 0, duplicate: 2 }, created: 0, skipped: 2, idempotencyKey: first.idempotencyKey });
    expect(crm.store.applications).toHaveLength(2);
  });

  it("dry run only preflights", async () => {
    const { crm, fetchImpl } = crmFetch();
    const token = await mintDemoToken("http://127.0.0.1:1", fetchImpl);
    const out = await commitRows(ROWS, { ...request, baseUrl: "http://127.0.0.1:1", token, fetch: fetchImpl, dryRun: true });
    expect(out).toMatchObject({ dryRun: true, counts: { ready: 2 }, created: 0, batchId: null });
    expect(crm.store.applications).toHaveLength(0);
  });

  it("looks a campaign up by name", async () => {
    const { fetchImpl } = crmFetch();
    const token = await mintDemoToken("http://127.0.0.1:1", fetchImpl);
    expect(await lookupCampaignId("http://127.0.0.1:1", token, "teacher", fetchImpl)).toBe(2);
    await expect(lookupCampaignId("http://127.0.0.1:1", token, "Astronaut", fetchImpl)).rejects.toThrow(/no campaign named/);
  });

  it("reports fixed sentences for failures and never echoes bodies", async () => {
    const { fetchImpl } = crmFetch();
    await expect(commitRows(ROWS, { ...request, baseUrl: "http://127.0.0.1:1", token: "bad-token", fetch: fetchImpl })).rejects.toMatchObject({ stage: "preflight", status: 401, message: expect.stringContaining("no longer accepts") });
    const unreachable = (() => Promise.reject(new Error("ECONNREFUSED secret-detail"))) as typeof fetch;
    await expect(commitRows(ROWS, { ...request, baseUrl: "http://127.0.0.1:1", token: "t", fetch: unreachable })).rejects.toThrow(/could not be reached/);
    const html = (() => Promise.resolve(new Response("<html>oops</html>", { status: 200 }))) as typeof fetch;
    await expect(commitRows(ROWS, { ...request, baseUrl: "http://127.0.0.1:1", token: "t", fetch: html })).rejects.toThrow(/unexpected/);
    const server = (() => Promise.resolve(new Response("boom stack trace", { status: 503 }))) as typeof fetch;
    await expect(commitRows(ROWS, { ...request, baseUrl: "http://127.0.0.1:1", token: "t", fetch: server })).rejects.toThrow(/HTTP 503/);
  });

  it("needs a token", async () => {
    await expect(commitRows(ROWS, { ...request, baseUrl: "http://127.0.0.1:1", token: "" })).rejects.toThrow(/No sink token/);
  });
});
