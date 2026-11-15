// Runs one step for every package, in dependency order. There is no root install on purpose:
// each package keeps its own lockfile because they pin different TypeScript / vitest majors and canvas builds.
//   node scripts/run-all.mjs <install|build|typecheck|test>
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// core first: server, cli and web-serving depend on it through file: links.
const order = ["core", "server", "mock-crm", "web", "cli"];

const steps = {
  install: (pkg) => [["npm", ["ci"]]],
  typecheck: () => [["npm", ["run", "typecheck"]]],
  test: () => [["npm", ["test"]]],
  build: (pkg) => (pkg === "web" ? [["npm", ["run", "build"]]] : []),
};

const step = process.argv[2];
if (!steps[step]) {
  console.error(`usage: node scripts/run-all.mjs <${Object.keys(steps).join("|")}>`);
  process.exit(2);
}

let failed = false;
for (const pkg of order) {
  const dir = join(root, "packages", pkg);
  if (!existsSync(dir)) continue;
  const cmds = steps[step](pkg);
  for (const [cmd, args] of cmds) {
    console.log(`\n=== ${pkg}: ${cmd} ${args.join(" ")}`);
    const r = spawnSync(cmd, args, { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
    if (r.status !== 0) {
      console.error(`FAILED: ${pkg} (${cmd} ${args.join(" ")})`);
      failed = true;
      break;
    }
  }
  if (failed) break;
}
process.exit(failed ? 1 : 0);
