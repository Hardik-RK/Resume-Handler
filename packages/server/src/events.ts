/**
 * Event bus and redaction. The bus, the redaction patterns and the secret registry live in @intake/core (a port of the
 * reference events module); the server only adds the SSE framing in http.ts. This file is the single import point.
 */
export { EventBus, Subscription, REPLAY_SIZE, SUBSCRIBER_BACKLOG, registerSecret, scrub, redactEvent as redact } from "@intake/core";
export type { WireEvent } from "@intake/core";
