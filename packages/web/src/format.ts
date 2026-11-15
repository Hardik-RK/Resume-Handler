// Small display helpers for the upload page.
import type { Campaign } from './lib/types';

export function bytes(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function duration(seconds: unknown): string {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export const PHASE_LABEL: Record<string, string> = {
  idle: 'Idle',
  preparing: 'Preparing',
  parsing: 'Reading résumés',
  screening: 'Screening',
  uploading: 'Uploading to Drive',
  done: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
  cancelling: 'Cancelling',
};

/** Percent of work done, 0-100, for the progress track. */
export const percentOf = (done: number, total: number): number => (total > 0 ? Math.min(100, (done / total) * 100) : 0);

export const listLines = (text: unknown): string[] => String(text || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

/** US dollars for run costs: four decimals under a cent, two above. */
export function money(usd: unknown): string {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return '$0';
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// ── parallel requests: the operator's own number, kept in this browser ────────────────────────────────────────
const PARALLEL_KEY = 'resume-intake.parallel';
export const PARALLEL_MIN = 1;
export const PARALLEL_MAX = 16;

export function readParallel(): number | null {
  try {
    const n = Number(window.localStorage.getItem(PARALLEL_KEY));
    return Number.isInteger(n) && n >= PARALLEL_MIN && n <= PARALLEL_MAX ? n : null;
  } catch { return null; }
}

export function writeParallel(n: number): boolean {
  try { window.localStorage.setItem(PARALLEL_KEY, String(n)); return true; } catch { return false; }
}

// ── campaigns as text: one per line, "id, name, group, type, folder" (the last three are optional) ──────────
const asId = (raw: string): number | string => (/^\d+$/.test(raw) ? Number(raw) : raw);

export function parseCampaignLines(text: string): Campaign[] {
  const seen = new Set<string>();
  const out: Campaign[] = [];
  for (const line of String(text || '').split('\n')) {
    const [id = '', name = '', group = '', type = '', driveFolderId = ''] = line.split(',').map((s) => s.trim());
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id: asId(id), name,
      ...(group ? { group } : {}), ...(type ? { type: type.toUpperCase() } : {}), ...(driveFolderId ? { driveFolderId } : {}),
    });
  }
  return out;
}

export function campaignLines(list: Array<Partial<Campaign>> | undefined): string {
  if (!Array.isArray(list)) return '';
  const cells = (c: Partial<Campaign>) => [c.id, c.name, c.group, c.type, c.driveFolderId].map((v) => (v == null ? '' : String(v)));
  return list
    .filter((c) => c && c.id != null && c.name)
    .map((c) => {
      const row = cells(c);
      while (row.length > 2 && !row[row.length - 1]) row.pop();
      return row.join(', ');
    })
    .join('\n');
}

/** Normalises the campaigns of the server settings: only entries with an id and a name, duplicates by id dropped. */
export function normaliseCampaigns(list: Array<Partial<Campaign>> | undefined): Campaign[] {
  return parseCampaignLines(campaignLines(list));
}

// ── zip listing ───────────────────────────────────────────────────────────────────────────────────────────────
export interface ZipEntry {
  name: string;
  size?: number;
}

/**
 * The file names (and sizes) inside a zip, read from its central directory only: nothing is unpacked or uploaded. Rejects when
 * the file is not a readable zip (zip64 archives are not supported here and report as unreadable).
 */
export async function listZipEntries(file: Blob): Promise<ZipEntry[]> {
  const tail = Math.min(file.size, 66000);
  const end = new DataView(await file.slice(file.size - tail).arrayBuffer());
  let at = -1;
  for (let i = end.byteLength - 22; i >= 0; i -= 1) if (end.getUint32(i, true) === 0x06054b50) { at = i; break; }
  if (at < 0) throw new Error('Not a zip file.');
  const count = end.getUint16(at + 10, true);
  const size = end.getUint32(at + 12, true);
  const offset = end.getUint32(at + 16, true);
  if (size === 0xffffffff || offset === 0xffffffff) throw new Error('This zip is too large to list.');
  const dir = new DataView(await file.slice(offset, offset + size).arrayBuffer());
  const out: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= dir.byteLength; i += 1) {
    if (dir.getUint32(p, true) !== 0x02014b50) break;
    const nameLength = dir.getUint16(p + 28, true);
    const extraLength = dir.getUint16(p + 30, true);
    const commentLength = dir.getUint16(p + 32, true);
    const name = new TextDecoder().decode(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLength));
    if (!name.endsWith('/') && !/(^|\/)(__MACOSX|\.DS_Store)/.test(name)) out.push({ name, size: dir.getUint32(p + 24, true) });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}
