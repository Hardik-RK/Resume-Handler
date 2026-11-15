import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "./sink.ts";

/** The `app` value this server's GET /hello reports; other programs on the same ports are ignored. */
export const APP_ID = "resume-intake";

export const DEFAULT_PORTS = Array.from({ length: 10 }, (_, i) => 47831 + i);

const here = path.dirname(fileURLToPath(import.meta.url));
/** The server package's entry, next to this package in the repo. */
export const SERVER_ENTRY = path.resolve(here, "..", "..", "server", "src", "main.ts");

/** The first port in `ports` that answers GET /hello like the server does, as a base URL; null when none does. */
export async function findServer(ports: number[], fetchImpl: FetchLike = fetch): Promise<string | null> {
  for (const port of ports) {
    const base = `http://127.0.0.1:${port}`;
    try {
      const response = await fetchImpl(`${base}/hello`, { signal: AbortSignal.timeout(800) });
      if (response.ok) {
        const hello = (await response.json().catch(() => null)) as { app?: unknown } | null;
        if (hello?.app === APP_ID) return base;
      }
    } catch {
      // nothing listening here
    }
  }
  return null;
}

export async function waitForServer(ports: number[], child: ChildProcess | null, timeoutMs = 45_000, fetchImpl: FetchLike = fetch): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  child?.once("exit", () => {
    exited = true;
  });
  while (Date.now() < deadline && !exited) {
    const found = await findServer(ports, fetchImpl);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
}

/** Start the server package as a child process (tsx runs its TypeScript source). Output is inherited. */
export function startServer(cwd: string, env: NodeJS.ProcessEnv, port: number | null): ChildProcess {
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  return spawn(process.execPath, [tsxCli, SERVER_ENTRY], {
    cwd,
    env: { ...env, ...(port !== null ? { INTAKE_PORT: String(port) } : {}) },
    stdio: "inherit",
  });
}

export function portsFor(port: number | null): number[] {
  return port !== null ? [port] : DEFAULT_PORTS;
}

export interface InProcessServer {
  url: string;
  stopped: Promise<void>;
  stop(): Promise<void>;
}

/**
 * Start the server inside this process with the offline model and an in-memory Drive, so the web UI runs with no keys.
 * Env (INTAKE_AUTH, INTAKE_PUBLIC_KEY_FILE, INTAKE_DATA_DIR, ...) is read by the server as usual.
 */
export async function startFakeServer(env: NodeJS.ProcessEnv, port: number | null): Promise<InProcessServer> {
  const { startServer } = await import("@intake/server");
  const { runBatch, createFakeLlm, createFakeDrive } = await import("./core.ts");
  const http = createFakeLlm();
  const drive = createFakeDrive();
  const running = await startServer(
    {
      ...(port !== null ? { ports: [port] } : {}),
      engine: {
        runner: (ctx) =>
          runBatch({ ...ctx, http, drive, options: { ...ctx.options, driveFolderId: ctx.options.driveFolderId || "fake-folder" } }),
      },
    },
    env,
  );
  // The page treats a missing model key as "not set up"; the fake model needs none, so store a placeholder.
  try {
    running.engine.settings.apply({}, { openrouterApiKey: "offline-demo-key" });
  } catch {
    // an existing vault problem is reported by the server itself
  }
  return running;
}
