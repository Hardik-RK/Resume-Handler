import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, "..", "fixtures");
export const GOLDEN = path.resolve(here, "..", "golden");

function revive(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && "__float__" in (value as object)) {
    const text = String((value as { __float__: string }).__float__);
    if (text === "nan") return NaN;
    if (text === "inf") return Infinity;
    if (text === "-inf") return -Infinity;
  }
  return value;
}

/** A golden file produced by scripts/gen-golden.py from the Python reference. */
export function golden<T = any>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(GOLDEN, `${name}.json`), "utf-8"), revive) as T;
}

export function fixture(...parts: string[]): string {
  return path.join(FIXTURES, ...parts);
}

import { it } from "vitest";

/** One test per golden row; `%#` in the name is replaced by the row index. */
export function eachRow(rows: readonly any[]): (name: string, fn: (row: any, index: number) => void | Promise<void>) => void {
  return (name, fn) => {
    rows.forEach((row, index) => {
      it(name.replace(/%#|%i/, String(index)), () => fn(row, index));
    });
  };
}
