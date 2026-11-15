import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Candidate Chromium-family executables per platform, best first. Edge first on Windows (always installed there). */
export function browserCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === "win32") {
    const roots = [env["ProgramFiles(x86)"], env["ProgramFiles"], env["LocalAppData"]].filter((r): r is string => Boolean(r));
    const rels = ["Microsoft\\Edge\\Application\\msedge.exe", "Google\\Chrome\\Application\\chrome.exe", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"];
    return rels.flatMap((rel) => roots.map((root) => path.win32.join(root, rel)));
  }
  if (platform === "darwin") {
    return [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  const names = ["microsoft-edge", "microsoft-edge-stable", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return names.flatMap((name) => dirs.map((dir) => path.join(dir, name)));
}

export function findBrowser(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string | null {
  const override = env.INTAKE_BROWSER;
  if (override && exists(override)) return override;
  return browserCandidates(platform, env).find((candidate) => exists(candidate)) ?? null;
}

/** Arguments that make Chromium show the URL as a standalone app window, with no tabs or address bar. */
export function appModeArgs(url: string): string[] {
  return [`--app=${url}`, "--no-first-run", "--window-size=1280,860"];
}

export interface Launched {
  browser: string;
}

/** Open `url` in a standalone window. Resolves with the browser used; rejects when none is installed. */
export function openAppWindow(url: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Launched {
  const browser = findBrowser(platform, env);
  if (!browser) throw new Error("No Edge or Chrome found. Open the address in any browser instead, or set INTAKE_BROWSER to a Chromium-based browser.");
  const child = spawn(browser, appModeArgs(url), { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
  return { browser };
}

/** Open `url` in the default browser. */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const [command, args]: [string, string[]] =
    platform === "win32" ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]] : platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}
