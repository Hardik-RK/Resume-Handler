import { describe, expect, it } from "vitest";
import { createMockCrm } from "../../mock-crm/src/app.ts";
import { parseCli } from "../src/args.ts";
import { connect } from "../src/connect.ts";
import { createFakeLlmServer, listen } from "../src/fake-llm-server.ts";
import type { HttpClient } from "../src/core.ts";

describe("fake LLM endpoint", () => {
  it("serves the provider's answer over loopback HTTP", async () => {
    const seen: unknown[] = [];
    const provider: HttpClient = {
      async post(_url, request) {
        seen.push(request.body);
        return { status: 200, headers: { "content-type": "application/json" }, text: JSON.stringify({ choices: [{ message: { content: "{}" } }] }) };
      },
    };
    const server = createFakeLlmServer(provider);
    const base = await listen(server, 0);
    try {
      expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      const ok = await fetch(`${base}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m", messages: [] }) });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ choices: [{ message: { content: "{}" } }] });
      expect(seen).toEqual([{ model: "m", messages: [] }]);
      expect((await fetch(`${base}/chat/completions`, { method: "POST", body: "not json" })).status).toBe(400);
      expect((await fetch(base)).status).toBe(404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("intake connect", () => {
  it("pushes the CRM address, campaigns, token and optional fake LLM to the server's settings", async () => {
    const crm = createMockCrm();
    let pushed: { url: string; auth: string | null; body: { config: Record<string, unknown>; secrets: Record<string, string> } } | null = null;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.startsWith("http://127.0.0.1:47831")) {
        pushed = { url: target, auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) };
        return new Response("{}", { status: 200 });
      }
      return crm.app.request(target.replace(/^https?:\/\/[^/]+/, ""), init);
    }) as typeof fetch;
    const result = await connect({ server: "http://127.0.0.1:47831", crm: "http://127.0.0.1:47900", llm: "http://127.0.0.1:47920/v1", fetch: fetchImpl });
    expect(result.campaigns).toBe(3);
    expect(pushed!.url).toBe("http://127.0.0.1:47831/settings");
    expect(pushed!.auth).toBe(`Bearer ${result.token}`);
    expect(pushed!.body.config).toMatchObject({ crmBaseUrl: "http://127.0.0.1:47900", llmBaseUrl: "http://127.0.0.1:47920/v1" });
    expect(pushed!.body.config.campaigns).toEqual([
      { id: 1, name: "Backend Engineer", group: "Northwind Demo Co", type: "TECH" },
      { id: 2, name: "Teacher", group: "Northwind Demo Co", type: "TEACHER" },
      { id: 3, name: "Sales", group: "Northwind Demo Co", type: "SALES" },
    ]);
    expect(pushed!.body.secrets.ingestionToken).toBe(result.token);
    // The token lives for a day and the CRM accepts it as the ingestion token.
    const claims = crm.issuer.verify(result.token)!;
    expect(claims.exp - claims.iat).toBe(86_400);
  });

  it("explains a 401 from the server", async () => {
    const crm = createMockCrm();
    const fetchImpl = (async (url: string | URL, init?: RequestInit) =>
      String(url).includes(":47831") ? new Response("{}", { status: 401 }) : crm.app.request(String(url).replace(/^https?:\/\/[^/]+/, ""), init)) as typeof fetch;
    await expect(connect({ server: "http://127.0.0.1:47831", crm: "http://127.0.0.1:47900", llm: null, fetch: fetchImpl })).rejects.toThrow(/INTAKE_PUBLIC_KEY_FILE/);
  });

  it("parses the new commands", () => {
    expect(parseCli(["fake-llm"])).toEqual({ command: "fake-llm", port: 47920 });
    expect(parseCli(["fake-llm", "--port", "0"])).toEqual({ command: "fake-llm", port: 0 });
    expect(parseCli(["connect"])).toEqual({ command: "connect", server: null, crm: "http://127.0.0.1:47900", llm: null });
    expect(parseCli(["connect", "--server", "http://127.0.0.1:47831", "--llm", "http://127.0.0.1:47920/v1"])).toMatchObject({ server: "http://127.0.0.1:47831", llm: "http://127.0.0.1:47920/v1" });
  });
});
