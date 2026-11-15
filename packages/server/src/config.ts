/**
 * Server configuration from the environment.
 *
 *   INTAKE_AUTH             none (default) | token | signed
 *   INTAKE_TOKEN            token mode: the static bearer token (at least 16 characters)
 *   INTAKE_PUBLIC_KEY       signed mode: the Ed25519 public key, PEM (a literal \n is accepted for line breaks)
 *   INTAKE_PUBLIC_KEY_FILE  signed mode: path of a PEM file instead
 *   INTAKE_TOKEN_AUDIENCE   signed mode: expected `aud` claim (default resume-intake)
 *   INTAKE_TOKEN_ROLE       signed mode: required `role` claim (default admin)
 *   INTAKE_HOST             bind address (default 127.0.0.1; `none` auth refuses anything but loopback)
 *   INTAKE_PORT             one fixed port (default: first free port of 47831..47840)
 *   INTAKE_ALLOWED_ORIGINS  comma separated browser origins allowed besides the page's own
 *   INTAKE_ALLOWED_HOSTS    comma separated Host names allowed (hosted modes; none auth always allows loopback names only)
 *   INTAKE_WEB_DIR          built web UI folder (default ../web/dist when present; `off` disables)
 *   INTAKE_OPEN_FOLDER      1/0: POST /open may open folders in the OS file manager (default: on for none auth)
 *   INTAKE_ENABLE_SHUTDOWN  1/0: POST /shutdown stops the server (default: on for none auth)
 *   INTAKE_DATA_DIR / INTAKE_CONFIG_DIR / INTAKE_SECRETS_KEY: see paths.ts and settings-store.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuthenticator, parsePublicKey, type AuthMode } from "./auth";
import type { EngineOptions } from "./engine";
import { PORT_END, PORT_START } from "./http";
import { defaultWebDir } from "./static";

export interface ServerConfig {
  host: string;
  /** Ports to try in order. */
  ports: number[];
  engine: EngineOptions;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

const list = (value: string | undefined): string[] | undefined => {
  const items = (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items : undefined;
};

function flag(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env, packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")): ServerConfig {
  const mode = (env.INTAKE_AUTH?.trim().toLowerCase() || "none") as AuthMode;
  if (mode !== "none" && mode !== "token" && mode !== "signed") throw new Error("INTAKE_AUTH must be none, token or signed.");

  const host = env.INTAKE_HOST?.trim() || "127.0.0.1";
  if (mode === "none" && !LOOPBACK.has(host)) {
    throw new Error("INTAKE_AUTH=none only binds to loopback (127.0.0.1). Use INTAKE_AUTH=token or signed to listen elsewhere.");
  }

  let auth;
  if (mode === "token") {
    auth = createAuthenticator({ mode, token: env.INTAKE_TOKEN ?? "" });
  } else if (mode === "signed") {
    const file = env.INTAKE_PUBLIC_KEY_FILE?.trim();
    const pem = file ? fs.readFileSync(file, "utf8") : (env.INTAKE_PUBLIC_KEY ?? "").replace(/\\n/g, "\n");
    if (!pem.trim()) throw new Error("INTAKE_AUTH=signed needs INTAKE_PUBLIC_KEY or INTAKE_PUBLIC_KEY_FILE.");
    auth = createAuthenticator({
      mode,
      publicKey: parsePublicKey(pem),
      ...(env.INTAKE_TOKEN_AUDIENCE ? { audience: env.INTAKE_TOKEN_AUDIENCE } : {}),
      ...(env.INTAKE_TOKEN_ROLE ? { requiredRole: env.INTAKE_TOKEN_ROLE } : {}),
    });
  } else {
    auth = createAuthenticator({ mode });
  }

  let ports: number[];
  if (env.INTAKE_PORT?.trim()) {
    const port = Number(env.INTAKE_PORT);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("INTAKE_PORT must be a port number.");
    ports = [port];
  } else {
    ports = Array.from({ length: PORT_END - PORT_START + 1 }, (_, i) => PORT_START + i);
  }

  const webSetting = env.INTAKE_WEB_DIR?.trim();
  const webDir = webSetting === "off" ? null : webSetting ? path.resolve(webSetting) : defaultWebDir(packageRoot);

  const engine: EngineOptions = { auth, webDir, env };
  const origins = list(env.INTAKE_ALLOWED_ORIGINS);
  if (origins) engine.allowedOrigins = origins;
  const hosts = list(env.INTAKE_ALLOWED_HOSTS);
  if (hosts) engine.allowedHosts = hosts;
  const open = flag(env.INTAKE_OPEN_FOLDER);
  if (open !== undefined) engine.enableOpenFolder = open;
  const shutdown = flag(env.INTAKE_ENABLE_SHUTDOWN);
  if (shutdown !== undefined) engine.enableShutdown = shutdown;
  return { host, ports, engine };
}

