/**
 * Ingestion sink: request parsing, items, identity and idempotency key (golden against the reference), preflight statuses,
 * READY-only batches, token secrecy, failure and retry. A fake downstream system answers on 127.0.0.1.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildItems, CommitError, Committer, idempotencyKey, identityKey, parseRequest, type Row } from "../src/sink-commit";
import fixtures from "./golden/fixtures.json";
import { onCleanup, pdfResult, startServer, waitFor, type Running } from "./helpers";

const TOKEN = "tok-SECRETVALUE-0123456789abcdef";
const CAMPAIGN = 7;

describe("golden: parseRequest", () => {
  for (const c of fixtures.parseRequest as Array<{ input: unknown; ok?: unknown; error?: string }>) {
    it(JSON.stringify(c.input) ?? "undefined", () => {
      if (c.error !== undefined) expect(() => parseRequest(c.input)).toThrow(c.error);
      else expect(parseRequest(c.input)).toEqual(c.ok);
    });
  }
});

describe("golden: items, identity and idempotency key", () => {
  // The reference's key prefix is product branded; the 32 hex digits are the logic.
  const tail = (key: string) => key.slice(key.indexOf("-") + 1);

  it("buildItems matches the reference row for row", () => {
    const b = fixtures.build as any;
    const got = buildItems(b.rows, b.request);
    expect(got.items).toEqual(b.items);
    expect(got.keys).toEqual(b.keys);
    expect(got.leftOut).toBe(b.leftOut);
  });

  for (const c of fixtures.identities as Array<{ item: any; key: string }>) {
    it(`identityKey ${JSON.stringify(c.item)}`, () => expect(identityKey(c.item)).toBe(c.key));
  }

  for (const c of fixtures.idempotency as Array<{ keys: string[]; campaignId: number; key: string }>) {
    it(`idempotencyKey ${JSON.stringify(c.keys).slice(0, 60)} / ${c.campaignId}`, () => {
      const key = idempotencyKey(c.keys, c.campaignId);
      expect(key).toMatch(/^intake-[0-9a-f]{32}$/);
      expect(tail(key)).toBe(tail(c.key));
    });
  }

  it("the key is stable, order free and per campaign", () => {
    const keys = ["email:a@x.test", "phone:9876543210"];
    const key = idempotencyKey(keys, 7);
    expect(idempotencyKey([...keys].reverse(), 7)).toBe(key);
    expect(idempotencyKey(keys, 8)).not.toBe(key);
  });
});

describe("buildItems", () => {
  const rows: Row[] = [
    { "Lead ID": "L-asha", Name: "Asha Rao", "Email Address": "asha@example.test", "Phone Number": "+919876543210", Resume: "https://files.example.test/a", "Current Location": "Pune", Graduation: "B.Tech" },
    { "Lead ID": "L-ben", Name: "Ben Kaur", "Email Address": "ben@example.test", "Phone Number": "+919812345678" },
    { "Lead ID": "L-none", Name: "No Contact", "Email Address": "", "Phone Number": "" },
    { "Lead ID": "L-ns", Name: "Not Specified", "Email Address": "ns@example.test", "Phone Number": "" },
  ];
  it("takes only rows with a name and a contact", () => {
    const { items, keys, leftOut } = buildItems(rows, { enabled: true, campaignId: CAMPAIGN, source: "Demo", stage: "LEAD" });
    expect(items.map((i) => i.name)).toEqual(["Asha Rao", "Ben Kaur"]);
    expect(leftOut).toBe(2);
    expect(items[0]).toMatchObject({ email: "asha@example.test", phone: "+919876543210", resumeUrl: "https://files.example.test/a", campaignId: CAMPAIGN, source: "Demo", stage: "LEAD", leadId: "L-asha", currentLocation: "Pune", graduation: "B.Tech" });
    expect(keys[0]).toBe("email:asha@example.test");
  });
});

// ── a fake downstream system ────────────────────────────────────────────────────────────────────────────────────
class FakeSink {
  expectedToken = TOKEN;
  statuses: Record<string, string> = {};
  preflightCode = 200;
  batchCode = 200;
  calls: Array<{ path: string; auth: string; body: any }> = [];
  committed = new Set<string>();
  keys = new Map<string, any>();
  server: http.Server;
  url = "";

  constructor() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        const auth = req.headers.authorization ?? "";
        this.calls.push({ path: req.url ?? "", auth, body });
        const [status, payload] = this.answer(req.url ?? "", auth, body);
        const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
        res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw) });
        res.end(raw);
      });
    });
  }

  async listen(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as any).port}`;
    onCleanup(() => new Promise<void>((r) => {
      this.server.close(() => r());
      this.server.closeAllConnections();
    }));
    return this;
  }

  answer(urlPath: string, auth: string, body: any): [number, unknown] {
    if (auth !== `Bearer ${this.expectedToken}`) return [401, { error: "Valid ingestion token required." }];
    const items: any[] = body.items ?? [];
    if (urlPath === "/api/ingestion/preflight") {
      if (this.preflightCode !== 200) return [this.preflightCode, { error: "preflight failed" }];
      const rows = items.map((item, index) => ({ index, status: this.committed.has(item.email ?? "") ? "DUPLICATE" : (this.statuses[item.email ?? ""] ?? "READY"), item }));
      return [200, { ready: rows.filter((r) => r.status === "READY").length, total: rows.length, rows }];
    }
    if (urlPath === "/api/ingestion/batch") {
      const key = body.idempotencyKey;
      if (this.keys.has(key)) return [200, { ...this.keys.get(key), replayed: true }];
      if (this.batchCode !== 200) return [this.batchCode, { error: "batch failed" }];
      for (const item of items) this.committed.add(item.email ?? "");
      const result = { batchId: this.keys.size + 1, idempotencyKey: key, applications: items.map((_, i) => ({ id: i + 1 })) };
      this.keys.set(key, result);
      return [200, result];
    }
    return [404, { error: "not found" }];
  }

  batchCalls() {
    return this.calls.filter((c) => c.path === "/api/ingestion/batch");
  }
}

const ROWS: Row[] = [
  { "Lead ID": "L-asha", Name: "Asha Rao", "Email Address": "asha@example.test", "Phone Number": "+919876543210", Resume: "https://files.example.test/a", "Current Location": "Pune", Graduation: "B.Tech" },
  { "Lead ID": "L-ben", Name: "Ben Kaur", "Email Address": "ben@example.test", "Phone Number": "+919812345678" },
  { "Lead ID": "L-dup", Name: "Dup Person", "Email Address": "dup@example.test", "Phone Number": "" },
  { "Lead ID": "L-conf", Name: "Conf Person", "Email Address": "conf@example.test", "Phone Number": "" },
  { "Lead ID": "L-blk", Name: "Blocked Person", "Email Address": "blk@example.test", "Phone Number": "" },
  { "Lead ID": "L-none", Name: "No Contact", "Email Address": "", "Phone Number": "" },
  { "Lead ID": "L-ns", Name: "Not Specified", "Email Address": "ns@example.test", "Phone Number": "" },
];
const STATUSES = { "dup@example.test": "DUPLICATE", "conf@example.test": "CONFLICT", "blk@example.test": "BLOCKED" };
const commitRequest = (enabled = true) => ({ enabled, campaignId: CAMPAIGN, source: "Demo source", stage: "LEAD" });

async function setup(): Promise<{ s: Running; sink: FakeSink }> {
  const sink = await new FakeSink().listen();
  const s = await startServer();
  return { s, sink };
}

const configure = (s: Running, url: string, token = TOKEN) => s.engine.settings.apply({ crmBaseUrl: url }, { ingestionToken: token });

async function doRun(s: Running, opts: { rows?: Row[]; commit?: unknown; csv?: boolean; error?: string | null; counts?: Record<string, number>; processed?: string[] } = {}) {
  const out = s.engine.dirs.output;
  const csvPath = path.join(out, "results.csv");
  const csv = opts.csv ?? true;
  if (csv) fs.writeFileSync(csvPath, "Name,Email Address\nAsha Rao,asha@example.test\n");
  const rows = opts.rows ?? ROWS;
  s.runner = () => pdfResult({ rows, csvPath: csv ? csvPath : null, counts: opts.counts ?? { rows: rows.length }, cost: { tokens: 0, usd: 0 }, error: opts.error ?? null, processed: opts.processed ?? [] });
  const res = await s.post("/run", s.authed({ json: opts.commit === undefined ? {} : { commit: opts.commit } }));
  expect(res.status, res.text()).toBe(202);
  expect(await waitFor(() => !s.engine.runActive, 10_000)).toBe(true);
  return csvPath;
}

const commitState = async (s: Running) => (await s.get("/state", s.authed())).json().commit;
const events = (s: Running, kind: string) => s.engine.bus.history().filter((e) => e.type === kind).map((e) => e.data);
const phases = (s: Running) => s.engine.bus.history().filter((e) => e.type === "phase").map((e) => e.data.phase);

describe("commit through the server", () => {
  it("counts preflight statuses and commits only READY rows", async () => {
    const { s, sink } = await setup();
    sink.statuses = { ...STATUSES };
    configure(s, sink.url);
    await doRun(s, { commit: commitRequest() });

    const state = await commitState(s);
    expect(state).toMatchObject({ status: "done", enabled: true, configured: true });
    expect(state.counts).toMatchObject({ ready: 2, duplicate: 1, conflict: 1, invalid: 3, created: 2, skipped: 5 });

    expect(sink.batchCalls()).toHaveLength(1);
    const batch = sink.batchCalls()[0]!;
    expect(batch.body.items.map((i: any) => i.email).sort()).toEqual(["asha@example.test", "ben@example.test"]);
    expect(batch.body.items[0]).toMatchObject({ source: "Demo source", stage: "LEAD", campaignId: CAMPAIGN });
    expect(batch.body.idempotencyKey).toMatch(/^intake-[0-9a-f]{32}$/);

    expect(events(s, "commit_preflight")).toEqual([{ ready: 2, duplicate: 1, conflict: 1, invalid: 3 }]);
    expect(events(s, "commit_started")).toEqual([{ campaignId: CAMPAIGN, rows: ROWS.length }]);
    const done = events(s, "commit_done");
    expect(done[0]).toMatchObject({ created: 2, batchId: 1 });
    expect(String(done[0]!.idempotencyKey)).toMatch(/^intake-/);
    expect(phases(s).at(-1)).toBe("done");
  });

  it("sends the bearer token, and the key is stable across a retry", async () => {
    const { s, sink } = await setup();
    sink.batchCode = 503;
    configure(s, sink.url);
    await doRun(s, { commit: commitRequest() });
    expect((await commitState(s)).status).toBe("failed");

    sink.batchCode = 200;
    const res = await s.post("/commit/retry", s.authed({ json: {} }));
    expect(res.status).toBe(200);
    expect(res.json().status).toBe("done");
    const batches = sink.batchCalls();
    expect(batches).toHaveLength(2);
    expect(new Set(batches.map((b) => b.body.idempotencyKey)).size).toBe(1);
    expect(batches[0]!.body.items).toEqual(batches[1]!.body.items);
    expect(sink.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("the token never reaches events, state, hello, the CSV, the config or the logs", async () => {
    const lines: string[] = [];
    const { s, sink } = await setup();
    const log = s.engine.log;
    (log as any).info = (m: string) => lines.push(m);
    (log as any).warn = (m: string) => lines.push(m);
    (log as any).error = (m: string) => lines.push(m);
    sink.batchCode = 500;
    sink.statuses = { ...STATUSES };
    configure(s, sink.url);
    const csv = await doRun(s, { commit: commitRequest() });
    await s.post("/commit/retry", s.authed({ json: {} }));
    const haystacks = [
      JSON.stringify(s.engine.bus.history()),
      JSON.stringify((await s.get("/state", s.authed())).json()),
      JSON.stringify((await s.get("/hello")).json()),
      lines.join("\n"),
      fs.readFileSync(csv, "utf8"),
      fs.readFileSync(path.join(s.root, "AppData", "config.json"), "utf8"),
    ];
    for (const text of haystacks) expect(text).not.toContain(TOKEN);
    expect(sink.calls.length).toBeGreaterThan(0); // the token was really sent, to the sink only
  });

  it("a commit failure never fails the run and the CSV is kept", async () => {
    const { s, sink } = await setup();
    sink.batchCode = 500;
    configure(s, sink.url);
    const csv = await doRun(s, { commit: commitRequest() });
    expect(phases(s).at(-1)).toBe("done");
    expect(fs.readFileSync(csv, "utf8")).toContain("Asha Rao");
    const state = await commitState(s);
    expect(state.status).toBe("failed");
    expect(state.lastError).toContain("internal error (HTTP 500)");
    expect(events(s, "commit_failed")).toEqual([{ stage: "batch", status: 500, message: state.lastError }]);
    expect(events(s, "commit_done")).toEqual([]);
  });

  it("a refused token is reported without echoing anything", async () => {
    const { s, sink } = await setup();
    configure(s, sink.url, "wrong-token-0123456789");
    await doRun(s, { commit: commitRequest() });
    const state = await commitState(s);
    expect(state.status).toBe("failed");
    expect(state.lastError).toBe("The CRM no longer accepts this engine's token. Reconnect to issue a new one.");
    expect(state.tokenRejected).toBe(true);
    expect(events(s, "commit_failed")[0]!.stage).toBe("preflight");
  });

  it("a retry commits after a failure and a second retry is idempotent", async () => {
    const { s, sink } = await setup();
    sink.batchCode = 500;
    sink.statuses = { ...STATUSES };
    configure(s, sink.url);
    await doRun(s, { commit: commitRequest() });

    sink.batchCode = 200;
    const first = await s.post("/commit/retry", s.authed({ json: {} }));
    expect(first.status).toBe(200);
    expect(first.json().counts.created).toBe(2);
    expect(sink.batchCalls()).toHaveLength(2);

    const second = await s.post("/commit/retry", s.authed({ json: {} }));
    expect(second.status).toBe(200);
    expect(second.json().status).toBe("done");
    expect(second.json().counts.created).toBe(2);
    expect(second.json().batchId).toBe(first.json().batchId);
    expect(sink.batchCalls()).toHaveLength(2); // nothing new was sent downstream
  });

  it("a retry needs a finished run with a commit", async () => {
    const { s, sink } = await setup();
    configure(s, sink.url);
    expect((await s.post("/commit/retry", s.authed({ json: {} }))).status).toBe(409);
    await doRun(s, { commit: { enabled: false } });
    expect((await s.post("/commit/retry", s.authed({ json: {} }))).status).toBe(409);
    expect(sink.calls).toEqual([]);
  });

  it("a retry is refused while a run is active", async () => {
    const { s, sink } = await setup();
    configure(s, sink.url);
    await doRun(s, { commit: commitRequest() });
    let release!: () => void;
    s.runner = () => new Promise((resolve) => (release = () => resolve(pdfResult())));
    expect((await s.post("/run", s.authed({ json: {} }))).status).toBe(202);
    expect((await s.post("/commit/retry", s.authed({ json: {} }))).status).toBe(409);
    release();
    expect(await waitFor(() => !s.engine.runActive)).toBe(true);
  });

  it("commit disabled makes no downstream calls", async () => {
    const { s, sink } = await setup();
    configure(s, sink.url);
    await doRun(s, { commit: { enabled: false } });
    expect(sink.calls).toEqual([]);
    expect(await commitState(s)).toMatchObject({ enabled: false, status: "skipped" });
    expect(events(s, "commit_started")).toEqual([]);
  });

  it("no commit key at all is the same as disabled", async () => {
    const { s, sink } = await setup();
    configure(s, sink.url);
    await doRun(s);
    expect(sink.calls).toEqual([]);
    expect((await commitState(s)).status).toBe("skipped");
  });

  it("a failed run is not committed", async () => {
    const { s, sink } = await setup();
    configure(s, sink.url);
    await doRun(s, { commit: commitRequest(), error: "pipeline broke" });
    expect(sink.calls).toEqual([]);
    expect((await commitState(s)).status).toBe("skipped");
  });

  it("the commit needs an address and a token before the run starts", async () => {
    const { s } = await setup();
    s.runner = () => {
      throw new Error("the run must not start");
    };
    const res = await s.post("/run", s.authed({ json: { commit: commitRequest() } }));
    expect(res.status).toBe(422);
    expect(res.json().error).toContain("not set up");
    expect(s.engine.runActive).toBe(false);
  });

  it("a plain-http address is refused by the committer without any request", async () => {
    const { s, sink } = await setup();
    const state = await s.engine.committer.run("http://sink.example.test", TOKEN, commitRequest(), ROWS);
    expect(state.status).toBe("failed");
    expect(state.lastError).toContain("must use https");
    expect(sink.calls).toEqual([]);
  });

  it("an LLM base outside the allowlist stops the run before it starts", async () => {
    const { s, sink } = await setup();
    configure(s, sink.url);
    s.engine.settings.config.settings.llmBaseUrl = "https://example.test/api/v1"; // as if hand-edited
    s.runner = () => {
      throw new Error("the run must not start");
    };
    const res = await s.post("/run", s.authed({ json: {} }));
    expect(res.status).toBe(422);
    expect(res.json().error).toContain("llmBaseUrl is not allowed");
  });

  it("hello and state report the commit", async () => {
    const { s, sink } = await setup();
    const before = (await s.get("/hello")).json();
    expect(before).toMatchObject({ protocol: 1, commitConfigured: false });
    configure(s, sink.url);
    expect((await s.get("/hello")).json().commitConfigured).toBe(true);
    expect((await commitState(s)).configured).toBe(true);
  });

  for (const body of [{ commit: { enabled: true } }, { commit: { enabled: true, campaignId: "7" } }, { commit: { enabled: true, campaignId: 7, stage: "bad stage!" } }, { commit: "yes" }]) {
    it(`bad commit body ${JSON.stringify(body)} is 400`, async () => {
      const { s, sink } = await setup();
      configure(s, sink.url);
      s.runner = () => {
        throw new Error("the run must not start");
      };
      expect((await s.post("/run", s.authed({ json: body }))).status).toBe(400);
      expect(s.engine.runActive).toBe(false);
    });
  }

  it("a new run that adds nothing reports zero created", async () => {
    const { s, sink } = await setup();
    sink.statuses = { ...STATUSES };
    configure(s, sink.url);
    await doRun(s, { commit: commitRequest() });
    expect((await commitState(s)).counts.created).toBe(2);
    await doRun(s, { commit: commitRequest() });
    const state = await commitState(s);
    expect(sink.batchCalls()).toHaveLength(1);
    expect(state.counts).toMatchObject({ ready: 0, created: 0 });
  });

  it("in-batch duplicates are part of the skipped count", async () => {
    const { s, sink } = await setup();
    sink.statuses = { ...STATUSES };
    configure(s, sink.url);
    await doRun(s, { commit: commitRequest(), counts: { rows: ROWS.length, in_batch_duplicates: 2, duplicate_content: 1 } });
    const state = await commitState(s);
    expect(state.counts.inBatchDuplicates).toBe(3);
    expect(state.counts.duplicate).toBe(1);
    expect(state.counts.skipped).toBe(5 + 3);
    expect(events(s, "commit_done")[0]!.skipped).toBe(8);
    expect(events(s, "commit_preflight")).toEqual([{ ready: 2, duplicate: 1, conflict: 1, invalid: 3 }]);
  });

  it("no in-batch duplicates reports zero", async () => {
    const { s, sink } = await setup();
    configure(s, sink.url);
    await doRun(s, { commit: commitRequest() });
    expect((await commitState(s)).counts.inBatchDuplicates).toBe(0);
  });
});

describe("archiving processed input files", () => {
  it("a good commit moves the run's files to processed", async () => {
    const { s, sink } = await setup();
    configure(s, sink.url);
    const files = ["a.pdf", "b.pdf"].map((n) => path.join(s.inputDir, n));
    for (const f of files) fs.writeFileSync(f, "%PDF-1.4 synthetic");
    await doRun(s, { commit: commitRequest(), processed: files });
    expect((await commitState(s)).status).toBe("done");
    expect(files.some((f) => fs.existsSync(f))).toBe(false);
    expect(fs.existsSync(path.join(s.engine.dirs.processed, "a.pdf"))).toBe(true);
    expect(fs.existsSync(path.join(s.engine.dirs.processed, "b.pdf"))).toBe(true);
    expect(fs.existsSync(path.join(s.engine.dirs.output, "results.csv"))).toBe(true); // the CSV is kept
  });

  it("a failed commit keeps the input files until a retry succeeds", async () => {
    const { s, sink } = await setup();
    sink.batchCode = 500;
    configure(s, sink.url);
    const f = path.join(s.inputDir, "cv.pdf");
    fs.writeFileSync(f, "%PDF-1.4 synthetic");
    await doRun(s, { commit: commitRequest(), processed: [f] });
    expect((await commitState(s)).status).toBe("failed");
    expect(fs.existsSync(f)).toBe(true);
    expect(fs.existsSync(path.join(s.engine.dirs.processed, "cv.pdf"))).toBe(false);

    sink.batchCode = 200;
    const res = await s.post("/commit/retry", s.authed({ json: {} }));
    expect(res.status).toBe(200);
    expect(res.json().status).toBe("done");
    expect(fs.existsSync(f)).toBe(false);
    expect(fs.existsSync(path.join(s.engine.dirs.processed, "cv.pdf"))).toBe(true);
  });

  it("commit off moves the files at once; a failed run moves nothing", async () => {
    const { s, sink } = await setup();
    const ok = path.join(s.inputDir, "ok.pdf");
    fs.writeFileSync(ok, "x");
    await doRun(s, { commit: { enabled: false }, processed: [ok] });
    expect(fs.existsSync(ok)).toBe(false);
    expect(fs.existsSync(path.join(s.engine.dirs.processed, "ok.pdf"))).toBe(true);
    expect(sink.calls).toEqual([]);

    const bad = path.join(s.inputDir, "bad.pdf");
    fs.writeFileSync(bad, "x");
    await doRun(s, { commit: { enabled: false }, processed: [bad], error: "the run broke" });
    expect(fs.existsSync(bad)).toBe(true);
    expect(fs.existsSync(path.join(s.engine.dirs.processed, "bad.pdf"))).toBe(false);
  });

  it("a name clash in processed gets a number and nothing is deleted", async () => {
    const { s } = await setup();
    const processed = s.engine.dirs.processed;
    fs.writeFileSync(path.join(processed, "cv.pdf"), "earlier");
    const cv = path.join(s.inputDir, "cv.pdf");
    fs.writeFileSync(cv, "new");
    await doRun(s, { commit: { enabled: false }, processed: [cv] });
    expect(fs.readFileSync(path.join(processed, "cv.pdf"), "utf8")).toBe("earlier");
    expect(fs.readFileSync(path.join(processed, "cv (1).pdf"), "utf8")).toBe("new");
    expect(fs.existsSync(cv)).toBe(false);
  });

  it("files outside the input folder are never moved", async () => {
    const { s } = await setup();
    const outside = path.join(s.root, "outside.pdf");
    fs.writeFileSync(outside, "keep");
    await doRun(s, { commit: { enabled: false }, processed: [outside] });
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.existsSync(path.join(s.engine.dirs.processed, "outside.pdf"))).toBe(false);
  });
});

describe("Committer unit behaviour", () => {
  it("the downstream base is validated and the token required", async () => {
    const emitted: string[] = [];
    const committer = new Committer((type) => emitted.push(type));
    expect((await committer.run("https://sink.example.test", "", commitRequest(), ROWS)).lastError).toContain("No CRM ingestion token");
    expect((await committer.run("not a url", TOKEN, commitRequest(), ROWS)).status).toBe("failed");
    expect(emitted.filter((t) => t === "commit_failed")).toHaveLength(2);
  });

  it("an unreachable downstream is a fixed sentence, never the network error text", async () => {
    const committer = new Committer(() => {}, (async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.1:443 token=secret");
    }) as unknown as typeof fetch);
    const state = await committer.run("https://sink.example.test", TOKEN, commitRequest(), ROWS);
    expect(state.lastError).toBe("The CRM could not be reached. The files are kept; retry the commit when it is back.");
  });

  it("an unexpected downstream answer is reported, a redirect counts as an error", async () => {
    const answer = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;
    let state = await new Committer(() => {}, answer(200, "not json")).run("https://sink.example.test", TOKEN, commitRequest(), ROWS);
    expect(state.lastError).toBe("The CRM answered with something unexpected.");
    state = await new Committer(() => {}, answer(200, "[]")).run("https://sink.example.test", TOKEN, commitRequest(), ROWS);
    expect(state.lastError).toBe("The CRM answered with something unexpected.");
    state = await new Committer(() => {}, answer(302, "")).run("https://sink.example.test", TOKEN, commitRequest(), ROWS);
    expect(state.lastError).toBe("The CRM answered HTTP 302 at the preflight step.");
    for (const [code, text] of [[403, "refused the ingestion request (HTTP 403)"], [409, "identity conflicts"], [413, "larger than"], [422, "duplicate or invalid"], [429, "busy"], [502, "internal error (HTTP 502)"]] as const) {
      state = await new Committer(() => {}, answer(code, "x")).run("https://sink.example.test", TOKEN, commitRequest(), ROWS);
      expect(state.lastError).toContain(text);
    }
  });

  it("a malformed preflight result is reported", async () => {
    const answer = (payload: unknown) => (async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
    for (const payload of [{ rows: "x" }, { rows: [] }, { rows: [{ index: 99, status: "READY" }, { index: 0, status: "READY" }, { index: 1, status: "READY" }, { index: 2, status: "READY" }, { index: 3, status: "READY" }] }, {}]) {
      const state = await new Committer(() => {}, answer(payload)).run("https://sink.example.test", TOKEN, commitRequest(), ROWS.slice(0, 5));
      expect(state.status).toBe("failed");
    }
  });

  it("an empty set of items still reports done without any request", async () => {
    let calls = 0;
    const committer = new Committer(() => {}, (async () => {
      calls += 1;
      return new Response("{}");
    }) as unknown as typeof fetch);
    const state = await committer.run("https://sink.example.test", TOKEN, commitRequest(), [{ Name: "Nobody" }]);
    expect(state.status).toBe("done");
    expect(state.counts).toMatchObject({ rows: 1, ready: 0, invalid: 1, created: 0, skipped: 1 });
    expect(calls).toBe(0);
  });

  it("CommitError carries its stage and status", () => {
    const err = new CommitError("batch", 500, "m");
    expect([err.stage, err.status, err.message]).toEqual(["batch", 500, "m"]);
  });
});
