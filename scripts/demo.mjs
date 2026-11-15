// One-command offline demo: fixture batch, mock CRM, the server in signed mode with the fake model, and the settings handshake.
// Prints the page address and a session token (paste it into the page). Ctrl-C stops everything.
//   npm run demo            (after `npm run install:all` and `npm run build`)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = (name) => join(root, "packages", name);
const fixtures = join(root, "demo-fixtures");
const crmPort = process.env.MOCK_CRM_PORT ?? "47900";
const children = [];

function run(cmd, args, cwd, env = {}) {
  return spawnSync(cmd, args, { cwd, stdio: "inherit", shell: cmd === "npm", env: { ...process.env, ...env } });
}
function start(cmd, args, cwd, env = {}) {
  const child = spawn(cmd, args, { cwd, stdio: "inherit", shell: cmd === "npm", env: { ...process.env, ...env } });
  children.push(child);
  return child;
}
async function until(url, what) {
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${what} did not start`);
}
const work = mkdtempSync(join(tmpdir(), "intake-demo-"));
function shutdown() {
  for (const c of children) c.kill();
  try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.on("SIGINT", () => { shutdown(); process.exit(0); });

if (!existsSync(join(pkg("web"), "dist", "index.html"))) {
  console.error("The web page is not built. Run `npm run build` first.");
  process.exit(1);
}
if (!existsSync(join(fixtures, "batch-backend-12.zip"))) {
  run("npm", ["run", "fixtures", "--", fixtures, "--count", "12", "--seed", "2026"], pkg("mock-crm"));
}
start(process.execPath, [join(pkg("mock-crm"), "node_modules", "tsx", "dist", "cli.mjs"), "src/server.ts"], pkg("mock-crm"), { MOCK_CRM_PORT: crmPort });
await until(`http://127.0.0.1:${crmPort}/.well-known/public-key.pem`, "mock CRM");

const serverEnv = {
  INTAKE_AUTH: "signed",
  INTAKE_PUBLIC_KEY_FILE: join(pkg("mock-crm"), "demo-data", "public_key.pem"),
  INTAKE_DATA_DIR: work,
};
start(process.execPath, ["bin/intake.mjs", "serve", "--fake", "--no-open"], pkg("cli"), serverEnv);
await new Promise((r) => setTimeout(r, 4000));
const cli = (args) => run(process.execPath, ["bin/intake.mjs", ...args], pkg("cli"));
cli(["connect", "--crm", `http://127.0.0.1:${crmPort}`]);
console.log(`\nDemo ready. Upload ${join(fixtures, "batch-backend-12.zip")} in the page above,`);
console.log(`then look at the candidates at http://127.0.0.1:${crmPort}. Ctrl-C to stop.`);
await new Promise(() => {});
