/** Minimal logger: every line is redacted (secrets, tokens, keys) before it reaches stderr or the log file. */
import fs from "node:fs";
import path from "node:path";
import { redact } from "./events";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

const MAX_LOG_BYTES = 1_000_000;
const BACKUPS = 3;

function rotate(file: string): void {
  try {
    if (fs.statSync(file).size < MAX_LOG_BYTES) return;
  } catch {
    return;
  }
  for (let i = BACKUPS; i >= 1; i -= 1) {
    const from = i === 1 ? file : `${file}.${i - 1}`;
    try {
      fs.renameSync(from, `${file}.${i}`);
    } catch {
      /* the older backup does not exist yet */
    }
  }
}

export interface LoggerOptions {
  /** Folder for engine.log (rotated at 1 MB, 3 backups). */
  logsDir?: string;
  /** Also write to stderr (default true). */
  stderr?: boolean;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const file = options.logsDir ? path.join(options.logsDir, "engine.log") : null;
  const toStderr = options.stderr ?? true;
  const write = (level: string, message: string) => {
    const line = `${new Date().toISOString()} ${level} ${redact(message)}\n`;
    if (file) {
      try {
        rotate(file);
        fs.appendFileSync(file, line, "utf8");
      } catch {
        /* logging must never break a request */
      }
    }
    if (toStderr) process.stderr.write(line);
  };
  return { info: (m) => write("INFO", m), warn: (m) => write("WARNING", m), error: (m) => write("ERROR", m) };
}
