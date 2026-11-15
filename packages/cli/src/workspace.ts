import fs from "node:fs";
import path from "node:path";

export class InputError extends Error {}

const JUNK = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

export interface RunWorkspace {
  root: string;
  dirs: { input: string; output: string; old: string; database: string; logs: string; cache: string };
  staged: string[];
}

function uniqueName(taken: Set<string>, wanted: string): string {
  let name = wanted;
  const ext = path.extname(wanted);
  const stem = wanted.slice(0, wanted.length - ext.length);
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem}-${n}${ext}`;
  taken.add(name.toLowerCase());
  return name;
}

function* walk(folder: string, prefix: string[] = []): Generator<{ file: string; rel: string[] }> {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || JUNK.has(entry.name.toLowerCase())) continue;
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) yield* walk(full, [...prefix, entry.name]);
    else if (entry.isFile()) yield { file: full, rel: [...prefix, entry.name] };
  }
}

/**
 * Create a fresh run folder under `workdir/runs/<stamp>` (the parse cache is shared at `workdir/cache` so a repeat
 * run is cheap) and copy the inputs into its flat `input` folder. The originals are never touched.
 */
export function stageInputs(inputs: string[], workdir: string, now: Date = new Date()): RunWorkspace {
  const base = path.resolve(workdir);
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const root = path.join(base, "runs", stamp);
  const dirs = {
    input: path.join(root, "input"),
    output: path.join(root, "output"),
    old: path.join(root, "old"),
    database: path.join(base, "database"),
    logs: path.join(root, "logs"),
    cache: path.join(base, "cache"),
  };
  const taken = new Set<string>();
  const sources: Array<{ file: string; name: string }> = [];
  for (const raw of inputs) {
    const resolved = path.resolve(raw);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new InputError(`Not found: ${raw}`);
    }
    if (stat.isDirectory()) {
      for (const { file, rel } of walk(resolved)) sources.push({ file, name: rel.join("_") });
    } else if (stat.isFile()) sources.push({ file: resolved, name: path.basename(resolved) });
    else throw new InputError(`Not a file or folder: ${raw}`);
  }
  if (sources.length === 0) throw new InputError("No files found in the given folder(s).");
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  const staged: string[] = [];
  for (const source of sources) {
    const name = uniqueName(taken, source.name);
    fs.copyFileSync(source.file, path.join(dirs.input, name));
    staged.push(name);
  }
  return { root, dirs, staged };
}
