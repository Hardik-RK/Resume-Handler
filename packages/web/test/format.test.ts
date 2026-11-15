import { Blob as NodeBlob } from 'node:buffer';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  bytes, campaignLines, duration, listLines, listZipEntries, money, normaliseCampaigns, parseCampaignLines, percentOf, plural, readParallel, writeParallel,
} from '../src/format';

describe('bytes', () => {
  it('formats B, KB and MB, and nothing for non-numbers', () => {
    expect(bytes(512)).toBe('512 B');
    expect(bytes(2048)).toBe('2 KB');
    expect(bytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(bytes(0)).toBe('');
    expect(bytes('abc')).toBe('');
    expect(bytes(-4)).toBe('');
  });
});

describe('duration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(duration(0)).toBe('0s');
    expect(duration(59.6)).toBe('1m 00s');
    expect(duration(75)).toBe('1m 15s');
    expect(duration(3600 + 5 * 60)).toBe('1h 05m');
    expect(duration(-3)).toBe('0s');
    expect(duration('x')).toBe('0s');
  });
});

describe('money', () => {
  it('uses four decimals under a cent, two above, $0 for nothing', () => {
    expect(money(0)).toBe('$0');
    expect(money(0.00456)).toBe('$0.0046');
    expect(money(0.5)).toBe('$0.50');
    expect(money(12.345)).toBe('$12.35');
    expect(money('nope')).toBe('$0');
  });
});

describe('percentOf, listLines, plural', () => {
  it('computes and caps the percent', () => {
    expect(percentOf(1, 4)).toBe(25);
    expect(percentOf(9, 4)).toBe(100);
    expect(percentOf(3, 0)).toBe(0);
  });
  it('splits on newlines and commas and drops blanks', () => {
    expect(listLines('a, b\n\n c ,')).toEqual(['a', 'b', 'c']);
    expect(listLines(null)).toEqual([]);
  });
  it('pluralises', () => {
    expect(plural(1, 'row')).toBe('1 row');
    expect(plural(3, 'row')).toBe('3 rows');
  });
});

describe('parallel requests', () => {
  beforeEach(() => window.localStorage.clear());
  it('round-trips a valid number and ignores a bad one', () => {
    expect(readParallel()).toBeNull();
    expect(writeParallel(7)).toBe(true);
    expect(readParallel()).toBe(7);
    window.localStorage.setItem('resume-intake.parallel', '99');
    expect(readParallel()).toBeNull();
  });
});

describe('campaign lines', () => {
  it('parses id, name, group, type and folder, dropping duplicates and incomplete lines', () => {
    const list = parseCampaignLines('101, Backend, Acme, tech, folder1\n102, Campus\n101, Again\n, nameless\n7');
    expect(list).toEqual([
      { id: 101, name: 'Backend', group: 'Acme', type: 'TECH', driveFolderId: 'folder1' },
      { id: 102, name: 'Campus' },
    ]);
  });
  it('keeps a non-numeric id as text', () => {
    expect(parseCampaignLines('abc-1, Name')).toEqual([{ id: 'abc-1', name: 'Name' }]);
  });
  it('serialises back to the same text', () => {
    const text = '101, Backend, Acme, TECH\n102, Campus';
    expect(campaignLines(parseCampaignLines(text))).toBe(text);
    expect(campaignLines(undefined)).toBe('');
  });
  it('normalises settings entries', () => {
    expect(normaliseCampaigns([{ id: 5, name: 'X' }, { id: 5, name: 'dup' }, { name: 'no id' }])).toEqual([{ id: 5, name: 'X' }]);
  });
});

const u16 = (n: number): number[] => [n & 255, (n >> 8) & 255];
const u32 = (n: number): number[] => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];

// A minimal zip made of a central directory only: that is all listZipEntries reads.
function tinyZip(names: string[]): Blob {
  const enc = new TextEncoder();
  const central: number[] = [];
  for (const name of names) {
    const nameBytes = [...enc.encode(name)];
    const fixed = new Array<number>(46).fill(0);
    fixed.splice(0, 4, ...u32(0x02014b50));
    fixed.splice(24, 4, ...u32(1234));
    fixed.splice(28, 2, ...u16(nameBytes.length));
    central.push(...fixed, ...nameBytes);
  }
  const end = [...u32(0x06054b50), 0, 0, 0, 0, ...u16(names.length), ...u16(names.length), ...u32(central.length), ...u32(0), 0, 0];
  return new NodeBlob([new Uint8Array([...central, ...end])]) as unknown as Blob;
}

describe('listZipEntries', () => {
  it('lists the files of the central directory and skips folders and mac junk', async () => {
    const entries = await listZipEntries(tinyZip(['a.pdf', 'sub/', '__MACOSX/x', 'dir/b.pdf']));
    expect(entries.map((e) => e.name)).toEqual(['a.pdf', 'dir/b.pdf']);
    expect(entries[0].size).toBe(1234);
  });
  it('rejects something that is not a zip', async () => {
    await expect(listZipEntries(new NodeBlob(['not a zip at all, just text']) as unknown as Blob)).rejects.toThrow('Not a zip file.');
  });
});
