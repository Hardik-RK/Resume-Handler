/** Runs (one at a time, cancel, failure reporting, options, results), the SSE stream, redaction (golden) and shutdown. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EventBus, redact, registerSecret, REPLAY_SIZE, scrub, SUBSCRIBER_BACKLOG } from "../src/events";
import type { RunContext } from "@intake/core";
import { PipelineUnavailable } from "../src/engine";
import fixtures from "./golden/fixtures.json";
import { ORIGIN, pdfResult, sleep, startServer, waitFor, type Running } from "./helpers";

const idle = (s: Running) => () => !s.engine.runActive;
const phases = (s: Running) => s.engine.bus.history().filter((e) => e.type === "phase").map((e) => e.data.phase);
const body = (s: Running, json: unknown) => s.post("/run", s.authed({ json }));

describe("runs", () => {
  it("starts, finishes and emits phases", async () => {
    const s = await startServer();
    const csv = path.join(s.engine.dirs.output, "results.csv");
    fs.writeFileSync(csv, "file,name\na.pdf,Asha Rao\n");
    let seen: RunContext | undefined;
    s.runner = (ctx) => {
      seen = ctx;
      ctx.emit({ type: "phase", data: { phase: "parsing" } });
      return pdfResult({ csvPath: csv });
    };
    const res = await body(s, { campaignType: "Engineering", parallel: 3, dryRun: true });
    expect(res.status).toBe(202);
    expect(res.json()).toEqual({ started: true, campaignType: "Engineering", parallel: 3 });
    expect(await waitFor(idle(s))).toBe(true);

    expect(phases(s)).toEqual(["preparing", "parsing", "done"]);
    expect(seen?.options).toMatchObject({ campaignType: "Engineering", parallel: 3, dryRun: true });
    expect(Object.keys(seen?.dirs ?? {}).sort()).toEqual(["cache", "database", "input", "logs", "old", "output"]);
    const state = (await s.get("/state", s.authed())).json();
    expect(state.running).toBe(false);
    expect(state.lastRun.phase).toBe("done");
    expect(state.lastRun.cost.tokens).toBe(1234);
    expect(state.lastRun.rows).toBe(1);
  });

  it("the context carries a copy of the settings and the secrets, not the live objects", async () => {
    const s = await startServer();
    s.engine.settings.apply({ maxConcurrency: 4 }, { openrouterApiKey: "sk-or-v1-0123456789abcdef" });
    let seen: RunContext | undefined;
    s.runner = (ctx) => {
      seen = ctx;
      ctx.config.maxConcurrency = 99;
      return pdfResult();
    };
    await body(s, {});
    await waitFor(idle(s));
    expect(seen?.secrets.openrouterApiKey).toBe("sk-or-v1-0123456789abcdef");
    expect(s.engine.settings.settings.maxConcurrency).toBe(4);
  });

  it("a second run while running is 409, and the engine is free again afterwards", async () => {
    const s = await startServer();
    let release!: () => void;
    s.runner = () => new Promise((resolve) => (release = () => resolve(pdfResult())));
    expect((await body(s, {})).status).toBe(202);
    const second = await body(s, {});
    expect(second.status).toBe(409);
    expect(second.json().error).toContain("already in progress");
    release();
    expect(await waitFor(idle(s))).toBe(true);
    s.runner = () => pdfResult();
    expect((await body(s, {})).status).toBe(202);
    expect(await waitFor(idle(s))).toBe(true);
  });

  it("a rejected second run does not disturb the first run's end announcement", async () => {
    const s = await startServer();
    let release!: () => void;
    s.runner = (ctx) =>
      new Promise((resolve) => {
        release = () => {
          ctx.emit({ type: "phase", data: { phase: "failed", detail: "pipeline says failed" } });
          resolve(pdfResult());
        };
      });
    await body(s, {});
    expect((await body(s, {})).status).toBe(409);
    release();
    await waitFor(idle(s));
    expect(phases(s).at(-1)).toBe("failed");
  });

  it("cancel aborts the context signal and ends the run cancelled", async () => {
    const s = await startServer();
    let started!: () => void;
    const begun = new Promise<void>((r) => (started = r));
    s.runner = (ctx) =>
      new Promise((resolve) => {
        started();
        ctx.cancelled.addEventListener("abort", () => resolve(pdfResult()));
      });
    await body(s, {});
    await begun;
    const res = await s.post("/cancel", s.authed({ json: {} }));
    expect(res.status).toBe(202);
    expect(res.json()).toEqual({ cancelling: true });
    expect(await waitFor(idle(s))).toBe(true);
    expect(phases(s).at(-1)).toBe("cancelled");
    expect((await s.get("/state", s.authed())).json().lastRun.phase).toBe("cancelled");
    expect(s.engine.bus.history().some((e) => e.type === "log" && e.data.message === "Cancel requested.")).toBe(true);
  });

  it("cancel with nothing running is 409", async () => {
    const s = await startServer();
    expect((await s.post("/cancel", s.authed({ json: {} }))).status).toBe(409);
  });

  it("a pipeline error becomes failed with a redacted detail", async () => {
    const s = await startServer();
    s.runner = () => {
      throw new Error("provider refused key sk-or-v1-0123456789abcdef0123 for Bearer abc.def");
    };
    await body(s, {});
    expect(await waitFor(idle(s))).toBe(true);
    const last = (await s.get("/state", s.authed())).json().lastRun;
    expect(last.phase).toBe("failed");
    expect(last.detail).not.toContain("sk-or-v1-0123456789abcdef0123");
    expect(last.detail).not.toContain("abc.def");
    const failed = s.engine.bus.history().find((e) => e.type === "phase" && e.data.phase === "failed");
    expect(String(failed?.data.detail)).not.toContain("sk-or-v1");
  });

  it("a rejected promise is handled the same way", async () => {
    const s = await startServer();
    s.runner = () => Promise.reject(new Error("exploded"));
    await body(s, {});
    expect(await waitFor(idle(s))).toBe(true);
    expect((await s.get("/state", s.authed())).json().lastRun).toMatchObject({ phase: "failed", detail: "exploded" });
  });

  it("a missing pipeline is 503 and releases the run flag", async () => {
    const s = await startServer();
    s.engine.resolveRunner = async () => {
      throw new PipelineUnavailable("The extraction pipeline is not installed in this build (no module).");
    };
    const res = await body(s, {});
    expect(res.status).toBe(503);
    expect(res.json().error).toContain("not installed");
    expect(s.engine.runActive).toBe(false);
  });

  for (const bad of [{ parallel: 99 }, { parallel: "4" }, { dryRun: "yes" }, { campaignType: "x".repeat(500) }, { jdThreshold: 150 }, { jd: 12 }, ["not", "an", "object"], { inputs: "a.pdf" }, { inputs: ["../a.pdf"] }, { inputs: ["a\\b.pdf"] }, { inputs: [""] }, { parallel: true }, { jdFilter: 1 }]) {
    it(`bad run options ${JSON.stringify(bad).slice(0, 40)} are 400`, async () => {
      const s = await startServer();
      expect((await body(s, bad)).status).toBe(400);
      expect(s.engine.runActive).toBe(false);
    });
  }

  it("an empty run body uses the defaults, and config defaults flow through", async () => {
    const s = await startServer();
    s.engine.settings.apply({ maxConcurrency: 7, defaultCampaignType: "TECH", jdDryRun: true, jdFilterEnabled: true, jdThreshold: 40 }, null);
    let seen: RunContext | undefined;
    s.runner = (ctx) => {
      seen = ctx;
      return pdfResult();
    };
    const res = await s.post("/run", s.authed({ data: "", contentType: "application/json" }));
    expect(res.status).toBe(202);
    await waitFor(idle(s));
    expect(seen?.options).toMatchObject({ parallel: 7, campaignType: "TECH", dryRun: true, jdFilter: true, jdThreshold: 40, platform: "", inputs: [], jd: "" });
  });

  it("results and CSV after a run", async () => {
    const s = await startServer();
    const csv = path.join(s.engine.dirs.output, "results.csv");
    fs.writeFileSync(csv, "file,name\na.pdf,Asha Rao\n");
    s.runner = () => pdfResult({ csvPath: csv });
    expect((await s.get("/results", s.authed())).json()).toEqual({ available: false, summary: null, rows: [], csvAvailable: false });
    await body(s, {});
    await waitFor(idle(s));
    const result = (await s.get("/results", s.authed())).json();
    expect(result.available).toBe(true);
    expect(result.rows[0].name).toBe("Asha Rao");
    expect(result.csvAvailable).toBe(true);
    expect(result.summary).toMatchObject({ phase: "done", rows: 1 });
    const download = await s.get("/results.csv", s.authed());
    expect(download.status).toBe(200);
    expect(String(download.headers["content-type"])).toMatch(/^text\/csv/);
    expect(download.text()).toContain("Asha Rao");
    expect(download.headers["content-disposition"]).toContain('attachment; filename="results.csv"');
  });

  it("a CSV outside the data folder is not served", async () => {
    const s = await startServer();
    const outside = path.join(s.root, "elsewhere.csv");
    fs.writeFileSync(outside, "secret,data\n1,2\n");
    s.runner = () => pdfResult({ csvPath: outside });
    await body(s, {});
    await waitFor(idle(s));
    expect((await s.get("/results", s.authed())).json().csvAvailable).toBe(false);
    expect((await s.get("/results.csv", s.authed())).status).toBe(404);
  });

  it("results.csv is 404 before any run", async () => {
    const s = await startServer();
    expect((await s.get("/results.csv", s.authed())).status).toBe(404);
  });

  it("the state counts the input queue", async () => {
    const s = await startServer();
    for (const [name, data] of [["a.pdf", "%PDF"], ["b.pdf", "%PDF"], ["c.zip", "PK"], ["roster.xlsx", "x"], ["list.csv", "a\n"], [".upload-x.part", "x"]] as const) {
      fs.writeFileSync(path.join(s.inputDir, name), data);
    }
    expect((await s.get("/state", s.authed())).json().queue).toEqual({ pdfs: 2, zips: 1, rosters: 2 });
  });

  it("the state reports Google and LLM presence", async () => {
    const s = await startServer();
    const state = (await s.get("/state", s.authed())).json();
    expect(state.google.ok).toBe(false);
    expect(state.google.reason).toBeTruthy();
    expect(state.llm.ok).toBe(false);
    expect(Array.isArray(state.warnings)).toBe(true);
    expect(state.commit).toMatchObject({ configured: false, enabled: false, status: "idle", tokenRejected: false });
    expect(state.version).toBeTruthy();
    expect(state.phase).toBe("idle");
  });

  it("only the worker announces the end, once, with counts, after the engine is free", async () => {
    const s = await startServer();
    const seen: { active?: boolean; counts?: unknown } = {};
    s.runner = (ctx) => {
      ctx.emit({ type: "phase", data: { phase: "parsing" } });
      ctx.emit({ type: "phase", data: { phase: "done", detail: "finished by the pipeline" } });
      return pdfResult();
    };
    const original = s.engine.emit.bind(s.engine);
    s.engine.emit = (type, data = {}) => {
      if (type === "phase" && data.phase === "done") {
        seen.active = s.engine.runActive;
        seen.counts = data.counts;
      }
      return original(type, data);
    };
    expect((await body(s, {})).status).toBe(202);
    expect(await waitFor(idle(s))).toBe(true);
    expect(phases(s).filter((p) => p === "done")).toHaveLength(1);
    expect(seen.active).toBe(false);
    expect(seen.counts).toEqual({ ok: 1, failed: 0 });
    s.runner = () => pdfResult();
    expect((await body(s, {})).status).toBe(202); // the next run starts straight away
  });

  it("a pipeline that reports an error ends the run as failed", async () => {
    const s = await startServer();
    s.runner = (ctx) => {
      ctx.emit({ type: "phase", data: { phase: "failed", detail: "Choose a Drive folder for this run" } });
      return pdfResult({ rows: [], counts: {}, error: "Choose a Drive folder for this run" });
    };
    await body(s, {});
    await waitFor(idle(s));
    expect(phases(s).filter((p) => p === "failed")).toHaveLength(1);
    expect(phases(s)).not.toContain("done");
    const end = s.engine.bus.history().filter((e) => e.type === "phase").at(-1)!.data;
    expect(end.phase).toBe("failed");
    expect(String(end.detail)).toContain("Drive folder");
  });

  it("a failed pipeline end without an error field still counts as failed", async () => {
    const s = await startServer();
    s.runner = (ctx) => {
      ctx.emit({ type: "phase", data: { phase: "failed", detail: "reported only by the event" } });
      return pdfResult();
    };
    await body(s, {});
    await waitFor(idle(s));
    expect(phases(s).at(-1)).toBe("failed");
    expect((await s.get("/state", s.authed())).json().lastRun.phase).toBe("failed");
  });
});

// ── SSE ─────────────────────────────────────────────────────────────────────────────────────────────────────────
interface Stream {
  status: number;
  headers: http.IncomingHttpHeaders;
  lines: string[];
  waitForLines(predicate: (lines: string[]) => boolean, ms?: number): Promise<boolean>;
  events(): Array<{ id: number; type: string; ts: number; data: any }>;
  close(): void;
}

function openStream(port: number, urlPath: string, headers: Record<string, string> = {}): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: urlPath, headers: { Origin: ORIGIN, ...headers } }, (res) => {
      const lines: string[] = [];
      let tail = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        const parts = (tail + chunk).split("\n");
        tail = parts.pop() ?? "";
        lines.push(...parts);
      });
      res.on("error", () => undefined);
      const stream: Stream = {
        status: res.statusCode ?? 0,
        headers: res.headers,
        lines,
        waitForLines: async (predicate, ms = 3000) => waitFor(() => predicate(lines), ms),
        events: () => lines.filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))),
        close: () => req.destroy(),
      };
      resolve(stream);
    });
    req.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err);
    });
  });
}

describe("SSE /events", () => {
  it("replays history then streams live", async () => {
    const s = await startServer();
    s.engine.emit("log", { level: "info", message: "first" });
    s.engine.emit("log", { level: "info", message: "second" });
    const stream = await openStream(s.port, `/events?token=${s.token}`);
    try {
      expect(stream.status).toBe(200);
      expect(String(stream.headers["content-type"])).toMatch(/^text\/event-stream/);
      expect(await stream.waitForLines(() => stream.events().length >= 2)).toBe(true);
      const replay = stream.events();
      expect(replay.map((e) => e.data.message)).toEqual(["first", "second"]);
      expect(replay.map((e) => e.id)).toEqual([1, 2]);
      expect(stream.lines).toContain("retry: 3000");
      expect(stream.lines).toContain("event: log");
      expect(stream.lines).toContain("id: 1");

      s.engine.emit("phase", { phase: "parsing" });
      expect(await stream.waitForLines(() => stream.events().length >= 3)).toBe(true);
      const live = stream.events()[2]!;
      expect(live).toMatchObject({ type: "phase", id: 3, data: { phase: "parsing" } });
      expect(typeof live.ts).toBe("number");
    } finally {
      stream.close();
    }
  });

  it("honours Last-Event-ID and the lastEventId query", async () => {
    const s = await startServer();
    for (let i = 0; i < 3; i += 1) s.engine.emit("log", { message: `m${i}` });
    const header = await openStream(s.port, `/events?token=${s.token}`, { "Last-Event-ID": "1" });
    const query = await openStream(s.port, `/events?token=${s.token}&lastEventId=2`);
    const junk = await openStream(s.port, `/events?token=${s.token}&lastEventId=zzz`);
    try {
      await header.waitForLines(() => header.events().length >= 2);
      expect(header.events().map((e) => e.id)).toEqual([2, 3]);
      await query.waitForLines(() => query.events().length >= 1);
      expect(query.events().map((e) => e.id)).toEqual([3]);
      await junk.waitForLines(() => junk.events().length >= 3);
      expect(junk.events().map((e) => e.id)).toEqual([1, 2, 3]);
    } finally {
      header.close();
      query.close();
      junk.close();
    }
  });

  it("sends heartbeats when idle", async () => {
    const s = await startServer();
    const stream = await openStream(s.port, `/events?token=${s.token}`);
    try {
      expect(await stream.waitForLines((l) => l.some((x) => x.startsWith(": heartbeat")))).toBe(true);
    } finally {
      stream.close();
    }
  });

  it("needs a valid token (header or query)", async () => {
    const s = await startServer();
    for (const p of ["/events?token=nope", "/events"]) {
      const stream = await openStream(s.port, p);
      expect(stream.status).toBe(401);
      stream.close();
    }
    const withHeader = await openStream(s.port, "/events", { Authorization: `Bearer ${s.token}` });
    expect(withHeader.status).toBe(200);
    withHeader.close();
  });

  it("refuses an evil origin", async () => {
    const s = await startServer();
    const stream = await openStream(s.port, `/events?token=${s.token}`, { Origin: "https://evil.example" });
    expect(stream.status).toBe(403);
    expect(stream.headers["access-control-allow-origin"]).toBeUndefined();
    stream.close();
  });

  it("carries the CORS headers for an allowed origin", async () => {
    const s = await startServer();
    const stream = await openStream(s.port, `/events?token=${s.token}`);
    expect(stream.headers["access-control-allow-origin"]).toBe(ORIGIN);
    stream.close();
  });

  it("a live run streams its phases and progress in order", async () => {
    const s = await startServer();
    const stream = await openStream(s.port, `/events?token=${s.token}`);
    try {
      s.runner = async (ctx) => {
        ctx.emit({ type: "progress", data: { done: 1, total: 2, elapsed: 0.5, eta: null, stage: "parsing" } });
        ctx.emit({ type: "file", data: { name: "a.pdf", status: "parsed", detail: "" } });
        await sleep(20);
        return pdfResult();
      };
      await body(s, {});
      expect(await stream.waitForLines(() => stream.events().some((e) => e.type === "phase" && e.data.phase === "done"))).toBe(true);
      const types = stream.events().map((e) => `${e.type}:${e.data.phase ?? e.data.name ?? e.data.stage}`);
      expect(types).toEqual(["phase:preparing", "progress:parsing", "file:a.pdf", "phase:done"]);
    } finally {
      stream.close();
    }
  });

  it("secrets in event payloads are scrubbed before they reach the wire", async () => {
    const s = await startServer();
    s.engine.settings.apply(null, { ingestionToken: "wire-secret-token-1234567890" });
    const stream = await openStream(s.port, `/events?token=${s.token}`);
    try {
      s.engine.emit("log", { message: "token is wire-secret-token-1234567890 and key sk-or-v1-0123456789abcdef" });
      await stream.waitForLines(() => stream.events().length >= 1);
      const text = stream.lines.join("\n");
      expect(text).not.toContain("wire-secret-token-1234567890");
      expect(text).not.toContain("sk-or-v1-0123456789abcdef");
    } finally {
      stream.close();
    }
  });
});

describe("event bus", () => {
  it("history is bounded to the replay window", () => {
    const bus = new EventBus();
    for (let i = 0; i < 250; i += 1) bus.publish("log", { message: String(i) });
    const history = bus.history();
    expect(history).toHaveLength(REPLAY_SIZE);
    expect(REPLAY_SIZE).toBe(200);
    expect(history[0]!.id).toBe(51);
    expect(history.at(-1)!.id).toBe(250);
  });

  it("a closed bus ends subscribers", async () => {
    const bus = new EventBus();
    const sub = bus.subscribe();
    bus.close();
    expect(await sub.get(500)).toBeNull();
    expect(await bus.subscribe().get(500)).toBeNull(); // subscribing after close ends at once
  });

  it("a timeout resolves undefined so the caller can send a heartbeat", async () => {
    const bus = new EventBus();
    expect(await bus.subscribe().get(10)).toBeUndefined();
  });

  it("a slow subscriber is cut loose without blocking publishers", async () => {
    const bus = new EventBus();
    const sub = bus.subscribe();
    for (let i = 0; i < SUBSCRIBER_BACKLOG + 5; i += 1) bus.publish("log", { message: String(i) });
    const first = await sub.get(10);
    expect(first).toBeNull(); // overflow: the queue was emptied and the end-of-stream marker left
    bus.publish("log", { message: "after" }); // still works for others
    expect(bus.history().at(-1)!.data.message).toBe("after");
  });

  it("a waiting reader receives the next event at once", async () => {
    const bus = new EventBus();
    const sub = bus.subscribe();
    const pending = sub.get(5000);
    bus.publish("log", { message: "now" });
    expect((await pending)?.data.message).toBe("now");
  });

  it("subscribing after an id replays only newer events", () => {
    const bus = new EventBus();
    for (let i = 0; i < 5; i += 1) bus.publish("log", { message: String(i) });
    expect(bus.subscribe(3).replay.map((e) => e.id)).toEqual([4, 5]);
  });

  it("publish scrubs nested payloads", () => {
    const bus = new EventBus();
    const event = bus.publish("log", { message: "using sk-live-qrstuvwx123", extra: { key: "sk-live-zzzzzzzz9" } });
    expect(JSON.stringify(event)).not.toContain("sk-live");
  });
});

describe("golden: redaction", () => {
  // Registered once for the whole file, the same list the reference had when the fixtures were made.
  for (const value of fixtures.registeredSecrets) registerSecret(value);

  for (const [i, c] of (fixtures.redactions as Array<{ input: unknown; output: string }>).entries()) {
    it(`redact case ${i}: ${JSON.stringify(c.input)?.slice(0, 50)}`, () => expect(redact(c.input)).toBe(c.output));
  }

  it("scrub of a nested payload", () => {
    expect(scrub((fixtures.scrub as any).input)).toEqual((fixtures.scrub as any).output);
  });

  it("keeps ordinary text", () => {
    const text = "Processed 12 files for Asha Rao, 3 tokens used, cost 0.02 USD";
    expect(redact(text)).toBe(text);
  });
});

describe("shutdown", () => {
  it("POST /shutdown stops the server when enabled", async () => {
    const s = await startServer({ enableShutdown: true });
    const res = await s.post("/shutdown", s.authed({ json: {} }));
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ ok: true, stopping: true });
    expect(await waitFor(() => !s.engine.serving)).toBe(true);
    expect(s.engine.stopping).toBe(true);
  });

  it("is disabled (403) unless enabled", async () => {
    const s = await startServer({ enableShutdown: false });
    expect((await s.post("/shutdown", s.authed({ json: {} }))).status).toBe(403);
    expect(s.engine.stopping).toBe(false);
  });

  it("cancels the running batch, ends event streams and waits for the run", async () => {
    const s = await startServer({ enableShutdown: true });
    let ended = false;
    s.runner = (ctx) =>
      new Promise((resolve) => {
        ctx.cancelled.addEventListener("abort", () => {
          ended = true;
          resolve(pdfResult());
        });
      });
    const stream = await openStream(s.port, `/events?token=${s.token}`);
    await body(s, {});
    await s.engine.shutdown();
    expect(ended).toBe(true);
    expect(s.engine.serving).toBe(false);
    expect(s.engine.lastSummary?.phase).toBe("cancelled");
    stream.close();
  });
});

describe("POST /open", () => {
  it("opens a known folder through the injected opener", async () => {
    const opened: string[] = [];
    const s = await startServer({ enableOpenFolder: true, openPath: async (folder) => void opened.push(folder) });
    const res = await s.post("/open", s.authed({ json: { target: "output" } }));
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ ok: true, target: "output" });
    expect(opened).toEqual([s.engine.dirs.output]);
  });

  it("refuses unknown folders with the list of valid ones", async () => {
    const s = await startServer({ enableOpenFolder: true, openPath: async () => undefined });
    const res = await s.post("/open", s.authed({ json: { target: "secrets" } }));
    expect(res.status).toBe(400);
    expect(res.json().error).toBe("Unknown folder: use input, output, old, processed, database or logs.");
    expect((await s.post("/open", s.authed({ json: {} }))).status).toBe(400);
    expect((await s.post("/open", s.authed({ json: { target: "../x" } }))).status).toBe(400);
  });

  it("is 501 when not enabled (hosted mode)", async () => {
    const s = await startServer({ enableOpenFolder: false });
    expect((await s.post("/open", s.authed({ json: { target: "input" } }))).status).toBe(501);
  });

  it("an opener that fails is a 500 with a fixed message", async () => {
    const s = await startServer({ enableOpenFolder: true, openPath: async () => Promise.reject(new Error("explorer exploded")) });
    const res = await s.post("/open", s.authed({ json: { target: "input" } }));
    expect(res.status).toBe(500);
    expect(res.json().error).toBe("The folder could not be opened.");
  });
});
