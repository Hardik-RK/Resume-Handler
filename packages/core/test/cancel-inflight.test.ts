import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CancelFlag } from "../src/concurrency.js";
import { Cancelled } from "../src/errors.js";
import * as llm from "../src/llm.js";

// A model provider that accepts the request and never answers (found by hand: Cancel stayed on "Cancelling" for the whole read timeout).
let server: http.Server | null = null;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.closeAllConnections?.() ?? server.close(() => resolve()) : resolve()));
  server?.close();
  server = null;
});
async function hangingProvider(): Promise<string> {
  server = http.createServer(() => { /* never answer */ });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1/chat/completions`;
}

describe("cancel with a request in flight", () => {
  it("the fetch client stops waiting as soon as the signal aborts", async () => {
    const url = await hangingProvider();
    const abort = new AbortController();
    const started = Date.now();
    const pending = llm.createFetchClient().post(url, { headers: {}, body: {}, timeoutMs: 30_000, connectTimeoutMs: 1_000, signal: abort.signal });
    setTimeout(() => abort.abort(), 150);
    await expect(pending).rejects.toBeTruthy();
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("post() throws Cancelled promptly instead of retrying after the abort", async () => {
    const url = await hangingProvider();
    const cancel = new CancelFlag();
    const tr = new llm.Transport({ http: llm.createFetchClient(), cancel, readTimeouts: [30], visionReadTimeouts: [30] });
    const started = Date.now();
    const pending = llm.post(url, {}, { model: "m", messages: [] }, "label", { transport: tr });
    setTimeout(() => cancel.set(), 150);
    await expect(pending).rejects.toBeInstanceOf(Cancelled);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
