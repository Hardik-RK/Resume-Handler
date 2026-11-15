/** Entry point: `npm start` (tsx src/main.ts). Configuration comes from INTAKE_* environment variables (see config.ts). */
import { startServer } from "./index";
import { VERSION } from "./version";

async function main(): Promise<void> {
  const running = await startServer();
  const { engine } = running;
  engine.log.info(`Resume Intake server ${VERSION} listening on ${running.url} (auth: ${engine.auth.mode}, data: ${engine.dataRoot})`);
  process.stdout.write(`${running.url}\n`);
  const stop = () => void running.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await running.stopped;
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
