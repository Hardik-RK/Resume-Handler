/** File intake: name sanitising (golden), HTTP upload, limits, delete, zip listing and the streaming multipart parser. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { MultipartError, maxRequestBytes, readZipNames, sanitiseUploadName, streamMultipart, UploadNameError, type PartSink } from "../src/uploads";
import fixtures from "./golden/fixtures.json";
import { multipart, ORIGIN, PDF, request, startServer, tempDir, type Running } from "./helpers";

const upload = (s: Running, parts: Parameters<typeof multipart>[0], options = {}) => {
  const { body, contentType } = multipart(parts);
  return s.post("/files", s.authed({ data: body, contentType, ...options }));
};
const listing = (s: Running) => fs.readdirSync(s.inputDir).sort();

describe("golden: sanitiseUploadName", () => {
  for (const c of fixtures.uploadNames as Array<{ input: unknown; stem?: string; ext?: string; error?: string }>) {
    it(JSON.stringify(c.input)?.slice(0, 40) ?? "undefined", () => {
      if (c.error !== undefined) {
        expect(() => sanitiseUploadName(c.input)).toThrow(UploadNameError);
        try {
          sanitiseUploadName(c.input);
        } catch (err) {
          expect((err as Error).message).toBe(c.error);
        }
      } else {
        expect(sanitiseUploadName(c.input)).toEqual([c.stem, c.ext]);
      }
    });
  }

  it("sanitised names never contain path parts", () => {
    for (const raw of ["../x.pdf", "..\\x.pdf", "/etc/x.pdf", "C:/x.pdf", "a/../../b.csv"]) {
      const [stem] = sanitiseUploadName(raw);
      expect(stem).not.toMatch(/[/\\:]|\.\./);
    }
  });
});

describe("HTTP intake", () => {
  it("stores a PDF in input and lists it", async () => {
    const s = await startServer();
    const res = await upload(s, [["files", "Asha Rao.pdf", PDF]]);
    expect(res.status).toBe(200);
    expect(res.json().added).toEqual(["Asha Rao.pdf"]);
    expect(fs.readFileSync(path.join(s.inputDir, "Asha Rao.pdf")).equals(PDF)).toBe(true);
    const listed = (await s.get("/files", s.authed())).json().files;
    expect(listed.map((f: any) => f.name)).toEqual(["Asha Rao.pdf"]);
    expect(listed[0].size).toBe(PDF.length);
    expect(listed[0].modified).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);
  });

  it("an input folder that was removed while idle is made again (it was an internal error)", async () => {
    const s = await startServer();
    fs.rmSync(s.inputDir, { recursive: true, force: true });
    const res = await upload(s, [["files", "Asha Rao.pdf", PDF]]);
    expect(res.status).toBe(200);
    expect(listing(s)).toEqual(["Asha Rao.pdf"]);
  });

  it("duplicates get numeric suffixes and never overwrite", async () => {
    const s = await startServer();
    await upload(s, [["files", "cv.pdf", "first"]]);
    await upload(s, [["files", "cv.pdf", "second"]]);
    const res = await upload(s, [["files", "cv.pdf", "third"]]);
    expect(res.json().added).toEqual(["cv-3.pdf"]);
    expect(fs.readFileSync(path.join(s.inputDir, "cv.pdf"), "utf8")).toBe("first");
    expect(fs.readFileSync(path.join(s.inputDir, "cv-2.pdf"), "utf8")).toBe("second");
    expect(fs.readFileSync(path.join(s.inputDir, "cv-3.pdf"), "utf8")).toBe("third");
  });

  it("many uploads of one name stay unique", async () => {
    const s = await startServer();
    for (let i = 0; i < 5; i += 1) await upload(s, [["files", "dup.pdf", PDF]]);
    expect(listing(s)).toEqual(["dup-2.pdf", "dup-3.pdf", "dup-4.pdf", "dup-5.pdf", "dup.pdf"]);
  });

  it("two files uploaded at the same time under one name both survive", async () => {
    const s = await startServer();
    const results = await Promise.all(Array.from({ length: 6 }, () => upload(s, [["files", "same.pdf", PDF]])));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.json().added[0])).size).toBe(6);
    expect(listing(s)).toHaveLength(6);
  });

  it("a traversal name is sanitised and lands inside input", async () => {
    const s = await startServer();
    const res = await upload(s, [["files", "../../escape.pdf", PDF]]);
    expect(res.status).toBe(200);
    expect(res.json().added).toEqual(["escape.pdf"]);
    expect(fs.existsSync(path.join(s.root, "escape.pdf"))).toBe(false);
    expect(fs.existsSync(path.join(s.root, "Data", "escape.pdf"))).toBe(false);
  });

  it("wrong extensions are rejected and nothing is written", async () => {
    const s = await startServer();
    const res = await upload(s, [["files", "payload.exe", "MZ...."]]);
    expect(res.status).toBe(400);
    expect(res.json().rejected[0].name).toBe("payload.exe");
    expect(res.json().error).toBe("No file could be added.");
    expect(listing(s)).toEqual([]);
  });

  it("a mixed batch keeps the good files", async () => {
    const s = await startServer();
    const res = await upload(s, [["files", "good.pdf", PDF], ["files", "bad.docx", "x"], ["files", "list.csv", "a,b\n"]]);
    expect(res.status).toBe(200);
    expect(res.json().added.sort()).toEqual(["good.pdf", "list.csv"]);
    expect(res.json().rejected.map((r: any) => r.name)).toEqual(["bad.docx"]);
  });

  it("non-file form fields are ignored; an empty form is 400", async () => {
    const s = await startServer();
    const res = await upload(s, [["note", null, "hello"], ["files", "a.pdf", PDF]]);
    expect(res.json().added).toEqual(["a.pdf"]);
    expect((await upload(s, [["note", null, "only a field"]])).json().error).toBe("No files in the upload.");
  });

  it("utf-8 file names survive", async () => {
    const s = await startServer();
    const res = await upload(s, [["files", "résumé-ß 日本.pdf", PDF]]);
    expect(res.json().added).toEqual(["résumé-ß 日本.pdf"]);
  });

  it("hidden temp files are not listed", async () => {
    const s = await startServer();
    fs.writeFileSync(path.join(s.inputDir, ".upload-leftover.part"), "partial");
    await upload(s, [["files", "a.pdf", PDF]]);
    expect((await s.get("/files", s.authed())).json().files.map((f: any) => f.name)).toEqual(["a.pdf"]);
  });

  it("non-multipart upload is 415", async () => {
    const s = await startServer();
    expect((await s.post("/files", s.authed({ json: { name: "x" } }))).status).toBe(415);
  });

  it("an upload needs credentials", async () => {
    const s = await startServer();
    const { body, contentType } = multipart([["files", "a.pdf", PDF]]);
    expect((await request(s.port, "POST", "/files", { data: body, contentType })).status).toBe(401);
    expect(listing(s)).toEqual([]);
  });

  it("a truncated multipart body is 400 and leaves nothing", async () => {
    const s = await startServer();
    const { body, contentType } = multipart([["files", "a.pdf", Buffer.alloc(500, "z")]]);
    const res = await s.post("/files", s.authed({ data: body.subarray(0, 300), contentType }));
    expect(res.status).toBe(400);
    expect(res.json().error).toContain("could not be read");
    expect(listing(s)).toEqual([]);
  });
});

describe("limits", () => {
  it("a file over the per-file limit is 413 with a clear message and leaves no partial file", async () => {
    const s = await startServer({ limits: { uploadLimit: 1000 } });
    const res = await upload(s, [["files", "big.pdf", Buffer.alloc(5000, "x")]]);
    expect(res.status).toBe(413);
    expect(res.json().error).toContain("larger than");
    expect(listing(s)).toEqual([]);
  });

  it("the default per-file limit is 25 MB", async () => {
    const s = await startServer();
    expect(s.engine.limits.uploadLimit).toBe(25 * 1024 * 1024);
    expect(s.engine.limits.maxRunFiles).toBe(500);
    expect(s.engine.limits.maxRunBytes).toBe(500 * 1024 * 1024);
  });

  it("a refused multi-file upload leaves none of its files", async () => {
    const s = await startServer({ limits: { uploadLimit: 1000 } });
    const res = await upload(s, [["files", "ok.pdf", PDF.subarray(0, 100)], ["files", "big.pdf", Buffer.alloc(5000, "x")]]);
    expect(res.status).toBe(413);
    expect(listing(s)).toEqual([]);
  });

  it("the per-run file count is refused and the upload rolled back", async () => {
    const s = await startServer({ limits: { maxRunFiles: 2 } });
    expect((await upload(s, [["files", "one.pdf", PDF]])).status).toBe(200);
    const res = await upload(s, [["files", "two.pdf", PDF], ["files", "three.pdf", PDF]]);
    expect(res.status).toBe(413);
    expect(res.json().error).toContain("at most 2 files");
    expect(listing(s)).toEqual(["one.pdf"]);
  });

  it("the per-run byte total is refused and the upload rolled back", async () => {
    const s = await startServer({ limits: { maxRunBytes: 3000 } });
    expect((await upload(s, [["files", "a.pdf", Buffer.concat([Buffer.from("%PDF"), Buffer.alloc(1500, "a")])]])).status).toBe(200);
    const res = await upload(s, [["files", "b.pdf", Buffer.alloc(1500, "b")], ["files", "c.pdf", Buffer.alloc(1500, "c")]]);
    expect(res.status).toBe(413);
    expect(res.json().error).toContain("per run");
    expect(listing(s)).toEqual(["a.pdf"]);
  });

  it("a request over the upload limit is refused before reading", async () => {
    const s = await startServer();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: s.port,
          method: "POST",
          path: "/files",
          headers: {
            Origin: ORIGIN,
            Authorization: `Bearer ${s.token}`,
            "Content-Type": "multipart/form-data; boundary=zz",
            "Content-Length": String(maxRequestBytes(s.engine.limits) + 5 * 1024 * 1024),
          },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
        },
      );
      req.on("error", reject);
      req.flushHeaders();
    });
    expect(status).toBe(413);
  });

  it("a JSON body over 2 MB is 413", async () => {
    const s = await startServer();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: s.port, method: "POST", path: "/settings", headers: { Origin: ORIGIN, Authorization: `Bearer ${s.token}`, "Content-Type": "application/json", "Content-Length": String(3 * 1024 * 1024) } },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
        },
      );
      req.on("error", reject);
      req.flushHeaders();
    });
    expect(status).toBe(413);
  });

  it("a chunked body (no Content-Length) is 411", async () => {
    const s = await startServer();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: s.port, method: "POST", path: "/settings", headers: { Origin: ORIGIN, Authorization: `Bearer ${s.token}`, "Transfer-Encoding": "chunked" } }, (res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
      });
      req.on("error", reject);
      req.end("{}");
    });
    expect(status).toBe(411);
  });

  it("a run over the file limit is 422 and does not start", async () => {
    const s = await startServer({ limits: { maxRunFiles: 1 } });
    fs.writeFileSync(path.join(s.inputDir, "a.pdf"), PDF);
    fs.writeFileSync(path.join(s.inputDir, "b.pdf"), PDF);
    const res = await s.post("/run", s.authed({ json: {} }));
    expect(res.status).toBe(422);
    expect(res.json().error).toContain("at most 1 files");
    expect(s.engine.runActive).toBe(false);
  });

  it("a run over the byte limit is 422", async () => {
    const s = await startServer({ limits: { maxRunBytes: 500 } });
    fs.writeFileSync(path.join(s.inputDir, "a.pdf"), Buffer.alloc(600, "a"));
    const res = await s.post("/run", s.authed({ json: {} }));
    expect(res.status).toBe(422);
    expect(s.engine.runActive).toBe(false);
  });

  it("a run can select inputs that fit under the limit", async () => {
    const s = await startServer({ limits: { maxRunFiles: 1 } });
    fs.writeFileSync(path.join(s.inputDir, "a.pdf"), PDF);
    fs.writeFileSync(path.join(s.inputDir, "b.pdf"), PDF);
    const res = await s.post("/run", s.authed({ json: { inputs: ["a.pdf"] } }));
    expect(res.status).toBe(202);
  });

  for (const name of ["a.pdf", "a.PDF", "a.zip", "a.xlsx", "a.csv"]) {
    it(`allowed type ${name} is accepted`, async () => {
      const s = await startServer();
      expect((await upload(s, [["files", name, "%PDF-data"]])).status).toBe(200);
    });
  }
});

describe("DELETE /files", () => {
  it("removes a file directly inside input", async () => {
    const s = await startServer();
    await upload(s, [["files", "gone.pdf", PDF]]);
    const res = await s.delete("/files/gone.pdf", s.authed());
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ ok: true, name: "gone.pdf" });
    expect(fs.existsSync(path.join(s.inputDir, "gone.pdf"))).toBe(false);
  });

  it("decodes percent-encoded names", async () => {
    const s = await startServer();
    await upload(s, [["files", "Asha Rao.pdf", PDF]]);
    expect((await s.delete("/files/Asha%20Rao.pdf", s.authed())).status).toBe(200);
  });

  for (const name of ["..%2Fsecret.txt", "%2e%2e", "..%5Csecret.txt", "missing.pdf", ".hidden", "sub%2Ffile.pdf", "%E0%A4%A", "a%00b.pdf"]) {
    it(`refuses ${name}`, async () => {
      const s = await startServer();
      const outside = path.join(s.root, "secret.txt");
      fs.writeFileSync(outside, "keep me");
      fs.writeFileSync(path.join(s.inputDir, ".hidden"), "hidden");
      const res = await s.delete(`/files/${name}`, s.authed());
      expect(res.status).toBe(404);
      expect(fs.readFileSync(outside, "utf8")).toBe("keep me");
      expect(fs.existsSync(path.join(s.inputDir, ".hidden"))).toBe(true);
    });
  }

  it("refuses a directory named like a file", async () => {
    const s = await startServer();
    fs.mkdirSync(path.join(s.inputDir, "folder.pdf"));
    expect((await s.delete("/files/folder.pdf", s.authed())).status).toBe(404);
  });

  it("refuses a symbolic link", async () => {
    const s = await startServer();
    const target = path.join(s.root, "target.pdf");
    fs.writeFileSync(target, "x");
    try {
      fs.symlinkSync(target, path.join(s.inputDir, "link.pdf"));
    } catch {
      return; // no permission to create links on this machine
    }
    expect((await s.delete("/files/link.pdf", s.authed())).status).toBe(404);
    expect(fs.existsSync(target)).toBe(true);
  });
});

describe("zip listing", () => {
  function zipBytes(entries: Array<[string, string]>, utf8Flag = true): Buffer {
    // A minimal stored (no compression) zip writer: enough for central directory tests.
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const [name, content] of entries) {
      const nameBytes = Buffer.from(name, "utf8");
      const data = Buffer.from(content);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(utf8Flag ? 0x800 : 0, 6);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBytes.length, 26);
      locals.push(local, nameBytes, data);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(utf8Flag ? 0x800 : 0, 8);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(nameBytes.length, 28);
      central.writeUInt32LE(offset, 42);
      centrals.push(central, nameBytes);
      offset += 30 + nameBytes.length + data.length;
    }
    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
  }

  it("shows the file names inside a zip without unpacking it", async () => {
    const s = await startServer();
    fs.writeFileSync(
      path.join(s.inputDir, "batch.zip"),
      zipBytes([["Asha_Rao_CV.pdf", "x"], ["nested/Ben_Hill_CV.pdf", "x"], ["__MACOSX/._Asha_Rao_CV.pdf", "junk"], ["folder/", ""], ["nested/.hidden", "x"], ["Zoë.pdf", "x"]]),
    );
    fs.writeFileSync(path.join(s.inputDir, "broken.zip"), "this is not a zip");
    fs.writeFileSync(path.join(s.inputDir, "plain.pdf"), PDF);
    const listed = Object.fromEntries((await s.get("/files", s.authed())).json().files.map((f: any) => [f.name, f]));
    expect(listed["batch.zip"].entries).toEqual(["Asha_Rao_CV.pdf", "nested/Ben_Hill_CV.pdf", "Zoë.pdf"]);
    expect(listed["broken.zip"].entries).toBeNull();
    expect("entries" in listed["plain.pdf"]).toBe(false);
    expect(fs.readdirSync(s.inputDir).sort()).toEqual(["batch.zip", "broken.zip", "plain.pdf"]); // nothing was unpacked
  });

  it("reads a zip written by the system zip tools too", () => {
    const dir = tempDir();
    const file = path.join(dir, "x.zip");
    fs.writeFileSync(file, zipBytes([["a.pdf", "x"]]));
    expect(readZipNames(file)).toEqual(["a.pdf"]);
    fs.writeFileSync(file, Buffer.alloc(10));
    expect(() => readZipNames(file)).toThrow();
  });

  it("lists at most 500 names", () => {
    const dir = tempDir();
    const file = path.join(dir, "big.zip");
    fs.writeFileSync(file, zipBytes(Array.from({ length: 600 }, (_, i) => [`f${i}.pdf`, ""] as [string, string])));
    expect(readZipNames(file, 500)).toHaveLength(500);
  });
});

describe("streamMultipart", () => {
  class Collector {
    parts: Array<{ name: string; data: Buffer; done: boolean }> = [];
    async onPart(_name: string | null, filename: string | null): Promise<PartSink | null> {
      if (filename === null) return null;
      const part = { name: filename, data: Buffer.alloc(0), done: false };
      this.parts.push(part);
      return {
        write: async (data: Buffer) => {
          part.data = Buffer.concat([part.data, data]);
        },
        finish: async () => {
          part.done = true;
        },
      };
    }
  }
  const source = (body: Buffer, size = 7) => Readable.from(Array.from({ length: Math.ceil(body.length / size) }, (_, i) => body.subarray(i * size, (i + 1) * size)));

  for (const chunk of [1, 2, 3, 7, 64, 65536]) {
    it(`handles delimiters split across reads (chunk ${chunk})`, async () => {
      const tricky = Buffer.from("line one\r\n--BOUNDARY\r\n-- almost\r\n--BOUNDAR\r\n\r\nend");
      const { body } = multipart([["files", "a.pdf", tricky], ["files", "b.csv", Buffer.from([0, 1, 2, 13, 10, 45, 45])]]);
      const collector = new Collector();
      await streamMultipart(source(body, 5), body.length, Buffer.from("BOUNDARY123"), (n, f) => collector.onPart(n, f), { chunk });
      expect(collector.parts.map((p) => p.name)).toEqual(["a.pdf", "b.csv"]);
      expect(collector.parts[0]?.data.equals(tricky)).toBe(true);
      expect(collector.parts[1]?.data.equals(Buffer.from([0, 1, 2, 13, 10, 45, 45]))).toBe(true);
      expect(collector.parts.every((p) => p.done)).toBe(true);
    });
  }

  it("rejects a truncated body", async () => {
    const { body } = multipart([["files", "a.pdf", Buffer.alloc(100, "0123456789")]]);
    const cut = body.subarray(0, Math.floor(body.length / 2));
    const collector = new Collector();
    await expect(streamMultipart(source(cut), cut.length, Buffer.from("BOUNDARY123"), (n, f) => collector.onPart(n, f))).rejects.toBeInstanceOf(MultipartError);
  });

  it("rejects garbage", async () => {
    const body = Buffer.from("not a multipart body at all");
    const collector = new Collector();
    await expect(streamMultipart(source(body), body.length, Buffer.from("BOUNDARY123"), (n, f) => collector.onPart(n, f))).rejects.toBeInstanceOf(MultipartError);
  });

  it("reads no more than Content-Length", async () => {
    const { body } = multipart([["files", "a.pdf", "abc"]]);
    const trailing = Buffer.concat([body, Buffer.from("TRAILING GARBAGE")]);
    const collector = new Collector();
    await streamMultipart(source(trailing), body.length, Buffer.from("BOUNDARY123"), (n, f) => collector.onPart(n, f));
    expect(collector.parts[0]?.data.toString()).toBe("abc");
  });

  it("rejects oversized part headers", async () => {
    const body = Buffer.from(`--BOUNDARY123\r\nX-Big: ${"a".repeat(200)}`);
    const collector = new Collector();
    await expect(streamMultipart(source(body), body.length, Buffer.from("BOUNDARY123"), (n, f) => collector.onPart(n, f), { maxHeader: 50 })).rejects.toThrow(/too large/);
  });

  it("an empty multipart form (only the closing boundary) yields no parts", async () => {
    const body = Buffer.from("--BOUNDARY123--\r\n");
    const collector = new Collector();
    await streamMultipart(source(body), body.length, Buffer.from("BOUNDARY123"), (n, f) => collector.onPart(n, f));
    expect(collector.parts).toEqual([]);
  });
});
