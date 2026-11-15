/** Settings: URL allowlists, secret rules and masking (golden against the reference), the encrypted vault, atomic config. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  atomicWriteBytes,
  ConfigStore,
  ConfigUnreadable,
  createSecretStore,
  decryptSecret,
  EncryptedVault,
  encryptSecret,
  parseSecretsKey,
  resolveSecretsKey,
  SecretStore,
  SettingsInvalid,
  SettingsRejected,
  SettingsStore,
  splitUrl,
  validateLlmBaseUrl,
  validateSinkBase,
  type Vault,
} from "../src/settings-store";
import fixtures from "./golden/fixtures.json";
import { MemoryVault, startServer, tempDir } from "./helpers";

const OPENROUTER = "sk-or-v1-0123456789abcdef0123456789";
const GOOGLE_TOKEN = JSON.stringify({ refresh_token: "1//refresh-value-xyz", client_id: "cid" });
const GOOGLE_CLIENT = JSON.stringify({ installed: { client_id: "cid", client_secret: "GOCSPX-secret-value" } });
const INGEST = "ingest-token-0123456789abcdef";

// The only wording that differs from the reference: the product is called "the server" here, not "the uploader".
const brand = (text: string) => text.replace("the uploader supports", "the server supports");

const outcome = (fn: (v: unknown) => string, value: unknown) => {
  try {
    return { ok: fn(value) };
  } catch (err) {
    if (err instanceof SettingsRejected) return { error: err.message };
    throw err;
  }
};

describe("golden: URL rules", () => {
  for (const c of fixtures.sinkUrls) {
    it(`sink base ${JSON.stringify(c.input)}`, () => expect(outcome(validateSinkBase, c.input)).toEqual("ok" in c ? { ok: c.ok } : { error: brand(c.error as string) }));
  }
  for (const c of fixtures.llmUrls) {
    it(`llm base ${JSON.stringify(c.input)}`, () => expect(outcome(validateLlmBaseUrl, c.input)).toEqual("ok" in c ? { ok: c.ok } : { error: brand(c.error as string) }));
  }
});

describe("splitUrl", () => {
  it("keeps the netloc as typed and lowercases scheme and host", () => {
    const p = splitUrl("HTTPS://User:pw@Host.Example:8443/p?q=1#f");
    expect(p).toMatchObject({ scheme: "https", netloc: "User:pw@Host.Example:8443", hostname: "host.example", port: 8443, path: "/p", query: "q=1", fragment: "f", username: "User", password: "pw" });
  });
  it("throws for a bad port", () => {
    expect(() => splitUrl("https://h:99999")).toThrow();
    expect(() => splitUrl("https://h:abc")).toThrow();
  });
});

describe("golden: secret rules", () => {
  for (const c of fixtures.secretsNormalise) {
    it(`${c.name} ${JSON.stringify(c.value).slice(0, 30)}`, () => {
      const store = new SettingsStore(new ConfigStore(path.join(tempDir(), "config.json")), new SecretStore(new MemoryVault()));
      let got: { ok?: string | null; error?: string };
      try {
        store.apply(null, { [c.name]: c.value });
        got = { ok: store.secrets.values()[c.name] ?? null };
      } catch (err) {
        if (!(err instanceof SettingsInvalid)) throw err;
        got = { error: err.message };
      }
      if ("error" in c) expect(got).toEqual({ error: c.error });
      else {
        // The reference stores JSON documents as compact ASCII JSON; here the same document, same meaning.
        const expected = c.ok;
        const actual = got.ok ?? null;
        if (expected !== null && typeof c.value === "object") expect(JSON.parse(actual as string)).toEqual(JSON.parse(expected));
        else expect(actual).toEqual(expected);
      }
    });
  }
});

describe("golden: apply() sequence and the masked status", () => {
  it("every step matches the reference: status, rejections, merged settings, secret presence", () => {
    const dir = tempDir();
    const store = new SettingsStore(new ConfigStore(path.join(dir, "config.json")), new SecretStore(new MemoryVault()));
    store.load();
    for (const step of fixtures.applySteps as Array<any>) {
      let got: Record<string, unknown> = {};
      try {
        const { secretStore: _ignored, ...status } = store.apply(step.step.config, step.step.secrets);
        got = { status };
      } catch (err) {
        if (err instanceof SettingsRejected) got = { rejected: err.message };
        else if (err instanceof SettingsInvalid) got = { invalid: err.message };
        else throw err;
      }
      const expected: Record<string, unknown> = {};
      for (const k of ["status", "rejected", "invalid"]) if (k in step) expected[k] = typeof step[k] === "string" ? brand(step[k]) : step[k];
      expect(got, JSON.stringify(step.step)).toEqual(expected);
      expect(store.settings, JSON.stringify(step.step)).toEqual(step.settings);
      expect(store.secrets.presence(), JSON.stringify(step.step)).toEqual(step.secretPresence);
    }
  });

  it("the status never carries a secret value", () => {
    const store = new SettingsStore(new ConfigStore(path.join(tempDir(), "config.json")), new SecretStore(new MemoryVault()));
    const status = store.apply({ llmBaseUrl: "https://openrouter.ai/api/v1" }, { openrouterApiKey: OPENROUTER, ingestionToken: INGEST });
    const text = JSON.stringify(status);
    expect(text).not.toContain(OPENROUTER);
    expect(text).not.toContain(INGEST);
    expect(status.secrets).toEqual({ openrouterApiKey: true, googleClientSecrets: false, googleTokenJson: false, ingestionToken: true });
  });
});

describe("settings over HTTP", () => {
  const push = (s: Awaited<ReturnType<typeof startServer>>, config?: unknown, secrets?: unknown) =>
    s.post("/settings", s.authed({ json: { ...(config !== undefined ? { config } : {}), ...(secrets !== undefined ? { secrets } : {}) } }));

  it("round trip and /state", async () => {
    const s = await startServer();
    const res = await push(s, { llmBaseUrl: "https://openrouter.ai/api/v1", maxConcurrency: 4, driveFolders: { x: "1" } }, {
      openrouterApiKey: OPENROUTER,
      googleClientSecrets: GOOGLE_CLIENT,
      googleTokenJson: GOOGLE_TOKEN,
    });
    expect(res.status).toBe(200);
    expect(res.json().secrets).toEqual({ openrouterApiKey: true, googleClientSecrets: true, googleTokenJson: true, ingestionToken: false });
    const state = (await s.get("/state", s.authed())).json();
    expect(state.settingsLoaded).toBe(true);
    expect(state.llm.ok).toBe(true);
    expect(state.google.ok).toBe(true);
    expect(state.configError).toBeNull();
    expect(s.engine.settings.settings.maxConcurrency).toBe(4);
    expect(s.engine.settings.secretSnapshot().openrouterApiKey).toBe(OPENROUTER);
    expect(JSON.stringify(state)).not.toContain(OPENROUTER);
  });

  it("secrets never reach config.json, even when sent as config", async () => {
    const s = await startServer();
    await push(s, { llmBaseUrl: "https://openrouter.ai/api/v1", openrouterApiKey: "should-not-persist" }, { openrouterApiKey: OPENROUTER });
    const text = fs.readFileSync(path.join(s.root, "AppData", "config.json"), "utf8");
    expect(text).not.toContain("should-not-persist");
    expect(text).not.toContain(OPENROUTER);
    expect(text).not.toContain("openrouterApiKey");
    expect(JSON.parse(text).settings).toEqual({ llmBaseUrl: "https://openrouter.ai/api/v1" });
  });

  it("a null or empty secret clears it", async () => {
    const s = await startServer();
    await push(s, undefined, { openrouterApiKey: OPENROUTER });
    expect((await s.get("/state", s.authed())).json().llm.ok).toBe(true);
    await push(s, undefined, { openrouterApiKey: null });
    expect((await s.get("/state", s.authed())).json().llm.ok).toBe(false);
  });

  it("bad secrets are 400 with a message", async () => {
    const s = await startServer();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ openrouterApiKey: "short" }, "invalid"],
      [{ openrouterApiKey: "has space in it" }, "invalid"],
      [{ googleTokenJson: "{not json" }, "valid JSON"],
      [{ somethingElse: "x" }, "Unknown secret"],
      [{ openrouterApiKey: 12345678 }, "unsupported type"],
    ];
    for (const [secrets, fragment] of cases) {
      const res = await push(s, undefined, secrets);
      expect(res.status).toBe(400);
      expect(res.json().error).toContain(fragment);
    }
  });

  it("needs config or secrets, and an object body", async () => {
    const s = await startServer();
    expect((await push(s)).status).toBe(400);
    expect((await s.post("/settings", s.authed({ json: ["nope"] }))).status).toBe(400);
  });

  it("an LLM base outside the allowlist is 422 and nothing is written", async () => {
    const s = await startServer();
    const res = await push(s, { llmBaseUrl: "https://example.test/api/v1" });
    expect(res.status).toBe(422);
    expect(res.json().error).toContain("llmBaseUrl is not allowed");
    expect(s.engine.settings.settings.llmBaseUrl).toBeUndefined();
  });

  it("a sink base over plain http is 422 and neither config nor token is written", async () => {
    const s = await startServer();
    const res = await push(s, { crmBaseUrl: "http://sink.example.test" }, { ingestionToken: INGEST });
    expect(res.status).toBe(422);
    expect(res.json().error).toContain("https");
    expect(s.engine.settings.secretSnapshot().ingestionToken).toBeUndefined();
  });

  it("the ingestion token is a secret: encrypted in the vault, never in config.json", async () => {
    const root = tempDir();
    const configDir = path.join(root, "AppData");
    const store = createSecretStore(configDir, { INTAKE_SECRETS_KEY: crypto.randomBytes(32).toString("hex") });
    const s = await startServer({ root, secretStore: store });
    const res = await push(s, { crmBaseUrl: "https://sink.example.test" }, { ingestionToken: INGEST });
    expect(res.status).toBe(200);
    expect(res.json().secrets.ingestionToken).toBe(true);
    expect(fs.readFileSync(path.join(configDir, "config.json"), "utf8")).not.toContain(INGEST);
    const vault = fs.readFileSync(path.join(configDir, "secrets.vault.json"), "utf8");
    expect(vault).not.toContain(INGEST);
    expect(vault).toContain("ingestionToken");
  });

  it("partial pushes merge, and null removes a key", async () => {
    const s = await startServer();
    await push(s, { llmBaseUrl: "https://openrouter.ai/api/v1", maxConcurrency: 4 });
    await push(s, { crmBaseUrl: "https://sink.example.test" });
    expect(s.engine.settings.settings).toEqual({ llmBaseUrl: "https://openrouter.ai/api/v1", maxConcurrency: 4, crmBaseUrl: "https://sink.example.test" });
    await push(s, { crmBaseUrl: null });
    expect("crmBaseUrl" in s.engine.settings.settings).toBe(false);
    expect(s.engine.settings.settings.maxConcurrency).toBe(4);
  });

  it("an unreadable config is 409 over HTTP, never overwritten, and secrets still work", async () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, "AppData"), { recursive: true });
    const file = path.join(root, "AppData", "config.json");
    fs.writeFileSync(file, "{broken");
    const s = await startServer({ root });
    const refused = await push(s, { maxConcurrency: 3 });
    expect(refused.status).toBe(409);
    expect(fs.readFileSync(file, "utf8")).toBe("{broken");
    expect((await push(s, undefined, { openrouterApiKey: OPENROUTER })).status).toBe(200);
    expect(fs.readFileSync(file, "utf8")).toBe("{broken");
    expect((await s.get("/state", s.authed())).json().configError).toContain("left untouched");
  });
});

describe("ConfigStore", () => {
  it("writes atomically and leaves no temp files", () => {
    const dir = path.join(tempDir(), "AppData");
    const store = new ConfigStore(path.join(dir, "config.json"));
    store.load();
    store.save({ a: 1 });
    store.save({ a: 2 });
    expect(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).settings).toEqual({ a: 2 });
    expect(fs.readdirSync(dir)).toEqual(["config.json"]);
  });

  it("a failed write keeps the old config and cleans up", () => {
    const dir = tempDir();
    const file = path.join(dir, "config.json");
    const store = new ConfigStore(file);
    store.load();
    store.save({ version: "old" });
    // A directory where the temp file would be renamed to makes the rename fail on every platform.
    const blocked = path.join(dir, "blocked.json");
    fs.mkdirSync(blocked);
    expect(() => atomicWriteBytes(blocked, "x")).toThrow();
    expect(fs.readdirSync(dir).sort()).toEqual(["blocked.json", "config.json"]);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).settings).toEqual({ version: "old" });
  });

  for (const garbage of [Buffer.from("{not json"), Buffer.from("[1, 2, 3]"), Buffer.from([0xff, 0xfe, 0x00, 0x62]), Buffer.from('{"settings": "text"}')]) {
    it(`unreadable config ${JSON.stringify(garbage.toString("latin1")).slice(0, 24)} is kept, reported and never overwritten`, () => {
      const dir = tempDir();
      const file = path.join(dir, "config.json");
      fs.writeFileSync(file, garbage);
      const store = new SettingsStore(new ConfigStore(file), new SecretStore(new MemoryVault()));
      store.load();
      expect(store.configError).toContain("left untouched");
      expect(() => store.apply({ maxConcurrency: 3 }, null)).toThrow(ConfigUnreadable);
      expect(fs.readFileSync(file).equals(garbage)).toBe(true);
    });
  }
});

describe("secret vault (AES-256-GCM)", () => {
  const key = crypto.randomBytes(32);

  it("encrypts and decrypts, bound to the secret's name", () => {
    const blob = encryptSecret(key, "openrouterApiKey", OPENROUTER);
    expect(blob).not.toContain(OPENROUTER);
    expect(decryptSecret(key, "openrouterApiKey", blob)).toBe(OPENROUTER);
    expect(() => decryptSecret(key, "ingestionToken", blob)).toThrow();
    expect(() => decryptSecret(crypto.randomBytes(32), "openrouterApiKey", blob)).toThrow();
    const raw = Buffer.from(blob, "base64");
    raw[raw.length - 1] = (raw[raw.length - 1] as number) ^ 1;
    expect(() => decryptSecret(key, "openrouterApiKey", raw.toString("base64"))).toThrow();
    expect(encryptSecret(key, "openrouterApiKey", OPENROUTER)).not.toBe(blob); // fresh IV every time
  });

  it("the key: 64 hex characters or base64 of 32 bytes, nothing else", () => {
    expect(parseSecretsKey(key.toString("hex")).equals(key)).toBe(true);
    expect(parseSecretsKey(key.toString("base64")).equals(key)).toBe(true);
    for (const bad of ["", "short", "g".repeat(64), key.toString("hex").slice(2), Buffer.alloc(16).toString("base64")]) {
      expect(() => parseSecretsKey(bad), bad).toThrow(/INTAKE_SECRETS_KEY/);
    }
  });

  it("secrets survive a restart through the vault", () => {
    const dir = tempDir();
    const env = { INTAKE_SECRETS_KEY: key.toString("hex") };
    const first = createSecretStore(dir, env);
    first.update({ openrouterApiKey: OPENROUTER, googleTokenJson: GOOGLE_TOKEN });
    const second = createSecretStore(dir, env);
    second.load();
    expect(second.values()).toEqual({ openrouterApiKey: OPENROUTER, googleTokenJson: GOOGLE_TOKEN });
    expect(second.backendName()).toBe("vault");
    expect(second.warnings).toEqual([]);
    expect(fs.readFileSync(path.join(dir, "secrets.vault.json"), "utf8")).not.toContain("refresh-value");
  });

  it("without INTAKE_SECRETS_KEY a key file is generated with mode 0600 and reused", () => {
    const dir = tempDir();
    const first = createSecretStore(dir, {});
    first.update({ openrouterApiKey: OPENROUTER });
    const keyFile = path.join(dir, "secrets.key");
    expect(fs.existsSync(keyFile)).toBe(true);
    if (process.platform !== "win32") expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(resolveSecretsKey(keyFile, {})).toHaveLength(32);
    const second = createSecretStore(dir, {});
    second.load();
    expect(second.values().openrouterApiKey).toBe(OPENROUTER);
  });

  it("the vault file is created with mode 0600", () => {
    if (process.platform === "win32") return;
    const dir = tempDir();
    createSecretStore(dir, {}).update({ openrouterApiKey: OPENROUTER });
    expect(fs.statSync(path.join(dir, "secrets.vault.json")).mode & 0o777).toBe(0o600);
  });

  it("a bad INTAKE_SECRETS_KEY or a corrupt key file fails loudly instead of silently dropping to memory", () => {
    const dir = tempDir();
    expect(() => createSecretStore(dir, { INTAKE_SECRETS_KEY: "nope" })).toThrow(/INTAKE_SECRETS_KEY/);
    fs.writeFileSync(path.join(dir, "secrets.key"), "garbage");
    expect(() => createSecretStore(dir, {})).toThrow();
  });

  it("the wrong key reports a warning per secret instead of crashing", () => {
    const dir = tempDir();
    createSecretStore(dir, { INTAKE_SECRETS_KEY: key.toString("hex") }).update({ openrouterApiKey: OPENROUTER });
    const other = createSecretStore(dir, { INTAKE_SECRETS_KEY: crypto.randomBytes(32).toString("hex") });
    other.load();
    expect(other.presence().openrouterApiKey).toBe(false);
    expect(other.warnings).toContain("openrouterApiKey could not be read from the secret vault.");
  });

  it("a corrupt vault file is kept untouched and reported", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "secrets.vault.json"), "{oops");
    const store = createSecretStore(dir, { INTAKE_SECRETS_KEY: key.toString("hex") });
    store.load();
    expect(store.warnings.length).toBeGreaterThan(0);
    store.update({ openrouterApiKey: OPENROUTER });
    expect(fs.readFileSync(path.join(dir, "secrets.vault.json"), "utf8")).toBe("{oops");
    expect(store.presence().openrouterApiKey).toBe(true); // kept in memory
    expect(store.warnings.some((w) => w.includes("kept in memory only"))).toBe(true);
  });

  it("EncryptedVault.remove deletes an entry", () => {
    const vault = new EncryptedVault(path.join(tempDir(), "v.json"), key);
    vault.put("ingestionToken", INGEST);
    expect(vault.get("ingestionToken")).toBe(INGEST);
    vault.remove("ingestionToken");
    expect(vault.get("ingestionToken")).toBeNull();
  });
});

describe("SecretStore fallbacks", () => {
  class RefusingVault implements Vault {
    get(): string | null {
      throw new Error("no backend");
    }
    put(): void {
      throw new Error("blob too large");
    }
    remove(): void {
      throw new Error("no backend");
    }
  }

  it("a vault that refuses writes falls back to memory with a warning", () => {
    const store = new SecretStore(new RefusingVault());
    store.update({ googleTokenJson: GOOGLE_TOKEN });
    expect(store.presence().googleTokenJson).toBe(true);
    expect(store.warnings.some((w) => w.includes("kept in memory only"))).toBe(true);
    expect(store.backendName()).toBe("vault"); // the store is there, only this write failed
  });

  it("no store at all is memory and warns", () => {
    const store = new SecretStore(null);
    store.load();
    expect(store.backendName()).toBe("memory");
    expect(store.warnings.some((w) => w.includes("memory only"))).toBe(true);
    store.update({ openrouterApiKey: OPENROUTER });
    expect(store.presence().openrouterApiKey).toBe(true);
  });

  it("registered secrets are scrubbed from event text", async () => {
    const { redact } = await import("../src/events");
    const store = new SecretStore(null);
    const value = "registered-secret-value-8731";
    store.update({ ingestionToken: value });
    expect(redact(`oops ${value} leaked`)).not.toContain(value);
  });
});
