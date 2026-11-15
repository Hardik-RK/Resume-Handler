#!/usr/bin/env tsx
/** tsx fixtures/cli.ts <outDir> [--count 12] [--seed 2026] [--campaign backend|teacher|sales] [--no-corrupt] */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateBatch, zipBatch, type CampaignKind } from "./generate.ts";

export async function writeFixtures(outDir: string, args: { count?: number; seed?: number; campaign?: CampaignKind; corrupt?: boolean }) {
  const batch = await generateBatch(args);
  const dir = resolve(outDir);
  const resumes = join(dir, "resumes");
  mkdirSync(resumes, { recursive: true });
  for (const f of batch.files) writeFileSync(join(resumes, f.name), f.bytes);
  const zipPath = join(dir, `batch-${batch.campaign}-${batch.candidates.length}.zip`);
  writeFileSync(zipPath, zipBatch(batch));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(batch.manifest, null, 2));
  return { dir, resumes, zipPath, batch };
}

function parse(argv: string[]) {
  const out: { dir?: string; count?: number; seed?: number; campaign?: CampaignKind; corrupt?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--count") out.count = Number(argv[++i]);
    else if (a === "--seed") out.seed = Number(argv[++i]);
    else if (a === "--campaign") out.campaign = argv[++i] as CampaignKind;
    else if (a === "--no-corrupt") out.corrupt = false;
    else if (!a.startsWith("--")) out.dir = a;
    else throw new Error(`Unknown option ${a}`);
  }
  return out;
}

if (/cli\.(ts|js)$/.test(process.argv[1] ?? "")) {
  const { dir, ...rest } = parse(process.argv.slice(2));
  if (!dir) {
    console.error("usage: tsx fixtures/cli.ts <outDir> [--count N] [--seed N] [--campaign backend|teacher|sales] [--no-corrupt]");
    process.exit(2);
  }
  const result = await writeFixtures(dir, rest);
  console.log(`wrote ${result.batch.files.length} files to ${result.resumes}`);
  console.log(`zip: ${result.zipPath}`);
}
