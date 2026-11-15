/**
 * Folder locations for the server.
 *
 *   INTAKE_DATA_DIR    the workspace folder (default: ./.intake-data); the sub folders are created inside it
 *   INTAKE_CONFIG_DIR  where config.json and the secret vault live (default: <data>/.config, hidden from the input listing)
 */
import fs from "node:fs";
import path from "node:path";

export const SUBFOLDERS = ["input", "output", "old", "processed", "database", "logs"] as const;
export type FolderName = (typeof SUBFOLDERS)[number];
export type DataDirs = Record<FolderName, string>;

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.INTAKE_DATA_DIR;
  return path.resolve(override && override.trim() ? override : path.join(process.cwd(), ".intake-data"));
}

export function configDir(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.INTAKE_CONFIG_DIR;
  return path.resolve(override && override.trim() ? override : path.join(root, ".config"));
}

export function configFile(dir: string): string {
  return path.join(dir, "config.json");
}

/** Create (if needed) and return the working folders, keyed by name. */
export function ensureDataDirs(root: string): DataDirs {
  const base = path.resolve(root);
  const dirs = {} as DataDirs;
  for (const name of SUBFOLDERS) {
    const folder = path.join(base, name);
    fs.mkdirSync(folder, { recursive: true });
    dirs[name] = folder;
  }
  return dirs;
}
