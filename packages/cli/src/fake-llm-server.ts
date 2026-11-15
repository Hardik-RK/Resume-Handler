/**
 * An offline stand-in LLM endpoint for the server demo: it serves core's deterministic fake provider over HTTP on
 * 127.0.0.1, so the server (which only accepts https://openrouter.ai or a loopback URL as `llmBaseUrl`) can run with
 * no keys. Any POST path answers; the body is an OpenAI-style chat-completions request.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { HttpClient } from "./core.ts";

const MAX_BODY = 32 * 1024 * 1024; // vision requests carry page images

export const DEFAULT_FAKE_LLM_PORT = 47920;

export function createFakeLlmServer(fake: HttpClient): http.Server {
  return http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "POST only" }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      void (async () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "bad json" }));
          return;
        }
        const answer = await fake.post(req.url ?? "/", { headers: {}, body, timeoutMs: 60_000, connectTimeoutMs: 5_000 });
        res.writeHead(answer.status, { ...answer.headers, "content-type": answer.headers["content-type"] ?? "application/json" }).end(answer.text);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "fake provider failed" }));
      });
    });
  });
}

/** Listen on loopback; resolves with the base URL to use as `llmBaseUrl`. */
export function listen(server: http.Server, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`));
  });
}
