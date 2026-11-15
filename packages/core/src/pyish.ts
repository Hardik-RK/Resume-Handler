/**
 * Python-semantics helpers (truthiness, str(), int(), float(), difflib ratio). The extraction normalisers are a
 * line-for-line port, so these keep the edge cases (None/0/""/[] handling, number parsing) identical.
 */

export type Dict = Record<string, any>;

export function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python truthiness. */
export function truthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

/** `a or b` */
export function or<A, B>(a: A, b: B): A | B {
  return truthy(a) ? a : b;
}

/** `dict.get(key, default)`: the default applies only when the key is absent (a present null stays null). */
export function getd(source: unknown, key: string, fallback?: any): any {
  if (isDict(source) && Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  return fallback;
}

export function has(source: unknown, key: string): boolean {
  return isDict(source) && Object.prototype.hasOwnProperty.call(source, key);
}

function pyRepr(value: unknown): string {
  if (typeof value === "string") return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  return pyStr(value);
}

/** Python `str(value)` for the value shapes that appear in model output. */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
    return String(value);
  }
  if (Array.isArray(value)) return "[" + value.map(pyRepr).join(", ") + "]";
  if (isDict(value)) return "{" + Object.entries(value).map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`).join(", ") + "}";
  return String(value);
}

/** Python `float(value)`; throws (like ValueError/TypeError) when it cannot convert. */
export function pyFloat(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const s = value.trim().replace(/_/g, (m, offset, whole: string) =>
      /\d/.test(whole[offset - 1] ?? "") && /\d/.test(whole[offset + 1] ?? "") ? "" : m);
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);
    if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
    if (/^[+-]?nan$/i.test(s)) return NaN;
  }
  throw new TypeError(`could not convert ${pyStr(value)} to float`);
}

/** Python `int(value)` for numbers and numeric strings; throws otherwise. */
export function pyInt(value: unknown): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("cannot convert to int");
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (/^[+-]?\d+$/.test(s)) return Number(s);
  }
  throw new TypeError(`invalid literal for int(): ${pyStr(value)}`);
}

/** `int(x or 0)` over arbitrary usage values (a bad value counts as zero). */
export function intOrZero(value: unknown): number {
  if (!truthy(value)) return 0;
  try {
    return pyInt(value);
  } catch {
    return 0;
  }
}

/** `_parse_number(value, 0.0) or 0.0` */
export function floatOrZero(value: unknown): number {
  try {
    return pyFloat(value) || 0;
  } catch {
    return 0;
  }
}

/** difflib.SequenceMatcher(None, a, b).ratio() including the autojunk heuristic for sequences of 200+ items. */
export function sequenceRatio(aStr: string, bStr: string): number {
  const a = Array.from(aStr);
  const b = Array.from(bStr);
  const la = a.length;
  const lb = b.length;
  if (la + lb === 0) return 1;
  const b2j = new Map<string, number[]>();
  b.forEach((elt, i) => {
    const list = b2j.get(elt);
    if (list) list.push(i);
    else b2j.set(elt, [i]);
  });
  if (lb >= 200) {
    const ntest = Math.floor(lb / 100) + 1;
    for (const [elt, idxs] of [...b2j]) if (idxs.length > ntest) b2j.delete(elt);
  }
  const findLongest = (alo: number, ahi: number, blo: number, bhi: number): [number, number, number] => {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      for (const j of b2j.get(a[i]!) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
    return [besti, bestj, bestsize];
  };
  let matches = 0;
  const queue: Array<[number, number, number, number]> = [[0, la, 0, lb]];
  while (queue.length > 0) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = findLongest(alo, ahi, blo, bhi);
    if (k) {
      matches += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  return (2 * matches) / (la + lb);
}

/** Python `str.casefold()` (full case folding, e.g. "ß" -> "ss"). */
export function casefold(text: string): string {
  return text.toUpperCase().toLowerCase();
}

const PY_SENTINELS: Record<string, number> = { __py_nan__: NaN, __py_inf__: Infinity, __py_ninf__: -Infinity };

/** `json.loads`: like JSON.parse but also accepts the NaN, Infinity and -Infinity literals Python allows. */
export function pyJsonLoads(text: string): any {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!/NaN|Infinity/.test(text)) throw error;
    let out = "";
    let inString = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (inString) {
        out += ch;
        if (ch === "\\") out += text[++i] ?? "";
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        out += ch;
      } else if (text.startsWith("-Infinity", i)) {
        out += '"__py_ninf__"';
        i += 8;
      } else if (text.startsWith("Infinity", i)) {
        out += '"__py_inf__"';
        i += 7;
      } else if (text.startsWith("NaN", i)) {
        out += '"__py_nan__"';
        i += 2;
      } else out += ch;
    }
    return JSON.parse(out, (_k, v) => (typeof v === "string" && v in PY_SENTINELS ? PY_SENTINELS[v] : v));
  }
}
