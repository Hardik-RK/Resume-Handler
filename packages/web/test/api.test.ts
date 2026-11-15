import { afterEach, describe, expect, it, vi } from 'vitest';
import { lastResults, needsSignIn, setAuthToken } from '../src/lib/api';

afterEach(() => {
  setAuthToken('');
  vi.unstubAllGlobals();
});

describe('needsSignIn', () => {
  it('asks for a token only when the server wants one and none is held', () => {
    expect(needsSignIn({ auth: 'signed' })).toBe(true);
    expect(needsSignIn({ auth: 'token' })).toBe(true);
    expect(needsSignIn({ auth: 'none' })).toBe(false);
    expect(needsSignIn({})).toBe(false);
    setAuthToken('abc');
    expect(needsSignIn({ auth: 'signed' })).toBe(false);
  });
});

describe('lastResults', () => {
  it('keeps the server flag that says no CSV was written (a cancelled run has rows but no file)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ available: true, rows: [{ name: 'A' }], csvAvailable: false }), { status: 200 })));
    const res = await lastResults();
    expect(res.rows).toHaveLength(1);
    expect(res.csvAvailable).toBe(false);
  });
});
