/** Public API of @intake/server. */
import type http from "node:http";
import { loadServerConfig, type ServerConfig } from "./config";
import { createEngine, Engine, type EngineOptions } from "./engine";
import { createHttpServer, listen } from "./http";

export { Engine, createEngine, validateRunOptions, summariseResult, inBatchDuplicatesOf, PipelineUnavailable } from "./engine";
export type { EngineOptions, Runner, RunSummary } from "./engine";
export { createHttpServer, listen, PORT_START, PORT_END } from "./http";
export { loadServerConfig } from "./config";
export type { ServerConfig } from "./config";
export * from "./auth";
export {
  ConfigStore, SecretStore, SettingsStore, EncryptedVault, ConfigUnreadable, SettingsInvalid, SettingsRejected,
  SECRET_NAMES, createSecretStore, validateSinkBase, validateLlmBaseUrl, atomicWriteBytes,
} from "./settings-store";
export { Committer, parseRequest, buildItems, identityKey, idempotencyKey } from "./sink-commit";
export { createLogger } from "./logger";
export { VERSION, PROTOCOL, APP_ID } from "./version";

export interface RunningServer {
  engine: Engine;
  server: http.Server;
  host: string;
  port: number;
  /** http://host:port, for logs and for clients. */
  url: string;
  /** Resolves when the server has stopped (after stop() or POST /shutdown). */
  stopped: Promise<void>;
  stop(): Promise<void>;
}

/** Create the engine, bind the listener and return the running server. `overrides` win over the environment. */
export async function startServer(overrides: { host?: string; ports?: number[]; engine?: EngineOptions } = {}, env: NodeJS.ProcessEnv = process.env): Promise<RunningServer> {
  const base: ServerConfig = loadServerConfig(env);
  const engine = createEngine({ ...base.engine, ...(overrides.engine ?? {}) });
  const server = createHttpServer(engine);
  const host = overrides.host ?? base.host;
  const port = await listen(engine, server, { host, ports: overrides.ports ?? base.ports });
  const stopped = new Promise<void>((resolve) => server.once("close", () => resolve()));
  return {
    engine,
    server,
    host,
    port,
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    stopped,
    stop: () => engine.shutdown().then(() => stopped),
  };
}
