import { EventEmitter } from "node:events";
import { render } from "ink";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { Store } from "../src/progress.ts";
import { App } from "../src/ui.tsx";

/** A fake terminal stream: Ink writes frames to it and we keep the last one. */
class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 40;
  isTTY = true;
  frames: string[] = [];
  write(frame: string): boolean {
    this.frames.push(frame);
    return true;
  }
}

describe("live display", () => {
  it("shows progress, cost, file rows, failures and the sink line", async () => {
    const store = new Store();
    const stdout = new FakeStdout();
    const instance = render(createElement(App, { store, title: "(fake provider, offline)" }), { stdout: stdout as never, debug: true, patchConsole: false });
    store.dispatch({ type: "phase", data: { phase: "parsing", total: 4 } });
    store.dispatch({ type: "progress", data: { done: 2, total: 4, elapsed: 3, eta: 3, stage: "parsing" } });
    store.dispatch({ type: "cost", data: { tokens: 1200, usd: 0.0042 } });
    store.dispatch({ type: "file", data: { name: "alina.pdf", status: "parsed", detail: "" } });
    store.dispatch({ type: "file", data: { name: "broken.pdf", status: "quarantined", detail: "unreadable" } });
    store.dispatch({ type: "commit_started", data: { campaignId: 1, rows: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const last = stdout.frames.at(-1) ?? "";
    instance.unmount();
    expect(last).toContain("fake provider, offline");
    expect(last).toContain("2/4 files");
    expect(last).toContain("tokens 1200");
    expect(last).toContain("$0.0042");
    expect(last).toContain("alina.pdf");
    expect(last).toContain("Failures (1)");
    expect(last).toContain("broken.pdf: unreadable");
    expect(last).toContain("Sink running");
  });
});
