/**
 * Safe extraction of résumé zips.
 *
 * Entries are streamed (never read whole), flattened to a single folder and stored under the
 * sha256 of their content, so two entries called CV.pdf can never overwrite each other and a hostile
 * entry name (`../../x`) never reaches the file system. Limits:
 *   - at most 500 entries per archive (archive rejected above that),
 *   - 50 MB per entry (declared and streamed),
 *   - 500 MB total uncompressed per archive (archive rejected above that),
 *   - compression ratio above 100:1 is refused per entry (declared and streamed).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import yauzl from "yauzl";
import { ZipRejected, errorName } from "./errors.js";

export const MB = 1024 * 1024;

/** `zlib.crc32` exists from Node 20.15 / 22.2; without it the CRC check is skipped. */
const hasCrc32 = typeof (zlib as { crc32?: unknown }).crc32 === "function";
export const RESUME_EXTENSIONS = [".pdf"];
export const ROSTER_EXTENSIONS = [".xlsx", ".csv"];

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 500,
  maxEntryBytes: 50 * MB,
  maxTotalBytes: 500 * MB,
  maxRatio: 100,
};

export interface ExtractedFile {
  sha256: string;
  path: string;
  /** original basename, used for Drive naming and events only */
  displayName: string;
  /** archive name the entry came from */
  source: string;
}

export interface ZipResult {
  files: ExtractedFile[];
  /** [entry name, reason] */
  skipped: Array<[string, string]>;
  /** roster files (not used here) */
  ignored: number;
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true, decodeStrings: false }, (err, zip) => {
      if (err || !zip) reject(err ?? new Error("cannot open zip"));
      else resolve(zip);
    });
  });
}

function readEntries(zip: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: yauzl.Entry[] = [];
    zip.on("entry", (entry: yauzl.Entry) => {
      entries.push(entry);
      zip.readEntry();
    });
    zip.once("end", () => resolve(entries));
    zip.once("error", reject);
    zip.readEntry();
  });
}

function openEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) reject(err ?? new Error("cannot read entry"));
      else resolve(stream);
    });
  });
}

const CP437 =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

/**
 * The entry name as text. Names are read raw (yauzl's own check rejects hostile names such as "../x" for the whole
 * archive, but here the name is only a label: files are stored under their content hash). Decoded as Python does:
 * UTF-8 when the archive says so (flag bit 11), otherwise CP437.
 */
function entryName(entry: yauzl.Entry): string {
  const raw = entry.fileName as unknown as Buffer | string;
  if (typeof raw === "string") return raw;
  if (entry.generalPurposeBitFlag & 0x800) return raw.toString("utf8");
  let out = "";
  for (const byte of raw) out += byte < 0x80 ? String.fromCharCode(byte) : CP437[byte - 0x80]!;
  return out;
}

function baseName(entryName: string): string {
  return path.posix.basename(entryName.replace(/\\/g, "/")) || entryName;
}

async function removeQuiet(file: string): Promise<void> {
  try {
    await fs.promises.unlink(file);
  } catch {
    /* already gone */
  }
}

/** Extract the résumé PDFs of one archive into destDir as `<sha256>.pdf`. Throws ZipRejected. */
export async function extractZip(
  zipPath: string,
  destDir: string,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Promise<ZipResult> {
  const dest = path.resolve(destDir);
  await fs.promises.mkdir(dest, { recursive: true });
  const result: ZipResult = { files: [], skipped: [], ignored: 0 };
  let zip: yauzl.ZipFile;
  try {
    zip = await openZip(zipPath);
  } catch {
    throw new ZipRejected("not a valid zip file");
  }
  try {
    let all: yauzl.Entry[];
    try {
      all = await readEntries(zip);
    } catch {
      throw new ZipRejected("not a valid zip file");
    }
    const infos = all.filter((e) => !entryName(e).endsWith("/"));
    if (infos.length > limits.maxEntries) throw new ZipRejected(`${infos.length} entries (limit ${limits.maxEntries})`);
    const declaredTotal = infos.reduce((sum, e) => sum + Math.max(0, e.uncompressedSize), 0);
    if (declaredTotal > limits.maxTotalBytes) throw new ZipRejected("uncompressed size over the limit");

    let runningTotal = 0;
    for (const info of infos) {
      const name = baseName(entryName(info));
      const lowered = name.toLowerCase();
      if (ROSTER_EXTENSIONS.some((ext) => lowered.endsWith(ext))) {
        result.ignored++;
        continue;
      }
      if (!RESUME_EXTENSIONS.some((ext) => lowered.endsWith(ext))) continue;
      const fileSize = info.uncompressedSize;
      const compressSize = info.compressedSize;
      if (fileSize > limits.maxEntryBytes) {
        result.skipped.push([name, "entry larger than 50 MB"]);
        continue;
      }
      if (fileSize && compressSize === 0) {
        result.skipped.push([name, "compression ratio above limit"]);
        continue;
      }
      if (compressSize && fileSize / compressSize > limits.maxRatio) {
        result.skipped.push([name, "compression ratio above limit"]);
        continue;
      }

      const partial = path.join(dest, `_partial_${crypto.randomBytes(16).toString("hex")}`);
      const digest = crypto.createHash("sha256");
      let written = 0;
      let crc = 0;
      let ok = true;
      let handle: fs.promises.FileHandle | undefined;
      try {
        const source = await openEntry(zip, info);
        handle = await fs.promises.open(partial, "w");
        for await (const raw of source) {
          const chunk = raw as Buffer;
          written += chunk.length;
          if (written > limits.maxEntryBytes) {
            result.skipped.push([name, "entry larger than 50 MB"]);
            ok = false;
            (source as unknown as { destroy?: () => void }).destroy?.();
            break;
          }
          if (compressSize && written / compressSize > limits.maxRatio) {
            result.skipped.push([name, "compression ratio above limit"]);
            ok = false;
            (source as unknown as { destroy?: () => void }).destroy?.();
            break;
          }
          if (runningTotal + written > limits.maxTotalBytes) throw new ZipRejected("uncompressed size over the limit");
          digest.update(chunk);
          if (hasCrc32) crc = zlib.crc32(chunk, crc);
          await handle.write(chunk);
        }
        // Python verifies the stored CRC when an entry is read to the end (BadZipFile on a mismatch)
        if (ok && hasCrc32 && crc !== info.crc32) throw Object.assign(new Error("Bad CRC-32"), { name: "BadZipFile" });
        await handle.close();
        handle = undefined;
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await removeQuiet(partial);
        if (error instanceof ZipRejected) throw error;
        const label = /encrypted/i.test(String((error as Error)?.message)) ? "RuntimeError" : errorName(error);
        result.skipped.push([name, `unreadable entry (${label})`]);
        continue;
      }
      if (!ok) {
        await removeQuiet(partial);
        continue;
      }

      runningTotal += written;
      const sha = digest.digest("hex");
      const final = path.join(dest, `${sha}.pdf`);
      if (fs.existsSync(final)) await removeQuiet(partial);
      else await fs.promises.rename(partial, final);
      result.files.push({ sha256: sha, path: final, displayName: name, source: path.basename(zipPath) });
    }
  } finally {
    zip.close();
  }
  return result;
}
