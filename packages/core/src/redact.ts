import { pyJsonDumps } from "./pyjson.js";

/** Redaction for pipeline log lines and file-event details (port of `redact` in pipeline/__init__.py). */

/** Remove secret values, bearer tokens, e-mail addresses and phone-like numbers from a log line. */
export function redact(text: unknown, secrets: Iterable<string> = []): string {
  let out = String(text);
  for (const value of secrets) {
    if (value && value.length >= 8) out = out.split(value).join("[redacted]");
  }
  out = out.replace(/Bearer\s+\S+/g, "Bearer [redacted]");
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, "[email]");
  out = out.replace(/\+?\d[\d\s\-().]{8,}\d/g, (m) => (m.replace(/\D/g, "").length >= 10 ? "[number]" : m));
  return out;
}

/** Every secret value in the run's secrets, including the pieces of the Google JSON documents. */
export function secretValues(secrets: Record<string, unknown>): string[] {
  const values: string[] = [String(secrets["openrouterApiKey"] ?? "")];
  for (const key of ["googleTokenJson", "googleClientSecrets"]) {
    const raw = secrets[key];
    if (!raw) continue;
    values.push(typeof raw === "string" ? raw : pyJsonDumps(raw));
    let info: Record<string, unknown>;
    try {
      info = (typeof raw === "string" ? JSON.parse(raw) : { ...(raw as object) }) as Record<string, unknown>;
      if (info === null || typeof info !== "object" || Array.isArray(info)) continue;
    } catch {
      continue;
    }
    for (const k of ["refresh_token", "client_secret", "access_token"]) values.push(String(info[k] ?? ""));
    const inner = ((info["installed"] ?? info["web"]) as Record<string, unknown> | undefined) ?? {};
    values.push(String(inner["client_secret"] ?? ""));
  }
  return values.filter((v) => v);
}
