import { main } from "./main.ts";

const controller = new AbortController();
let interrupts = 0;
process.on("SIGINT", () => {
  interrupts++;
  if (interrupts > 1) process.exit(130);
  process.stderr.write("\nCancelling... (Ctrl+C again to quit now)\n");
  controller.abort();
});

const code = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  isTTY: Boolean(process.stdout.isTTY),
  cwd: process.cwd(),
  signal: controller.signal,
});
// Let open sockets close on their own (a hard exit with fetch handles pending trips a libuv assertion on Windows),
// then leave regardless if something keeps the loop alive.
process.exitCode = code;
setTimeout(() => process.exit(code), 1500).unref();
