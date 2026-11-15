/**
 * Event bus for the SSE stream, plus the redaction applied to every log line and every event.
 *
 * Event shape on the wire (SSE): id, event (= type), data = JSON {"id", "type", "ts", "data": {...payload}}.
 * A late client gets the last REPLAY_SIZE events before the live ones.
 * (Port of engine/events.py; the HTTP/SSE writing itself belongs to the server package.)
 */
import type { WireEvent } from "./types.js";

export const REPLAY_SIZE = 200;
export const SUBSCRIBER_BACKLOG = 1000;

const registeredSecrets = new Set<string>();

const PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{8,}/g, "[redacted-key]"],
  [/AIza[0-9A-Za-z_-]{20,}/g, "[redacted-key]"],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  // signed session tokens and JWT-like values: base64url payload "." base64url signature
  [/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{32,}/g, "[redacted-token]"],
  [
    /("?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|token|secret|password|passwd)"?\s*[:=]\s*"?)[^"\s,;&}]+/gi,
    "$1[redacted]",
  ],
];

/** Remember a secret value so that its exact text is scrubbed from logs and events. */
export function registerSecret(value: unknown): void {
  if (typeof value === "string" && value.trim().length >= 6) registeredSecrets.add(value.trim());
}

/** Forget every registered secret (tests). */
export function clearRegisteredSecrets(): void {
  registeredSecrets.clear();
}

/** Scrub keys, bearer tokens, JWT-like values, `key=value` secrets and registered secrets from text. */
export function redactEvent(text: unknown): string {
  if (text === null || text === undefined) return "";
  let out = String(text);
  const known = [...registeredSecrets].sort((a, b) => b.length - a.length);
  for (const value of known) {
    if (out.includes(value)) out = out.split(value).join("[redacted]");
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return redactEvent(value);
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value instanceof Set) return [...value].map((v) => scrub(v, depth + 1));
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of value) obj[String(k)] = scrub(v, depth + 1);
    return obj;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrub(v, depth + 1);
    return out;
  }
  return redactEvent(String(value));
}

export class Subscription {
  private readonly buffer: Array<WireEvent | null> = [];
  private waiter: ((item: WireEvent | null) => void) | null = null;

  constructor(
    private readonly bus: EventBus,
    readonly replay: WireEvent[],
  ) {}

  /** @internal */
  push(item: WireEvent | null): boolean {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(item);
      return true;
    }
    if (this.buffer.length >= SUBSCRIBER_BACKLOG) return false;
    this.buffer.push(item);
    return true;
  }

  /** @internal drop everything queued and leave the end-of-stream sentinel */
  overflow(): void {
    this.buffer.length = 0;
    this.buffer.push(null);
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(this.buffer.shift() ?? null);
    }
  }

  /**
   * Next event; `null` when the bus closed or this client fell too far behind (it should reconnect);
   * `undefined` when `timeoutMs` passed with nothing to read (send a heartbeat).
   */
  get(timeoutMs: number): Promise<WireEvent | null | undefined> {
    if (this.buffer.length > 0) return Promise.resolve(this.buffer.shift());
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(undefined);
      }, timeoutMs);
      this.waiter = (item) => {
        clearTimeout(timer);
        resolve(item);
      };
    });
  }

  close(): void {
    this.bus.unsubscribe(this);
  }
}

export class EventBus {
  private nextId = 1;
  private history_: WireEvent[] = [];
  private readonly subscribers = new Set<Subscription>();
  private closed = false;

  constructor(private readonly replaySize = REPLAY_SIZE) {}

  publish(type: string, data: Record<string, unknown> = {}): WireEvent {
    const event: WireEvent = {
      id: this.nextId++,
      type: String(type),
      ts: Math.round(Date.now()) / 1000,
      data: scrub(data) as Record<string, unknown>,
    };
    this.history_.push(event);
    if (this.history_.length > this.replaySize) this.history_.shift();
    for (const sub of [...this.subscribers]) {
      if (!sub.push(event)) {
        this.subscribers.delete(sub);
        sub.overflow();
      }
    }
    return event;
  }

  subscribe(afterId = 0): Subscription {
    const replay = this.history_.filter((event) => event.id > afterId);
    const sub = new Subscription(this, replay);
    if (this.closed) sub.push(null);
    else this.subscribers.add(sub);
    return sub;
  }

  history(): WireEvent[] {
    return [...this.history_];
  }

  close(): void {
    this.closed = true;
    for (const sub of [...this.subscribers]) sub.overflow();
    this.subscribers.clear();
  }

  /** @internal */
  unsubscribe(sub: Subscription): void {
    this.subscribers.delete(sub);
  }
}
