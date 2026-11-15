import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asCompleted, CancelFlag, RateGate, TaskPool } from "../src/concurrency.js";
import {
  createFakeDrive,
  createGoogleDrive,
  DriveHttpError,
  DriveUploader,
  driveErrorReason,
  loadCredentials,
  type DriveClient,
} from "../src/index.js";
import { Cancelled, DriveAuthError } from "../src/errors.js";

describe("rate gate", () => {
  class Clock {
    now = 1000;
    read = (): number => this.now;
  }
  it("halves concurrency for the cooldown, then restores (ported pytest case)", () => {
    const clock = new Clock();
    const gate = new RateGate(8, 60, clock.read);
    expect(gate.capacity()).toBe(8);
    gate.onRateLimited(1);
    expect(gate.capacity()).toBe(4);
    expect(gate.trips).toBe(1);
    clock.now += 61;
    expect(gate.capacity()).toBe(8);
  });
  it("jitters the pause within twenty percent (ported pytest case)", () => {
    const clock = new Clock();
    for (const r of [0, 0.5, 0.999]) {
      const gate = new RateGate(2, 60, clock.read, () => r);
      gate.onRateLimited(10);
      const pause = gate.pauseUntil - clock.now;
      expect(pause).toBeGreaterThanOrEqual(8);
      expect(pause).toBeLessThanOrEqual(12);
    }
  });
  it("acquire respects cancel (ported pytest case)", async () => {
    const clock = new Clock();
    const gate = new RateGate(1, 60, clock.read);
    gate.onRateLimited(3600);
    const cancel = new CancelFlag();
    cancel.set();
    await expect(gate.acquire(cancel)).rejects.toBeInstanceOf(Cancelled);
  });
  it("never lets more than `base` requests in flight and wakes waiters on release", async () => {
    const gate = new RateGate(2, 60);
    await gate.acquire();
    await gate.acquire();
    let third = false;
    const pending = gate.acquire().then(() => (third = true));
    await new Promise((r) => setTimeout(r, 80));
    expect(third).toBe(false);
    gate.release();
    await pending;
    expect(third).toBe(true);
  });
  it("capacity never drops below one", () => {
    const gate = new RateGate(1, 60);
    gate.onRateLimited(0);
    expect(gate.capacity()).toBe(1);
  });
});

describe("cancel flag, pool and as-completed", () => {
  it("combines the caller's signal with its own and wakes sleepers", async () => {
    const external = new AbortController();
    const flag = new CancelFlag(external.signal);
    expect(flag.isSet()).toBe(false);
    const sleeping = flag.wait(5000);
    setTimeout(() => external.abort(), 30);
    expect(await sleeping).toBe(true);
    expect(flag.isSet()).toBe(true);
    await expect(flag.sleep(1)).rejects.toBeInstanceOf(Cancelled);
    const own = new CancelFlag();
    expect(await own.wait(10)).toBe(false);
    own.set();
    expect(own.isSet()).toBe(true);
  });
  it("runs at most N tasks at once, starts them in order, and can cancel unstarted ones", async () => {
    const pool = new TaskPool(2);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const handles = [0, 1, 2, 3, 4].map((n) =>
      pool.submit(async () => {
        order.push(n);
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 30));
        running--;
        return n;
      }),
    );
    expect(handles[4]!.cancel()).toBe(true); // not started yet
    expect(handles[0]!.cancel()).toBe(false); // already running
    await pool.shutdown();
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3]);
    expect(handles[4]!.result).toEqual({ cancelled: true });
    expect(handles[3]!.result).toEqual({ cancelled: false, ok: true, value: 3 });
  });
  it("captures failures without rejecting and yields in completion order", async () => {
    const pool = new TaskPool(3);
    const delays = [60, 10, 30];
    const handles = delays.map((ms, i) =>
      pool.submit(async () => {
        await new Promise((r) => setTimeout(r, ms));
        if (i === 2) throw new Error("boom");
        return i;
      }),
    );
    const seen: number[] = [];
    for await (const h of asCompleted(handles)) seen.push(handles.indexOf(h));
    expect(seen).toEqual([1, 2, 0]);
    const failed = handles[2]!.result!;
    expect(failed.cancelled === false && failed.ok === false && (failed.error as Error).message).toBe("boom");
  });
});

describe("Drive credentials (ported pytest cases)", () => {
  it("an empty token stops with 'Google token invalid'", async () => {
    await expect(loadCredentials("{}")).rejects.toThrow("Google token invalid");
    await expect(loadCredentials("")).rejects.toThrow("not valid JSON");
    await expect(loadCredentials("[1]")).rejects.toThrow("not valid JSON");
  });
  it("a token without a refresh token is invalid without touching the network", async () => {
    let calls = 0;
    const fetchStub = async (): Promise<Response> => {
      calls++;
      return new Response("{}");
    };
    await expect(loadCredentials(JSON.stringify({ client_id: "c", client_secret: "s" }), { fetch: fetchStub })).rejects.toThrow("no refresh token");
    await expect(loadCredentials(JSON.stringify({ refresh_token: "r" }), { fetch: fetchStub })).rejects.toThrow("incomplete");
    expect(calls).toBe(0);
  });
  it("a refresh failure is reported as 'Google token invalid' (unreachable token endpoint)", async () => {
    const token = JSON.stringify({ refresh_token: "r", client_id: "c", client_secret: "s", token_uri: "http://127.0.0.1:9/token" });
    await expect(loadCredentials(token)).rejects.toBeInstanceOf(DriveAuthError);
    await expect(loadCredentials(token)).rejects.toThrow("refresh failed; sign in again");
  });
  it("a still-valid access token is used as is; an expired one is refreshed once", async () => {
    const base = { refresh_token: "r", client_id: "c", client_secret: "s", token_uri: "http://t.test/token" };
    let refreshes = 0;
    const fetchStub = async (_url: string, init?: RequestInit): Promise<Response> => {
      refreshes++;
      expect(String(init?.body)).toContain("grant_type=refresh_token");
      return new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }));
    };
    const now = Date.parse("2030-01-01T00:00:00Z");
    const valid = await loadCredentials({ ...base, token: "live", expiry: "2030-01-01T01:00:00Z" }, { fetch: fetchStub, now: () => now });
    expect(await valid.accessToken()).toBe("live");
    expect(refreshes).toBe(0);
    const expired = await loadCredentials({ ...base, token: "old", expiry: "2029-12-31T00:00:00Z" }, { fetch: fetchStub, now: () => now });
    expect(await expired.accessToken()).toBe("fresh");
    expect(await expired.accessToken()).toBe("fresh");
    expect(refreshes).toBe(1);
  });
});

describe("Drive uploader", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "intake-drive-"));
    file = path.join(dir, "cv.pdf");
    fs.writeFileSync(file, "%PDF fake");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const uploader = (client: DriveClient, extra: Partial<ConstructorParameters<typeof DriveUploader>[0]> = {}): DriveUploader =>
    new DriveUploader({ client, cancel: new CancelFlag(), runId: "run-20260101T000000Z-abcdef12", backoffBase: 0.01, ...extra });

  it("creates private files tagged with their content hash, in one batched listing", async () => {
    const drive = createFakeDrive();
    const up = uploader(drive);
    const a = await up.upload(file, "sha-a", "CV.pdf", "folder-1");
    const b = await up.upload(file, "sha-b", "Other.pdf", "folder-1");
    expect(a.created && b.created).toBe(true);
    expect(drive.listCalls).toBe(1);
    expect(drive.uploaded().map((f) => f.appProperties["contentSha256"])).toEqual(["sha-a", "sha-b"]);
    expect(drive.uploaded()[0]!.appProperties["uploaderRun"]).toBe("run-20260101T000000Z-abcdef12");
    expect(a.url).toMatch(/^https:\/\/drive\.google\.com\/file\/d\/file1\/view$/);
    expect("permissions" in drive).toBe(false); // no sharing call exists at all
  });
  it("reuses a file with the same hash, even from an earlier run", async () => {
    const drive = createFakeDrive();
    expect((await uploader(drive).upload(file, "sha-a", "CV.pdf", "f")).created).toBe(true);
    const second = uploader(drive);
    const again = await second.upload(file, "sha-a", "renamed.pdf", "f");
    expect(again.created).toBe(false);
    expect(again.name).toBe("CV.pdf");
    expect(drive.createCalls).toBe(1);
    expect(second.stats).toEqual({ created: 0, reused: 1, retries: 0 });
  });
  it("a generic name used by two candidates gets a per-run suffix (never reuses another candidate's file)", async () => {
    const drive = createFakeDrive();
    const up = uploader(drive);
    const names = [];
    for (const sha of ["s1", "s2", "s3"]) names.push((await up.upload(file, sha, "CV.pdf", "f")).name);
    expect(names).toEqual(["CV.pdf", "CV_abcdef.pdf", "CV_abcdef_2.pdf"]);
    expect((await up.upload(file, "s4", "noext", "f")).name).toBe("noext");
    expect((await up.upload(file, "s5", "noext", "f")).name).toBe("noext_abcdef");
  });
  it("concurrent uploads of one name stay distinct", async () => {
    const drive = createFakeDrive();
    const up = uploader(drive);
    const results = await Promise.all(["a", "b", "c", "d"].map((sha) => up.upload(file, sha, "CV.pdf", "f")));
    expect(new Set(results.map((r) => r.name)).size).toBe(4);
    expect(drive.listCalls).toBe(1);
  });
  it("retries 403/429/5xx with backoff, gives up after the attempts, and does not retry other errors", async () => {
    const drive = createFakeDrive();
    drive.failCreates.push(503, 429);
    const up = uploader(drive);
    expect((await up.upload(file, "s", "CV.pdf", "f")).created).toBe(true);
    expect(up.stats.retries).toBe(2);

    const failing = createFakeDrive();
    failing.failCreates.push(500, 500, 500, 500);
    const err = await uploader(failing).upload(file, "s", "CV.pdf", "f").catch((e) => e);
    expect(err).toBeInstanceOf(DriveHttpError);
    expect(driveErrorReason(err)).toBe("Drive error 500");

    const fatal = createFakeDrive();
    fatal.failCreates.push(404, 200);
    const up2 = uploader(fatal);
    await expect(up2.upload(file, "s", "CV.pdf", "f")).rejects.toMatchObject({ status: 404 });
    expect(up2.stats.retries).toBe(0);
  });
  it("cancel stops an upload before it starts and interrupts a backoff", async () => {
    const cancel = new CancelFlag();
    const drive = createFakeDrive();
    cancel.set();
    await expect(uploader(drive, { cancel }).upload(file, "s", "CV.pdf", "f")).rejects.toBeInstanceOf(Cancelled);
    expect(drive.listCalls).toBe(0);

    const cancel2 = new CancelFlag();
    const slow = createFakeDrive();
    slow.failCreates.push(503);
    const up = uploader(slow, { cancel: cancel2, backoffBase: 30 });
    const pending = up.upload(file, "s", "CV.pdf", "f");
    setTimeout(() => cancel2.set(), 50);
    await expect(pending).rejects.toBeInstanceOf(Cancelled);
  });
  it("reads every page of a folder listing", async () => {
    const pages: Record<string, { files: any[]; nextPageToken?: string }> = {
      "": { files: [{ id: "1", name: "a.pdf", appProperties: { contentSha256: "h1" } }], nextPageToken: "p2" },
      p2: { files: [{ id: "2", name: "b.pdf", appProperties: { contentSha256: "h2" } }] },
    };
    const client: DriveClient = {
      listFolder: async (_f, token) => pages[token ?? ""]!,
      createFile: async () => {
        throw new Error("must not create");
      },
    };
    const up = uploader(client);
    expect((await up.upload(file, "h2", "x.pdf", "f")).id).toBe("2");
  });
  it("drive error reasons carry no personal data", () => {
    expect(driveErrorReason(new DriveHttpError(403))).toBe("Drive error 403");
    expect(driveErrorReason(new TypeError("a@b.com leaked?"))).toBe("TypeError");
  });
  it("accepts a client factory", async () => {
    let made = 0;
    const drive = createFakeDrive();
    const up = uploader((() => (made++, drive)) as unknown as DriveClient);
    await up.upload(file, "s", "CV.pdf", "f");
    await up.upload(file, "t", "CV2.pdf", "f");
    expect(made).toBe(1);
  });
});

describe("Google Drive REST client", () => {
  it("lists with an escaped query and uploads with the resumable protocol", async () => {
    const requests: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
    const fetchStub = async (url: string, init?: RequestInit): Promise<Response> => {
      requests.push({ url, method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, body: init?.body });
      if (url.includes("/files?q=")) return new Response(JSON.stringify({ files: [{ id: "x" }] }));
      if (url.includes("uploadType=resumable")) return new Response("", { headers: { location: "https://upload.test/session1" } });
      return new Response(JSON.stringify({ id: "new1", name: "CV.pdf", webViewLink: "https://drive.google.com/file/d/new1/view" }));
    };
    const client = createGoogleDrive({ accessToken: async () => "tok" }, { fetch: fetchStub });
    const listing = await client.listFolder("fo'lder\\1", "next");
    expect(listing.files).toHaveLength(1);
    const listUrl = new URL(requests[0]!.url);
    expect(listUrl.searchParams.get("q")).toBe("'fo\\'lder\\\\1' in parents and trashed=false");
    expect(listUrl.searchParams.get("pageToken")).toBe("next");
    expect(listUrl.searchParams.get("pageSize")).toBe("1000");
    expect(requests[0]!.headers["Authorization"]).toBe("Bearer tok");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intake-rest-"));
    try {
      const file = path.join(dir, "cv.pdf");
      fs.writeFileSync(file, "%PDF bytes");
      const created = await client.createFile({ name: "CV.pdf", parents: ["f"], appProperties: { contentSha256: "h" }, path: file, mimeType: "application/pdf" });
      expect(created.id).toBe("new1");
      const [init, put] = requests.slice(1);
      expect(JSON.parse(String(init!.body))).toEqual({ name: "CV.pdf", parents: ["f"], appProperties: { contentSha256: "h" } });
      expect(init!.headers["X-Upload-Content-Length"]).toBe("10");
      expect(put!.url).toBe("https://upload.test/session1");
      expect(put!.method).toBe("PUT");
      expect(requests.some((r) => r.url.includes("/permissions"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("turns an HTTP failure into an error that carries the status", async () => {
    const client = createGoogleDrive({ accessToken: async () => "t" }, { fetch: async () => new Response("no", { status: 403 }) });
    await expect(client.listFolder("f")).rejects.toMatchObject({ status: 403 });
  });
});
