/** The real pipeline (@intake/core) behind the real server, with the offline fake LLM and fake Drive. */
import fs from "node:fs";
import path from "node:path";
import { createFakeDrive, createFakeLlm, runBatch } from "@intake/core";
import { describe, expect, it } from "vitest";
import { multipart, startServer, waitFor, type Running } from "./helpers";

/** A one-page text PDF (Helvetica), written by hand so the test needs nothing else. */
function textPdf(lines: string[]): Buffer {
  const esc = (t: string) => t.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const content = lines.map((line, i) => `BT /F1 10 Tf 60 ${760 - i * 14} Td (${esc(line)}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const RESUME = textPdf([
  "Asha Rao",
  "Email: asha.rao@example.test   Phone: +91 98765 43210",
  "Location: Pune, India",
  "Education: B.Tech Computer Science, 2021",
  "Experience: Software engineer, five years of TypeScript and Python.",
  "Skills: TypeScript, Python, SQL, testing, Docker, Kubernetes, leadership and mentoring of small teams.",
  "Projects: built a payment reconciliation service and a data pipeline for monthly reporting at scale.",
]);

async function pipelineServer(): Promise<{ s: Running; drive: ReturnType<typeof createFakeDrive> }> {
  const drive = createFakeDrive();
  const llm = createFakeLlm();
  const s = await startServer({ runner: (ctx) => runBatch({ ...ctx, http: llm, drive }) });
  s.engine.settings.apply(
    { llmBaseUrl: "http://127.0.0.1:9/api/v1", defaultCampaignType: "TECH" },
    { openrouterApiKey: "sk-or-v1-0123456789abcdef0123456789" },
  );
  return { s, drive };
}

describe("end to end with the real pipeline", () => {
  it("upload, run, rows, CSV, Drive upload and the processed folder", async () => {
    const { s, drive } = await pipelineServer();
    const { body, contentType } = multipart([["files", "Asha Rao.pdf", RESUME]]);
    expect((await s.post("/files", s.authed({ data: body, contentType }))).status).toBe(200);

    const res = await s.post("/run", s.authed({ json: { campaignType: "TECH", platform: "Demo", parallel: 2, driveFolderId: "folder-1", inputs: ["Asha Rao.pdf"], commit: { enabled: false } } }));
    expect(res.status, res.text()).toBe(202);
    expect(await waitFor(() => !s.engine.runActive, 20_000)).toBe(true);

    const state = (await s.get("/state", s.authed())).json();
    expect(state.lastRun, JSON.stringify(state.lastRun)).toMatchObject({ phase: "done" });
    const results = (await s.get("/results", s.authed())).json();
    expect(results.rows).toHaveLength(1);
    expect(results.rows[0]["Name"]).toBe("Asha Rao");
    expect(results.csvAvailable).toBe(true);
    const csv = (await s.get("/results.csv", s.authed())).text();
    expect(csv).toContain("Asha Rao");
    expect(csv).toContain("asha.rao@example.test");
    expect(drive.createCalls).toBe(1);
    expect(fs.existsSync(path.join(s.engine.dirs.processed, "Asha Rao.pdf"))).toBe(true);
    expect(fs.existsSync(path.join(s.inputDir, "Asha Rao.pdf"))).toBe(false);

    const types = s.engine.bus.history().map((e) => e.type);
    expect(types).toContain("progress");
    expect(types).toContain("file");
    const phases = s.engine.bus.history().filter((e) => e.type === "phase").map((e) => e.data.phase);
    expect(phases[0]).toBe("preparing");
    expect(phases.at(-1)).toBe("done");
    expect(phases.filter((p) => p === "done")).toHaveLength(1);
  });

  it("without an LLM key the run fails with the pipeline's own message", async () => {
    const s = await startServer({ runner: (ctx) => runBatch({ ...ctx, http: createFakeLlm(), drive: createFakeDrive() }) });
    fs.writeFileSync(path.join(s.inputDir, "a.pdf"), RESUME);
    await s.post("/run", s.authed({ json: { driveFolderId: "f" } }));
    expect(await waitFor(() => !s.engine.runActive, 20_000)).toBe(true);
    const last = (await s.get("/state", s.authed())).json().lastRun;
    expect(last.phase).toBe("failed");
    expect(last.detail).toContain("key is not set");
    expect(fs.existsSync(path.join(s.inputDir, "a.pdf"))).toBe(true); // a failed run moves nothing
  });

  it("cancelling a real run ends it cancelled", async () => {
    const drive = createFakeDrive();
    const llm = createFakeLlm({ delayMs: 400 });
    const s = await startServer({ runner: (ctx) => runBatch({ ...ctx, http: llm, drive }) });
    s.engine.settings.apply({ llmBaseUrl: "http://127.0.0.1:9/api/v1" }, { openrouterApiKey: "sk-or-v1-0123456789abcdef0123456789" });
    fs.writeFileSync(path.join(s.inputDir, "a.pdf"), RESUME);
    await s.post("/run", s.authed({ json: { driveFolderId: "f" } }));
    await new Promise((r) => setTimeout(r, 100));
    expect((await s.post("/cancel", s.authed({ json: {} }))).status).toBe(202);
    expect(await waitFor(() => !s.engine.runActive, 20_000)).toBe(true);
    expect((await s.get("/state", s.authed())).json().lastRun.phase).toBe("cancelled");
  });

  it("the default runner resolves @intake/core's runBatch", async () => {
    const s = await startServer({ runner: undefined });
    const runner = await s.engine.resolveRunner();
    expect(runner).toBe(runBatch);
  });
});
