/** Serves the built web UI (packages/web/dist) at "/". Files only, never outside the folder; unknown extensionless paths get index.html. */
import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "./http";
import { sendBytes } from "./http";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** The default folder of the built UI relative to this package. */
export function defaultWebDir(packageRoot: string): string | null {
  const dir = path.resolve(packageRoot, "..", "web", "dist");
  return fs.existsSync(path.join(dir, "index.html")) ? dir : null;
}

function fileIn(root: string, relative: string): string | null {
  const target = path.resolve(root, "." + path.sep + relative);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  try {
    return fs.statSync(target).isFile() ? target : null;
  } catch {
    return null;
  }
}

/** Handle a GET/HEAD that no API route matched. Returns false when there is nothing to serve (the caller answers 404). */
export async function serveStatic(ctx: Ctx, webDir: string | null): Promise<boolean> {
  if (webDir === null) return false;
  const root = path.resolve(webDir);
  let relative: string;
  try {
    relative = decodeURIComponent(ctx.rawPath).replace(/^\/+/, "");
  } catch {
    return false;
  }
  if (relative.includes("\0") || relative.split(/[\\/]/).includes("..")) return false;
  let file = relative === "" ? fileIn(root, "index.html") : fileIn(root, relative);
  if (file === null && path.extname(relative) === "" && relative !== "") file = fileIn(root, "index.html"); // client-side routes
  if (file === null) return false;
  const ext = path.extname(file).toLowerCase();
  const immutable = relative.startsWith("assets/") && ext !== ".html";
  const body = ctx.req.method === "HEAD" ? Buffer.alloc(0) : fs.readFileSync(file);
  sendBytes(ctx, 200, body, TYPES[ext] ?? "application/octet-stream", {
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    ...(ctx.req.method === "HEAD" ? { "Content-Length": String(fs.statSync(file).size) } : {}),
  });
  return true;
}
