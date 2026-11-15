import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createMockCrm } from "../../mock-crm/src/app.ts";
import { main } from "../src/main.ts";
import type { CoreApi, CliIO } from "../src/runner.ts";
import { appModeArgs, browserCandidates, findBrowser } from "../src/browser.ts";
import { stageInputs } from "../src/workspace.ts";
import { findServer } from "../src/serve.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "intake-cli-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function capture() {
  let out = "";
  let err = "";
  return { stdout: { write: (s: string) => (out += s) }, stderr: { write: (s: string) => (err += s) }, out: () => out, err: () => err };
}

/** A scripted core: emits a few events and returns rows, with no LLM at all. */
function scriptedCore(rows: Array<Record<string, unknown>>, opts: { error?: string | null; failFile?: boolean } = {}): CoreApi {
  return {
    createFakeLlm: () => ({ fake: "llm" }) as never,
    createFakeDrive: () => ({ fake: "drive" }) as never,
    async runBatch(ctx) {
      ctx.emit({ type: "phase", data: { phase: "parsing", total: 2 } });
      ctx.emit({ type: "file", data: { name: "a.pdf", status: "parsed", detail: "" } });
      if (opts.failFile) ctx.emit({ type: "file", data: { name: "b.pdf", status: "quarantined", detail: "unreadable" } });
      ctx.emit({ type: "progress", data: { done: 2, total: 2, elapsed: 1, eta: 0, stage: "parsing" } });
      ctx.emit({ type: "cost", data: { tokens: 100, usd: 0.001 } });
      ctx.emit({ type: "phase", data: { phase: opts.error ? "failed" : "done", ...(opts.error ? { detail: opts.error } : {}) } });
      const csvPath = path.join(ctx.dirs.output, "out.csv");
      fs.writeFileSync(csvPath, "Name\n");
      return { rows, csvPath, counts: {}, cost: { tokens: 100, usd: 0.001 }, failedFiles: [], cancelled: false, error: opts.error ?? null, retryPath: null, runId: "r1", processed: [] };
    },
  };
}

const ROWS = [
  { Name: "Alina Alder", "Email Address": "alina.alder@example.com", "Phone Number": "+447700900101", "Lead ID": "l1" },
  { Name: "Bram Brightwater", "Email Address": "bram@example.com", "Phone Number": "+447700900102", "Lead ID": "l2" },
];

function io(extra: Partial<CliIO> = {}) {
  const cap = capture();
  const input = path.join(tmp, "input-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(input);
  fs.writeFileSync(path.join(input, "a.pdf"), "x");
  fs.writeFileSync(path.join(input, "b.pdf"), "y");
  const full: CliIO = { stdout: cap.stdout, stderr: cap.stderr, env: {}, isTTY: false, cwd: tmp, ...extra };
  return { cap, input, full };
}

describe("intake run (scripted core, mock CRM sink)", () => {
  it("runs, commits to the mock CRM, prints the CSV path last, exits 0", async () => {
    const crm = createMockCrm();
    const fetchImpl = ((url: string | URL, init?: RequestInit) => crm.app.request(String(url).replace(/^https?:\/\/[^/]+/, ""), init)) as typeof fetch;
    const { cap, input, full } = io({ core: scriptedCore(ROWS), fetch: fetchImpl });
    const code = await main(["run", input, "--fake", "--sink", "http://127.0.0.1:47900", "--mint-token", "--campaign", "Backend Engineer"], full);
    expect(cap.err()).toBe("");
    expect(code).toBe(0);
    expect(crm.store.applications.map((a) => a.email)).toEqual(["alina.alder@example.com", "bram@example.com"]);
    const lines = cap.out().trim().split("\n");
    expect(lines.some((l) => l.startsWith("[sink] done: 2 created"))).toBe(true);
    expect(lines.at(-1)).toMatch(/^CSV: .*out\.csv$/);
  });

  it("dry run commits nothing", async () => {
    const crm = createMockCrm();
    const fetchImpl = ((url: string | URL, init?: RequestInit) => crm.app.request(String(url).replace(/^https?:\/\/[^/]+/, ""), init)) as typeof fetch;
    const { cap, input, full } = io({ core: scriptedCore(ROWS), fetch: fetchImpl });
    const code = await main(["run", input, "--fake", "--dry-run", "--sink", "http://127.0.0.1:47900", "--mint-token", "--campaign-id", "1"], full);
    expect(code).toBe(0);
    expect(crm.store.applications).toHaveLength(0);
    expect(cap.out()).toContain("nothing committed");
  });

  it("exits 3 when a file failed and 1 when the run failed", async () => {
    const a = io({ core: scriptedCore(ROWS, { failFile: true }) });
    expect(await main(["run", a.input, "--fake"], a.full)).toBe(3);
    expect(a.cap.out()).toContain("b.pdf: quarantined - unreadable");
    const b = io({ core: scriptedCore([], { error: "provider quota reached" }) });
    expect(await main(["run", b.input, "--fake"], b.full)).toBe(1);
    expect(b.cap.out()).toContain("Error: provider quota reached");
  });

  it("exits 3 when the commit fails but still prints the CSV", async () => {
    const down = (() => Promise.reject(new Error("refused"))) as typeof fetch;
    const { cap, input, full } = io({ core: scriptedCore(ROWS), fetch: down });
    const code = await main(["run", input, "--fake", "--sink", "http://127.0.0.1:47900", "--token", "tok-123456", "--campaign-id", "1"], full);
    expect(code).toBe(3);
    expect(cap.out()).toContain("could not be reached");
    expect(cap.out().trim().split("\n").at(-1)).toMatch(/^CSV: /);
  });

  it("needs a key without --fake, and never prints the key", async () => {
    const a = io({ core: scriptedCore(ROWS) });
    expect(await main(["run", a.input], a.full)).toBe(2);
    expect(a.cap.err()).toContain("INTAKE_OPENROUTER_API_KEY");
    const secret = "sk-or-v1-supersecretvalue1234567890";
    const b = io({ core: { ...scriptedCore(ROWS), runBatch: async () => { throw new Error(`upstream said ${secret} is bad`); } }, env: { INTAKE_OPENROUTER_API_KEY: secret } });
    expect(await main(["run", b.input, "--plain"], b.full)).toBe(1);
    expect(b.cap.out() + b.cap.err()).not.toContain(secret);
  });

  it("passes the options and fakes to core, and stages inputs without touching originals", async () => {
    let seen: Parameters<CoreApi["runBatch"]>[0] | null = null;
    const base = scriptedCore(ROWS);
    const spy: CoreApi = { ...base, runBatch: (ctx) => { seen = ctx; return base.runBatch(ctx); } };
    const { input, full } = io({ core: spy });
    await main(["run", input, "--fake", "--campaign", "Teacher", "--parallel", "3", "--dry-run"], full);
    expect(seen!.options).toMatchObject({ campaignType: "Teacher", parallel: 3, dryRun: true, driveFolderId: "fake-folder" });
    expect(seen!.http).toEqual({ fake: "llm" });
    expect(fs.readdirSync(seen!.dirs.input).sort()).toEqual(["a.pdf", "b.pdf"]);
    expect(fs.readdirSync(input).sort()).toEqual(["a.pdf", "b.pdf"]);
  });

  it("emits one JSON event per line with --json", async () => {
    const { cap, input, full } = io({ core: scriptedCore(ROWS) });
    await main(["run", input, "--fake", "--json"], full);
    const events = cap.out().trim().split("\n").map((l) => JSON.parse(l) as { type: string });
    expect(events.map((e) => e.type)).toContain("result");
    expect(events[0]?.type).toBe("phase");
  });

  it("reports bad usage with exit 2 and a missing input folder with exit 2", async () => {
    const a = io();
    expect(await main(["run"], a.full)).toBe(2);
    expect(await main(["run", path.join(tmp, "nope"), "--fake"], a.full)).toBe(2);
    expect(a.cap.err()).toContain("Not found");
  });
});

describe("workspace", () => {
  it("flattens folders, skips hidden files and de-duplicates names", () => {
    const root = fs.mkdtempSync(path.join(tmp, "ws-"));
    fs.mkdirSync(path.join(root, "one", "sub"), { recursive: true });
    fs.mkdirSync(path.join(root, "two"));
    fs.writeFileSync(path.join(root, "one", "cv.pdf"), "1");
    fs.writeFileSync(path.join(root, "one", "sub", "cv.pdf"), "2");
    fs.writeFileSync(path.join(root, "one", ".hidden"), "3");
    fs.writeFileSync(path.join(root, "one", "Thumbs.db"), "4");
    fs.writeFileSync(path.join(root, "two", "cv.pdf"), "5");
    const ws = stageInputs([path.join(root, "one"), path.join(root, "two", "cv.pdf")], path.join(root, "work"));
    expect(ws.staged.sort()).toEqual(["cv-2.pdf", "cv.pdf", "sub_cv.pdf"]);
    expect(fs.existsSync(ws.dirs.output)).toBe(true);
  });
});

describe("browser and server discovery", () => {
  it("builds app-mode arguments", () => {
    expect(appModeArgs("http://127.0.0.1:47831")[0]).toBe("--app=http://127.0.0.1:47831");
  });

  it("prefers Edge on Windows and honours INTAKE_BROWSER", () => {
    const env = { "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramFiles: "C:\\Program Files" };
    expect(browserCandidates("win32", env)[0]).toContain("msedge.exe");
    expect(findBrowser("win32", env, (p) => p.includes("chrome.exe"))).toContain("chrome.exe");
    expect(findBrowser("win32", env, () => false)).toBeNull();
    expect(findBrowser("linux", { INTAKE_BROWSER: "/opt/b" }, (p) => p === "/opt/b")).toBe("/opt/b");
    expect(findBrowser("darwin", {}, (p) => p.includes("Google Chrome"))).toContain("Google Chrome");
  });

  it("finds a server by probing /hello", async () => {
    const probe = ((url: string | URL) => (String(url).includes(":47833/") ? Promise.resolve(new Response(JSON.stringify({ app: "resume-intake" }))) : Promise.reject(new Error("refused")))) as typeof fetch;
    expect(await findServer([47831, 47832, 47833], probe)).toBe("http://127.0.0.1:47833");
    expect(await findServer([47831], probe)).toBeNull();
    const other = (() => Promise.resolve(new Response(JSON.stringify({ app: "something-else" })))) as typeof fetch;
    expect(await findServer([47831], other)).toBeNull();
  });
});
