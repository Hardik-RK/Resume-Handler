/** Handshake over HTTP: token rules, origin rules, CORS and Host checks, and the three auth modes end to end. */
import net from "node:net";
import { describe, expect, it } from "vitest";
import { createAuthenticator } from "../src/auth";
import { b64url, claimsFor, makeSigner, ORIGIN, request, signClaims, startServer } from "./helpers";

const PROTECTED: Array<[string, string]> = [
  ["GET", "/state"],
  ["GET", "/files"],
  ["GET", "/results"],
  ["GET", "/results.csv"],
  ["POST", "/run"],
  ["POST", "/settings"],
  ["POST", "/cancel"],
  ["POST", "/commit/retry"],
  ["POST", "/open"],
  ["POST", "/shutdown"],
  ["DELETE", "/files/x.pdf"],
];

describe("signed mode", () => {
  it("hello needs no token and reports identity", async () => {
    const s = await startServer();
    const res = await s.get("/hello");
    expect(res.status).toBe(200);
    const body = res.json();
    expect(body.app).toBe("resume-intake");
    expect(body.port).toBe(s.port);
    expect(body.protocol).toBe(1);
    expect(body.auth).toBe("signed");
    expect(body.dataDir).toBeTruthy();
    expect(body.commitConfigured).toBe(false);
  });

  for (const [method, path] of PROTECTED) {
    it(`${method} ${path} without a token is 401`, async () => {
      const s = await startServer();
      const res = await request(s.port, method, path, method === "POST" ? { json: {} } : {});
      expect(res.status).toBe(401);
      expect(res.json().error).toBeTruthy();
    });
  }

  it("garbage tokens are 401", async () => {
    const s = await startServer();
    for (const bad of ["garbage", "a.b", "....", "abc.def.ghi", "%%%.%%%", "A".repeat(20000)]) {
      expect((await s.get("/state", { token: bad })).status, bad.slice(0, 20)).toBe(401);
    }
  });

  it("a valid token is accepted, and the bearer scheme is case insensitive", async () => {
    const s = await startServer();
    expect((await s.get("/state", { token: s.token })).status).toBe(200);
    const res = await request(s.port, "GET", "/state", { headers: { Authorization: `bearer ${s.token}` } });
    expect(res.status).toBe(200);
  });

  it("expired, tampered, wrong audience, wrong role and foreign key are 401", async () => {
    const s = await startServer();
    expect((await s.get("/state", { token: signClaims(s.signer, claimsFor({}, -5)) })).status).toBe(401);
    const [payload, signature] = s.token.split(".") as [string, string];
    const forged = { ...JSON.parse(Buffer.from(payload, "base64url").toString()), sub: "someone@else.example" };
    expect((await s.get("/state", { token: `${b64url(JSON.stringify(forged))}.${signature}` })).status).toBe(401);
    expect((await s.get("/state", { token: signClaims(s.signer, claimsFor({ aud: "some-other-app" })) })).status).toBe(401);
    expect((await s.get("/state", { token: signClaims(s.signer, claimsFor({ role: "recruiter" })) })).status).toBe(401);
    expect((await s.get("/state", { token: signClaims(makeSigner(), claimsFor()) })).status).toBe(401);
  });

  it("unsigned or missing-signature tokens are 401", async () => {
    const s = await startServer();
    const payload = b64url(JSON.stringify(claimsFor()));
    expect((await s.get("/state", { token: payload })).status).toBe(401);
    expect((await s.get("/state", { token: `${payload}.` })).status).toBe(401);
  });

  it("the query token works for /events only", async () => {
    const s = await startServer();
    expect((await s.get(`/state?token=${s.token}`)).status).toBe(401);
    expect((await s.get(`/files?token=${s.token}`)).status).toBe(401);
    expect((await s.post(`/cancel?token=${s.token}`, { json: {} })).status).toBe(401);
  });

  it("unknown route is 404, wrong method is 405", async () => {
    const s = await startServer();
    expect((await s.get("/nope", s.authed())).status).toBe(404);
    expect((await s.post("/state", s.authed({ json: {} }))).status).toBe(405);
    expect((await s.get("/files/x.pdf", s.authed())).status).toBe(405);
  });
});

describe("origin rules", () => {
  it("an evil origin gets 403 and no CORS headers", async () => {
    const s = await startServer();
    const res = await request(s.port, "GET", "/hello", { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("the null origin is refused", async () => {
    const s = await startServer();
    const res = await request(s.port, "GET", "/hello", { origin: "null" });
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("an allowed origin is reflected exactly, never *", async () => {
    const s = await startServer();
    const res = await request(s.port, "GET", "/hello", { origin: ORIGIN });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(res.headers.vary).toBe("Origin");
  });

  it("the origin must match exactly", async () => {
    const s = await startServer();
    expect((await request(s.port, "GET", "/hello", { origin: `${ORIGIN}.evil.example` })).status).toBe(403);
    expect((await request(s.port, "GET", "/hello", { origin: "http://localhost:9999" })).status).toBe(403);
    expect((await request(s.port, "GET", "/hello", { origin: `${ORIGIN}/` })).status).toBe(403);
  });

  it("the page's own origin is always allowed (same-origin web UI)", async () => {
    const s = await startServer();
    const own = `http://127.0.0.1:${s.port}`;
    const res = await request(s.port, "GET", "/hello", { origin: own });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(own);
  });

  it("preflight answers private network and headers", async () => {
    const s = await startServer();
    const res = await request(s.port, "OPTIONS", "/state", {
      origin: ORIGIN,
      headers: { "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization", "Access-Control-Request-Private-Network": "true" },
    });
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(res.headers["access-control-allow-private-network"]).toBe("true");
    expect(String(res.headers["access-control-allow-headers"])).toContain("Authorization");
    expect(String(res.headers["access-control-allow-headers"])).toContain("Content-Type");
    expect(String(res.headers["access-control-allow-methods"])).toContain("DELETE");
    expect(Number(res.headers["access-control-max-age"])).toBeGreaterThan(0);
  });

  it("preflight from an evil origin gets no CORS", async () => {
    const s = await startServer();
    const res = await request(s.port, "OPTIONS", "/state", { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-private-network"]).toBeUndefined();
  });

  it("a request without Origin is a non-browser client and gets no CORS", async () => {
    const s = await startServer();
    const res = await request(s.port, "GET", "/hello", { origin: null });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("host rules", () => {
  it("a foreign Host header is refused (DNS rebinding guard)", async () => {
    const s = await startServer();
    const data = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(s.port, "127.0.0.1", () => {
        socket.write(`GET /hello HTTP/1.1\r\nHost: evil.example:${s.port}\r\nOrigin: ${ORIGIN}\r\nConnection: close\r\n\r\n`);
      });
      let out = "";
      socket.on("data", (d) => (out += d.toString()));
      socket.on("end", () => resolve(out));
      socket.on("error", reject);
    });
    expect(data.startsWith("HTTP/1.1 403")).toBe(true);
  });

  it("a foreign Host with a matching Origin does not slip through as same-origin", async () => {
    const s = await startServer();
    const res = await request(s.port, "GET", "/hello", { origin: "http://evil.example", headers: { Host: "evil.example" } });
    expect(res.status).toBe(403);
  });

  it("hosted modes accept any Host unless INTAKE_ALLOWED_HOSTS is set", async () => {
    const s = await startServer({ allowedHosts: null });
    const res = await request(s.port, "GET", "/hello", { origin: null, headers: { Host: "intake.example.test" } });
    expect(res.status).toBe(200);
  });

  it("listens on loopback only by default", async () => {
    const s = await startServer();
    const address = s.server.address();
    expect(typeof address === "object" && address?.address).toBe("127.0.0.1");
  });
});

describe("token mode", () => {
  it("accepts only the configured bearer token, also as the /events query token", async () => {
    const token = "static-token-0123456789";
    const s = await startServer({ auth: createAuthenticator({ mode: "token", token }) });
    expect((await s.get("/state")).status).toBe(401);
    expect((await s.get("/state", { token: "wrong-token-0123456789" })).status).toBe(401);
    expect((await s.get("/state", { token })).status).toBe(200);
    expect((await s.get(`/state?token=${token}`)).status).toBe(401);
    const events = await new Promise<number>((resolve) => {
      import("node:http").then(({ default: http }) => {
        const req = http.get({ host: "127.0.0.1", port: s.port, path: `/events?token=${token}`, headers: { Origin: ORIGIN } }, (res) => {
          resolve(res.statusCode ?? 0);
          req.destroy();
        });
      });
    });
    expect(events).toBe(200);
    expect((await s.get("/hello")).json().auth).toBe("token");
  });
});

describe("none mode", () => {
  it("needs no credentials but still checks Origin and Host", async () => {
    const s = await startServer({ auth: createAuthenticator({ mode: "none" }) });
    expect((await s.get("/state")).status).toBe(200);
    expect((await s.get("/state", { origin: "https://evil.example" })).status).toBe(403);
    expect((await s.get("/hello")).json().auth).toBe("none");
  });

  it("defaults to loopback host names only", async () => {
    const s = await startServer({ auth: createAuthenticator({ mode: "none" }), allowedHosts: undefined });
    expect(s.engine.allowedHosts).toEqual(["127.0.0.1", "localhost"]);
  });
});
