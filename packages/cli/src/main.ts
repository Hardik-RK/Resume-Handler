import { render } from "ink";
import { createElement } from "react";
import { EXIT, USAGE, UsageError, parseCli, type AppArgs, type ConnectArgs, type FakeLlmArgs, type ServeArgs } from "./args.ts";
import { connect } from "./connect.ts";
import { createFakeLlmServer, listen } from "./fake-llm-server.ts";
import { CommitError } from "./sink.ts";
import { openAppWindow, openInBrowser } from "./browser.ts";
import { runCommand, type CliIO } from "./runner.ts";
import { findServer, portsFor, startFakeServer, startServer, waitForServer } from "./serve.ts";
import { App } from "./ui.tsx";
import type { Store } from "./progress.ts";

const VERSION = "0.1.0";

async function startLiveUi(store: Store, title: string): Promise<() => Promise<void>> {
  const instance = render(createElement(App, { store, title }));
  return async () => {
    // let the last state paint, then leave the final frame on screen
    await new Promise((resolve) => setTimeout(resolve, 60));
    instance.unmount();
    await instance.waitUntilExit();
  };
}

async function serveCommand(args: ServeArgs, io: CliIO): Promise<number> {
  const existing = await findServer(portsFor(args.port));
  if (existing) {
    io.stdout.write(`A server is already running at ${existing}\n`);
    if (args.open) openInBrowser(existing);
    return EXIT.ok;
  }
  if (args.fake) {
    const running = await startFakeServer(io.env, args.port);
    io.stdout.write(`Server ready at ${running.url} (offline model, in-memory Drive)
`);
    if (args.open) openInBrowser(running.url);
    io.signal?.addEventListener("abort", () => void running.stop(), { once: true });
    await running.stopped;
    return EXIT.ok;
  }
  const child = startServer(io.cwd, io.env, args.port);
  const stop = () => child.kill();
  io.signal?.addEventListener("abort", stop, { once: true });
  const url = await waitForServer(portsFor(args.port), child);
  if (!url) {
    stop();
    io.stderr.write("intake: the server did not come up. Check its output above.\n");
    return EXIT.failed;
  }
  io.stdout.write(`Server ready at ${url}\n`);
  if (args.open) openInBrowser(url);
  return new Promise<number>((resolve) => child.once("exit", (code) => resolve(io.signal?.aborted ? EXIT.ok : (code ?? EXIT.failed))));
}

async function appCommand(args: AppArgs, io: CliIO): Promise<number> {
  let url = args.url;
  let child: ReturnType<typeof startServer> | null = null;
  let stopped: Promise<void> | null = null;
  if (!url) {
    url = await findServer(portsFor(args.port));
    if (!url && args.serve && args.fake) {
      const running = await startFakeServer(io.env, args.port);
      io.signal?.addEventListener("abort", () => void running.stop(), { once: true });
      url = running.url;
      stopped = running.stopped;
    } else if (!url && args.serve) {
      child = startServer(io.cwd, io.env, args.port);
      io.signal?.addEventListener("abort", () => child?.kill(), { once: true });
      url = await waitForServer(portsFor(args.port), child);
    }
    if (!url) {
      io.stderr.write("intake: no server found. Run \"intake serve\" first, pass --url, or use \"intake app --serve\".\n");
      child?.kill();
      return EXIT.failed;
    }
  }
  try {
    const { browser } = openAppWindow(url, process.platform, io.env);
    io.stdout.write(`Opened ${url} in an app window (${browser}).\n`);
  } catch (err) {
    io.stderr.write(`intake: ${err instanceof Error ? err.message : String(err)}\n`);
    child?.kill();
    return EXIT.failed;
  }
  if (stopped) {
    io.stdout.write("The server keeps running here; press Ctrl+C to stop it.\n");
    await stopped;
    return EXIT.ok;
  }
  if (child) {
    io.stdout.write("The server keeps running here; press Ctrl+C to stop it.\n");
    return new Promise<number>((resolve) => child?.once("exit", (code) => resolve(io.signal?.aborted ? EXIT.ok : (code ?? EXIT.failed))));
  }
  return EXIT.ok;
}

async function fakeLlmCommand(args: FakeLlmArgs, io: CliIO): Promise<number> {
  const { createFakeLlm } = await import("./core.ts");
  const server = createFakeLlmServer(createFakeLlm());
  const base = await listen(server, args.port);
  io.stdout.write(`Offline fake LLM listening. Use as llmBaseUrl: ${base}\n`);
  return new Promise<number>((resolve) => {
    io.signal?.addEventListener("abort", () => server.close(() => resolve(EXIT.ok)), { once: true });
  });
}

async function connectCommand(args: ConnectArgs, io: CliIO): Promise<number> {
  const server = args.server ?? (await findServer(portsFor(null)));
  if (!server) {
    io.stderr.write('intake: no server found. Start one with "intake serve" or pass --server.\n');
    return EXIT.failed;
  }
  try {
    const result = await connect({ server, crm: args.crm, llm: args.llm, ...(io.fetch ? { fetch: io.fetch } : {}) });
    io.stdout.write(`Connected ${server} to ${args.crm} (${result.campaigns} campaigns).\n`);
    io.stdout.write(`Session token (valid 24 h; paste it into the page if it asks to sign in):\n${result.token}\n`);
    return EXIT.ok;
  } catch (err) {
    if (err instanceof CommitError) {
      io.stderr.write(`intake: ${err.message}\n`);
      return EXIT.failed;
    }
    throw err;
  }
}

/** Entry point with injectable IO, so tests drive it without a terminal. Returns the process exit code. */
export async function main(argv: string[], io: CliIO): Promise<number> {
  let parsed;
  try {
    parsed = parseCli(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr.write(`intake: ${err.message}\n`);
      return EXIT.usage;
    }
    throw err;
  }
  switch (parsed.command) {
    case "help":
      io.stdout.write(USAGE);
      return EXIT.ok;
    case "version":
      io.stdout.write(`${VERSION}\n`);
      return EXIT.ok;
    case "run":
      return runCommand(parsed, { startLiveUi, ...io });
    case "serve":
      return serveCommand(parsed, io);
    case "app":
      return appCommand(parsed, io);
    case "fake-llm":
      return fakeLlmCommand(parsed, io);
    case "connect":
      return connectCommand(parsed, io);
  }
}
