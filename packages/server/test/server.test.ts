/** Environment configuration, the packaged entry point, the static web UI and a browser-style session (fetch + FormData). */
import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadServerConfig } from "../src/config";
import { startServer as startConfigured } from "../src/index";
import { pdfResult, PDF, signClaims, claimsFor, tempDir, onCleanup, waitFor, ORIGIN, startServer, makeSigner, request } from "./helpers";

const baseEnv = () => {
  const root = tempDir();
  return { root, env: { INTAKE_DATA_DIR: path.join(root, "data"), INTAKE_CONFIG_DIR: path.join(root, "config"), INTAKE_SECRETS_KEY: "ab".repeat(32), INTAKE_WEB_DIR: "off" } as NodeJS.ProcessEnv };
};

describe("loadServerConfig", () => {
  it("defaults to none auth on loopback with the reference port range", () => {
    const cfg = loadServerConfig({ INTAKE_WEB_DIR: "off" });
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.ports[0]).toBe(47831);
    expect(cfg.ports.at(-1)).toBe(47840);
    expect(cfg.engine.auth?.mode).toBe("none");
    expect(cfg.engine.webDir).toBeNull();
  });

  it("INTAKE_PORT fixes the port", () => {
    expect(loadServerConfig({ INTAKE_PORT: "8123", INTAKE_WEB_DIR: "off" }).ports).toEqual([8123]);
    expect(() => loadServerConfig({ INTAKE_PORT: "abc" })).toThrow(/INTAKE_PORT/);
    expect(() => loadServerConfig({ INTAKE_PORT: "70000" })).toThrow(/INTAKE_PORT/);
  });

  it("none auth refuses a non-loopback host", () => {
    expect(() => loadServerConfig({ INTAKE_HOST: "0.0.0.0" })).toThrow(/loopback/);
    expect(loadServerConfig({ INTAKE_HOST: "localhost", INTAKE_WEB_DIR: "off" }).host).toBe("localhost");
  });

  it("an unknown auth mode is refused", () => {
    expect(() => loadServerConfig({ INTAKE_AUTH: "open" })).toThrow(/INTAKE_AUTH/);
  });

  it("token mode needs a long enough token and may listen elsewhere", () => {
    expect(() => loadServerConfig({ INTAKE_AUTH: "token" })).toThrow(/at least/);
    const cfg = loadServerConfig({ INTAKE_AUTH: "token", INTAKE_TOKEN: "static-token-0123456789", INTAKE_HOST: "0.0.0.0", INTAKE_WEB_DIR: "off" });
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.engine.auth?.mode).toBe("token");
  });

  it("signed mode reads the public key from the variable (with literal \\n) or a file", () => {
    const pem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(loadServerConfig({ INTAKE_AUTH: "signed", INTAKE_PUBLIC_KEY: pem.replace(/\n/g, "\\n"), INTAKE_WEB_DIR: "off" }).engine.auth?.mode).toBe("signed");
    const file = path.join(tempDir(), "key.pem");
    fs.writeFileSync(file, pem);
    expect(loadServerConfig({ INTAKE_AUTH: "signed", INTAKE_PUBLIC_KEY_FILE: file, INTAKE_WEB_DIR: "off" }).engine.auth?.mode).toBe("signed");
    expect(() => loadServerConfig({ INTAKE_AUTH: "signed" })).toThrow(/INTAKE_PUBLIC_KEY/);
    expect(() => loadServerConfig({ INTAKE_AUTH: "signed", INTAKE_PUBLIC_KEY: "not a key" })).toThrow();
  });

  it("lists and flags", () => {
    const cfg = loadServerConfig({ INTAKE_ALLOWED_ORIGINS: " https://a.example.test, https://b.example.test ", INTAKE_ALLOWED_HOSTS: "h.example.test", INTAKE_OPEN_FOLDER: "0", INTAKE_ENABLE_SHUTDOWN: "yes", INTAKE_WEB_DIR: "off" });
    expect(cfg.engine.allowedOrigins).toEqual(["https://a.example.test", "https://b.example.test"]);
    expect(cfg.engine.allowedHosts).toEqual(["h.example.test"]);
    expect(cfg.engine.enableOpenFolder).toBe(false);
    expect(cfg.engine.enableShutdown).toBe(true);
  });
});

describe("startServer (the packaged entry)", () => {
  it("starts from the environment, serves /hello and stops cleanly", async () => {
    const { env } = baseEnv();
    const running = await startConfigured({ ports: [0] }, env);
    onCleanup(() => running.stop());
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await request(running.port, "GET", "/hello", { origin: null });
    expect(res.json()).toMatchObject({ app: "resume-intake", auth: "none", port: running.port });
    expect(fs.existsSync(path.join(running.engine.dataRoot, "input"))).toBe(true);
    expect(fs.existsSync(path.join(running.engine.dataRoot, "logs"))).toBe(true);
    await running.stop();
    expect(running.engine.serving).toBe(false);
    await running.stopped;
  });

  it("moves on to the next free port of the range", async () => {
    const { env } = baseEnv();
    const first = await startConfigured({ ports: [0] }, env);
    onCleanup(() => first.stop());
    const second = await startConfigured({ ports: [first.port, 0] }, baseEnv().env);
    onCleanup(() => second.stop());
    expect(second.port).not.toBe(first.port);
  });

  it("fails clearly when no port is free", async () => {
    const { env } = baseEnv();
    const first = await startConfigured({ ports: [0] }, env);
    onCleanup(() => first.stop());
    await expect(startConfigured({ ports: [first.port] }, baseEnv().env)).rejects.toThrow(/No free port/);
  });

  it("a signed-mode server enforces its token end to end", async () => {
    const signer = makeSigner();
    const { env } = baseEnv();
    env.INTAKE_AUTH = "signed";
    env.INTAKE_PUBLIC_KEY = signer.publicKey.export({ type: "spki", format: "pem" }).toString().replace(/\n/g, "\\n");
    const running = await startConfigured({ ports: [0] }, env);
    onCleanup(() => running.stop());
    expect((await request(running.port, "GET", "/state", { origin: null })).status).toBe(401);
    const token = signClaims(signer, claimsFor());
    expect((await request(running.port, "GET", "/state", { origin: null, token })).status).toBe(200);
  });

  it("writes redacted request lines to logs/engine.log, never the query token", async () => {
    const { env } = baseEnv();
    const running = await startConfigured({ ports: [0], engine: { logger: undefined } }, env);
    onCleanup(() => running.stop());
    await request(running.port, "GET", "/state?token=query-token-0123456789abcdef", { origin: null });
    await new Promise((r) => setTimeout(r, 50));
    const log = fs.readFileSync(path.join(running.engine.dirs.logs, "engine.log"), "utf8");
    expect(log).toContain("GET /state 200");
    expect(log).not.toContain("query-token");
  });
});

describe("static web UI", () => {
  function webDir() {
    const dir = path.join(tempDir(), "dist");
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Resume Intake</title>");
    fs.writeFileSync(path.join(dir, "assets", "app-1a2b3c.js"), "console.log(1)");
    fs.writeFileSync(path.join(dir, "assets", "app.css"), "body{}");
    fs.writeFileSync(path.join(dir, "favicon.svg"), "<svg/>");
    fs.writeFileSync(path.join(tempDir(), "secret.txt"), "outside");
    return dir;
  }

  it("serves index.html at / and the built assets with their types", async () => {
    const s = await startServer({ webDir: webDir() });
    const root = await s.get("/", { origin: null });
    expect(root.status).toBe(200);
    expect(String(root.headers["content-type"])).toMatch(/^text\/html/);
    expect(root.text()).toContain("Resume Intake");
    expect(root.headers["cache-control"]).toBe("no-cache");
    const js = await s.get("/assets/app-1a2b3c.js", { origin: null });
    expect(String(js.headers["content-type"])).toMatch(/^text\/javascript/);
    expect(js.headers["cache-control"]).toContain("immutable");
    expect(String((await s.get("/assets/app.css", { origin: null })).headers["content-type"])).toMatch(/^text\/css/);
    expect(String((await s.get("/favicon.svg", { origin: null })).headers["content-type"])).toBe("image/svg+xml");
  });

  it("needs no credentials for the page itself (the API still does)", async () => {
    const s = await startServer({ webDir: webDir() });
    expect((await s.get("/", { origin: null })).status).toBe(200);
    expect((await s.get("/state", { origin: null })).status).toBe(401);
  });

  it("unknown extensionless paths fall back to index.html; unknown files are 404 JSON", async () => {
    const s = await startServer({ webDir: webDir() });
    expect((await s.get("/some/page", { origin: null })).text()).toContain("Resume Intake");
    const missing = await s.get("/assets/nope.js", { origin: null });
    expect(missing.status).toBe(404);
    expect(missing.json().error).toBe("Not found.");
  });

  it("API paths are never shadowed by the page", async () => {
    const s = await startServer({ webDir: webDir() });
    expect((await s.get("/hello", { origin: null })).json().app).toBe("resume-intake");
    expect((await s.post("/state", { origin: null, json: {} })).status).toBe(405);
    expect((await s.get("/files/x.pdf", s.authed({ origin: null }))).status).toBe(405);
  });

  it("cannot read outside the folder", async () => {
    const s = await startServer({ webDir: webDir() });
    for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/assets/..%5c..%5csecret.txt", "/%00", "/%E0%A4%A"]) {
      const res = await s.get(p, { origin: null });
      expect(res.text(), p).not.toContain("outside");
      expect([200, 400, 404], p).toContain(res.status);
    }
  });

  it("answers HEAD without a body and POST to unknown paths with 404", async () => {
    const s = await startServer({ webDir: webDir() });
    const head = await request(s.port, "HEAD", "/", { origin: null });
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    expect(Number(head.headers["content-length"])).toBeGreaterThan(0);
    expect((await request(s.port, "POST", "/nowhere", { origin: null, json: {} })).status).toBe(404);
  });

  it("without a web folder everything unknown is 404", async () => {
    const s = await startServer({ webDir: null });
    expect((await s.get("/", { origin: null })).status).toBe(404);
  });
});

describe("a browser-style session (fetch, FormData, SSE)", () => {
  it("uploads with FormData, lists, runs with commit off, reads results and the CSV", async () => {
    const s = await startServer({ allowedOrigins: [ORIGIN] });
    const base = `http://127.0.0.1:${s.port}`;
    const headers = { Authorization: `Bearer ${s.token}`, Origin: ORIGIN };

    // the page uploads each file as one multipart field named "files"
    const form = new FormData();
    form.append("files", new Blob([PDF], { type: "application/pdf" }), "Asha Rao.pdf");
    const uploaded = await fetch(`${base}/files`, { method: "POST", headers, body: form });
    expect(uploaded.status).toBe(200);
    expect(await uploaded.json()).toEqual({ added: ["Asha Rao.pdf"], rejected: [] });

    const listed = (await (await fetch(`${base}/files`, { headers })).json()) as { files: Array<{ name: string }> };
    expect(listed.files.map((f) => f.name)).toEqual(["Asha Rao.pdf"]);

    const csv = path.join(s.engine.dirs.output, "results.csv");
    fs.writeFileSync(csv, "Name\nAsha Rao\n");
    const input = path.join(s.inputDir, "Asha Rao.pdf");
    s.runner = () => pdfResult({ csvPath: csv, processed: [input], rows: [{ Name: "Asha Rao" }] });
    const started = await fetch(`${base}/run`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ campaignType: "TECH", platform: "Demo", parallel: 2, dryRun: false, jdFilter: false, jdThreshold: 0, driveFolderId: "", inputs: ["Asha Rao.pdf"], commit: { enabled: false } }),
    });
    expect(started.status).toBe(202);
    expect(await waitFor(() => !s.engine.runActive)).toBe(true);

    const state = (await (await fetch(`${base}/state`, { headers })).json()) as any;
    expect(state.lastRun.phase).toBe("done");
    expect(state.queue).toEqual({ pdfs: 0, zips: 0, rosters: 0 }); // the processed file left input/
    const results = (await (await fetch(`${base}/results`, { headers })).json()) as any;
    expect(results).toMatchObject({ available: true, csvAvailable: true, rows: [{ Name: "Asha Rao" }] });
    expect(await (await fetch(`${base}/results.csv`, { headers })).text()).toContain("Asha Rao");
    expect(fs.existsSync(path.join(s.engine.dirs.processed, "Asha Rao.pdf"))).toBe(true);
  });

  it("an EventSource-style reader gets named events", async () => {
    const s = await startServer({ allowedOrigins: [ORIGIN] });
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${s.port}/events?token=${encodeURIComponent(s.token)}`, { headers: { Origin: ORIGIN, Accept: "text/event-stream" }, signal: controller.signal });
    expect(res.status).toBe(200);
    s.engine.emit("phase", { phase: "parsing" });
    const reader = res.body!.getReader();
    let text = "";
    const decoder = new TextDecoder();
    const deadline = Date.now() + 3000;
    while (!text.includes("event: phase") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    controller.abort();
    expect(text).toContain("event: phase");
    expect(text).toMatch(/data: \{"id":1,"type":"phase","ts":[\d.]+,"data":\{"phase":"parsing"\}\}/);
  });
});
