/**
 * File intake: name sanitising, per-run limits, a streaming multipart/form-data parser (nothing is held in memory),
 * collision-free naming and the zip listing the page shows.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

export const MB = 1024 * 1024;
export const UPLOAD_EXTENSIONS = [".pdf", ".zip", ".xlsx", ".csv"] as const;

/** File limits. Per file: 25 MB. Per run (what is in input/ when a run starts): 500 files, 500 MB. */
export interface Limits {
  uploadLimit: number;
  maxRunFiles: number;
  maxRunBytes: number;
}

export const DEFAULT_LIMITS: Limits = { uploadLimit: 25 * MB, maxRunFiles: 500, maxRunBytes: 500 * MB };

/** One multipart request may carry a whole batch, never more than a run. */
export const maxRequestBytes = (limits: Limits) => limits.maxRunBytes + MB;

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

/** One file is over the per-file limit. The message is shown to the operator. */
export class UploadTooLarge extends Error {
  constructor(limit: number) {
    super(`A file is larger than ${Math.floor(limit / MB)} MB.`);
  }
}

/** The input folder would go over the per-run limit (files or bytes). */
export class RunLimitExceeded extends Error {}

export class MultipartError extends Error {}

/** A browser-supplied file name that cannot be accepted. The message is shown to the operator. */
export class UploadNameError extends Error {}

const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;
const RESERVED_NAMES = new Set(["con", "prn", "aux", "nul", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((i) => [`com${i}`, `lpt${i}`])]);
const trimDotsAndSpaces = (s: string) => s.replace(/^[ .]+|[ .]+$/g, "");
const clip = (s: string, n: number) => Array.from(s).slice(0, n).join("");

/** A safe (stem, extension) for a browser-supplied file name. Directory parts are dropped, never trusted. */
export function sanitiseUploadName(raw: unknown): [string, string] {
  if (typeof raw !== "string" || !raw.trim()) throw new UploadNameError("The file has no name.");
  let base = raw.replace(/\\/g, "/");
  base = base.slice(base.lastIndexOf("/") + 1);
  base = base.normalize("NFC");
  base = trimDotsAndSpaces(base.replace(UNSAFE_NAME_CHARS, "_"));
  let stem: string;
  let ext: string;
  const dot = base.lastIndexOf(".");
  if (dot !== -1) {
    stem = base.slice(0, dot);
    ext = "." + base.slice(dot + 1).toLowerCase();
  } else {
    stem = base;
    ext = "";
  }
  if (!(UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) throw new UploadNameError("Only PDF, ZIP, XLSX and CSV files can be added.");
  stem = clip(trimDotsAndSpaces(stem), 120);
  if (!stem) throw new UploadNameError("The file name is empty.");
  if (RESERVED_NAMES.has(stem.toLowerCase())) stem = "_" + stem;
  return [stem, ext];
}

export function displayName(raw: string): string {
  return clip(raw.replace(UNSAFE_NAME_CHARS, "_"), 200);
}

/** Give the finished upload its final name without ever overwriting: name, name-2, name-3, ... */
export async function commitUnique(tmp: string, folder: string, stem: string, ext: string): Promise<string> {
  for (let n = 1; n < 10_000; n += 1) {
    const candidate = path.join(folder, n === 1 ? `${stem}${ext}` : `${stem}-${n}${ext}`);
    try {
      await fsp.link(tmp, candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      // Hard links unsupported here: fall back to a rename that refuses existing targets.
      if (fs.existsSync(candidate)) continue;
      await fsp.rename(tmp, candidate);
      return path.basename(candidate);
    }
    await fsp.unlink(tmp);
    return path.basename(candidate);
  }
  throw new HttpError(409, "Too many files with this name.");
}

/** Files and bytes already in input/ plus what this request adds. Shared by every file of one upload. */
export class Budget {
  constructor(public files: number, public bytes: number, private readonly limits: Limits) {}

  addFile(): void {
    if (this.files + 1 > this.limits.maxRunFiles) {
      throw new RunLimitExceeded(`The input folder can hold at most ${this.limits.maxRunFiles} files per run. Remove some files first.`);
    }
    this.files += 1;
  }

  addBytes(count: number): void {
    if (this.bytes + count > this.limits.maxRunBytes) {
      throw new RunLimitExceeded(`The input folder can hold at most ${Math.floor(this.limits.maxRunBytes / MB)} MB per run. Remove some files first.`);
    }
    this.bytes += count;
  }
}

export interface UploadResult {
  added: string[];
  rejected: Array<{ name: string; reason: string }>;
}

export interface PartSink {
  write(data: Buffer): Promise<void>;
  finish(): Promise<void>;
}

export class UploadSink implements PartSink {
  size = 0;
  closed = false;
  private constructor(
    private readonly folder: string,
    private readonly stem: string,
    private readonly ext: string,
    private readonly result: UploadResult,
    private readonly budget: Budget,
    private readonly limits: Limits,
    readonly tmp: string,
    private readonly fh: fsp.FileHandle,
  ) {}

  static async create(folder: string, stem: string, ext: string, result: UploadResult, budget: Budget, limits: Limits): Promise<UploadSink> {
    const tmp = path.join(folder, `.upload-${crypto.randomBytes(16).toString("hex")}.part`);
    const fh = await fsp.open(tmp, "wx");
    return new UploadSink(folder, stem, ext, result, budget, limits, tmp, fh);
  }

  async write(data: Buffer): Promise<void> {
    this.size += data.length;
    if (this.size > this.limits.uploadLimit) throw new UploadTooLarge(this.limits.uploadLimit);
    this.budget.addBytes(data.length);
    await this.fh.write(data);
  }

  async finish(): Promise<void> {
    await this.fh.close();
    this.closed = true;
    const name = await commitUnique(this.tmp, this.folder, this.stem, this.ext);
    this.result.added.push(name);
  }

  async abort(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      await this.fh.close().catch(() => undefined);
    }
    await fsp.unlink(this.tmp).catch(() => undefined);
  }
}

export async function undoAdded(folder: string, result: UploadResult): Promise<void> {
  for (const name of result.added) await fsp.unlink(path.join(folder, name)).catch(() => undefined);
  result.added = [];
}

function dispositionParam(disposition: string, key: string): string | null {
  const quoted = new RegExp(`;\\s*${key}="((?:[^"\\\\]|\\\\.)*)"`, "i").exec(disposition);
  if (quoted) return (quoted[1] as string).replace(/\\"/g, '"');
  const bare = new RegExp(`;\\s*${key}=([^;\\s"]+)`, "i").exec(disposition);
  return bare ? (bare[1] as string) : null;
}

export const BOUNDARY = /boundary=(?:"([^"]+)"|([^;\s]+))/i;

export interface MultipartOptions {
  chunk?: number;
  maxHeader?: number;
}

/**
 * Stream a multipart/form-data body without holding it in memory.
 *
 * `onPart(name, filename)` returns a sink with write(Buffer) and finish(), or null to discard the part.
 * `length` is the Content-Length: no more than that many bytes are read from `source`.
 */
export async function streamMultipart(
  source: AsyncIterable<Uint8Array>,
  length: number,
  boundary: Buffer,
  onPart: (name: string | null, filename: string | null) => Promise<PartSink | null>,
  options: MultipartOptions = {},
): Promise<void> {
  const chunk = options.chunk ?? 65536;
  const maxHeader = options.maxHeader ?? 16384;
  const first = Buffer.concat([Buffer.from("--"), boundary]);
  const delim = Buffer.concat([Buffer.from("\r\n--"), boundary]);
  const iterator = source[Symbol.asyncIterator]();
  let buf: Buffer = Buffer.alloc(0);
  let pending: Buffer = Buffer.alloc(0);
  let remaining = length;

  const fill = async (): Promise<boolean> => {
    if (remaining <= 0) return false;
    if (pending.length === 0) {
      const next = await iterator.next();
      if (next.done || next.value.length === 0) {
        remaining = 0;
        return false;
      }
      pending = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
    }
    const take = Math.min(chunk, remaining, pending.length);
    buf = Buffer.concat([buf, pending.subarray(0, take)]);
    pending = pending.subarray(take);
    remaining -= take;
    return true;
  };

  for (;;) {
    // preamble
    const idx = buf.indexOf(first);
    if (idx !== -1) {
      buf = buf.subarray(idx + first.length);
      break;
    }
    if (buf.length > first.length) buf = buf.subarray(buf.length - first.length);
    if (!(await fill())) throw new MultipartError("no multipart boundary found");
  }
  while (buf.length < 2) if (!(await fill())) throw new MultipartError("truncated body");
  if (buf[0] === 0x2d && buf[1] === 0x2d) return;
  if (buf[0] !== 0x0d || buf[1] !== 0x0a) throw new MultipartError("malformed body");
  buf = buf.subarray(2);

  for (;;) {
    let headerBlock: Buffer;
    for (;;) {
      // part headers
      if (buf.length >= 2 && buf[0] === 0x0d && buf[1] === 0x0a) {
        headerBlock = Buffer.alloc(0);
        buf = buf.subarray(2);
        break;
      }
      const idx = buf.indexOf("\r\n\r\n");
      if (idx !== -1) {
        headerBlock = Buffer.from(buf.subarray(0, idx));
        buf = buf.subarray(idx + 4);
        break;
      }
      if (buf.length > maxHeader) throw new MultipartError("part headers are too large");
      if (!(await fill())) throw new MultipartError("truncated part headers");
    }
    const headers: Record<string, string> = {};
    for (const line of headerBlock.toString("utf8").split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon !== -1) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const disposition = headers["content-disposition"] ?? "";
    const sink = await onPart(dispositionParam(disposition, "name"), dispositionParam(disposition, "filename"));

    for (;;) {
      // part body
      const idx = buf.indexOf(delim);
      if (idx !== -1) {
        if (sink !== null) await sink.write(Buffer.from(buf.subarray(0, idx)));
        buf = buf.subarray(idx + delim.length);
        break;
      }
      const keep = delim.length - 1;
      if (buf.length > keep) {
        if (sink !== null) await sink.write(Buffer.from(buf.subarray(0, buf.length - keep)));
        buf = buf.subarray(buf.length - keep);
      }
      if (!(await fill())) throw new MultipartError("truncated part body");
    }
    if (sink !== null) await sink.finish();

    while (buf.length < 2) if (!(await fill())) throw new MultipartError("truncated body");
    if (buf[0] === 0x2d && buf[1] === 0x2d) return;
    if (buf[0] !== 0x0d || buf[1] !== 0x0a) throw new MultipartError("malformed body");
    buf = buf.subarray(2);
  }
}

// ── folder listing ──────────────────────────────────────────────────────────────────────────────────────────────
export function inputEntries(folder: string): string[] {
  try {
    return fs.readdirSync(folder);
  } catch {
    return [];
  }
}

export function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Visible files directly inside `folder` (no dot files), optionally only the given names. */
export function visibleFiles(folder: string, names?: string[]): string[] {
  return inputEntries(folder)
    .filter((name) => !name.startsWith(".") && isFile(path.join(folder, name)) && (!names || names.length === 0 || names.includes(name)))
    .map((name) => path.join(folder, name));
}

/** Refuse a run whose inputs (all of input/, or the chosen names) are over the per-run limit. */
export function checkRunLimits(folder: string, names: string[], limits: Limits): void {
  const files = visibleFiles(folder, names);
  const total = files.reduce((sum, file) => sum + sizeOf(file), 0);
  if (files.length > limits.maxRunFiles || total > limits.maxRunBytes) {
    throw new HttpError(
      422,
      `This run has ${files.length} files (${Math.round(total / MB)} MB). A run takes at most ${limits.maxRunFiles} files ` +
        `and ${Math.floor(limits.maxRunBytes / MB)} MB: remove some files or select fewer.`,
    );
  }
}

// ── zip listing (central directory only, nothing is unpacked) ───────────────────────────────────────────────────
const CP437_HIGH =
  "\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00a2\u00a3\u00a5\u20a7\u0192" +
  "\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u2310\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510" +
  "\u2514\u2534\u252c\u251c─\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580" +
  "\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0";

function decodeCp437(bytes: Buffer): string {
  let out = "";
  for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : (CP437_HIGH[b - 0x80] as string);
  return out;
}

/** File names inside a zip, from its central directory. Throws when the file is not a readable zip. */
export function readZipNames(file: string, limit = 500): string[] {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const tailLength = Math.min(size, 65557 + 20);
    const tail = Buffer.alloc(tailLength);
    fs.readSync(fd, tail, 0, tailLength, size - tailLength);
    let eocd = -1;
    for (let i = tailLength - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) throw new Error("no end of central directory");
    let entries = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error("bad zip64 locator");
      const eocd64Offset = Number(tail.readBigUInt64LE(loc + 8));
      const rec = Buffer.alloc(56);
      fs.readSync(fd, rec, 0, 56, eocd64Offset);
      if (rec.readUInt32LE(0) !== 0x06064b50) throw new Error("bad zip64 record");
      entries = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }
    if (cdOffset + cdSize > size || cdSize > 64 * MB) throw new Error("central directory out of range");
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const names: string[] = [];
    let pos = 0;
    for (let n = 0; n < entries; n += 1) {
      if (pos + 46 > cd.length || cd.readUInt32LE(pos) !== 0x02014b50) throw new Error("bad central directory entry");
      const flags = cd.readUInt16LE(pos + 8);
      const nameLen = cd.readUInt16LE(pos + 28);
      const extraLen = cd.readUInt16LE(pos + 30);
      const commentLen = cd.readUInt16LE(pos + 32);
      if (pos + 46 + nameLen > cd.length) throw new Error("truncated name");
      const raw = cd.subarray(pos + 46, pos + 46 + nameLen);
      const name = flags & 0x800 ? raw.toString("utf8") : decodeCp437(raw);
      pos += 46 + nameLen + extraLen + commentLen;
      const base = name.slice(name.lastIndexOf("/") + 1);
      if (name.endsWith("/") || name.startsWith("__MACOSX/") || base.startsWith(".")) continue;
      names.push(name);
    }
    return names.slice(0, limit);
  } finally {
    fs.closeSync(fd);
  }
}

const zipNamesCache = new Map<string, string[] | null>();
const ZIP_NAMES_LIMIT = 500;

/** Cached by name, size and modification time, because the page asks for the folder listing every few seconds.
 * null for an unreadable zip. */
export function zipMemberNames(file: string, size: number, mtimeNs: bigint | number): string[] | null {
  const key = `${file}\u0000${size}\u0000${mtimeNs}`;
  if (zipNamesCache.has(key)) return zipNamesCache.get(key) ?? null;
  let result: string[] | null;
  try {
    result = readZipNames(file, ZIP_NAMES_LIMIT);
  } catch {
    result = null;
  }
  if (zipNamesCache.size > 256) zipNamesCache.clear();
  zipNamesCache.set(key, result);
  return result;
}

/** name, name (1), name (2), ... : never an existing path. */
export function uniqueIn(folder: string, name: string): string {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = path.join(folder, name);
  for (let n = 1; fs.existsSync(candidate); n += 1) candidate = path.join(folder, `${stem} (${n})${ext}`);
  return candidate;
}
