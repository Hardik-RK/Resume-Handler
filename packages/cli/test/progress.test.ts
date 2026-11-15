import { describe, expect, it } from "vitest";
import { formatEvent, summaryLines } from "../src/plain.ts";
import { Store, exitCodeFor, formatDuration, formatTokens, formatUsd, initialState, progressBar, reduce, type CliEvent } from "../src/progress.ts";

const play = (events: CliEvent[]) => events.reduce(reduce, initialState());

describe("progress reducer", () => {
  it("tracks phase, progress and cost", () => {
    const s = play([
      { type: "phase", data: { phase: "preparing", detail: "reading input folder" } },
      { type: "phase", data: { phase: "parsing", total: 4 } },
      { type: "progress", data: { done: 1, total: 4, elapsed: 2.5, eta: 7, stage: "parsing" } },
      { type: "cost", data: { tokens: 1500, usd: 0.0123 } },
    ]);
    expect(s).toMatchObject({ phase: "parsing", total: 4, done: 1, elapsed: 2.5, eta: 7, tokens: 1500, usd: 0.0123, finished: false });
  });

  it("keeps one row per file (the latest status wins) and counts statuses", () => {
    const s = play([
      { type: "file", data: { name: "a.pdf", status: "parsed", detail: "" } },
      { type: "file", data: { name: "b.pdf", status: "quarantined", detail: "unreadable" } },
      { type: "file", data: { name: "a.pdf", status: "uploaded", detail: "new" } },
      { type: "file", data: { name: "c.pdf", status: "duplicate", detail: "same person" } },
    ]);
    expect(s.files.map((f) => `${f.name}:${f.status}`)).toEqual(["a.pdf:uploaded", "b.pdf:quarantined", "c.pdf:duplicate"]);
    expect(s.counts).toEqual({ uploaded: 1, quarantined: 1, duplicate: 1 });
    expect(s.failures).toEqual([{ name: "b.pdf", status: "quarantined", reason: "unreadable" }]);
  });

  it("does not count rejected or duplicate files as failures, but counts skipped and upload_failed", () => {
    const s = play([
      { type: "file", data: { name: "r.pdf", status: "rejected", detail: "JD score 20" } },
      { type: "file", data: { name: "s.zip", status: "skipped", detail: "archive rejected" } },
      { type: "file", data: { name: "u.pdf", status: "upload_failed", detail: "quota" } },
    ]);
    expect(s.failures.map((f) => f.name)).toEqual(["s.zip", "u.pdf"]);
  });

  it("keeps only the last log lines", () => {
    const s = play(Array.from({ length: 12 }, (_, i): CliEvent => ({ type: "log", data: { message: `line ${i}` } })));
    expect(s.logs).toHaveLength(8);
    expect(s.logs[0]).toBe("line 4");
    expect(s.logs.at(-1)).toBe("line 11");
  });

  it("does not mutate the previous state", () => {
    const before = initialState();
    const frozen = JSON.stringify(before);
    reduce(before, { type: "file", data: { name: "a.pdf", status: "parsed", detail: "" } });
    expect(JSON.stringify(before)).toBe(frozen);
  });

  it("follows the sink steps", () => {
    const s = play([
      { type: "commit_started", data: { campaignId: 1, rows: 5 } },
      { type: "commit_preflight", data: { ready: 3, duplicate: 1, conflict: 0, invalid: 1 } },
    ]);
    expect(s.commit).toMatchObject({ status: "running", rows: 5, ready: 3, duplicate: 1, invalid: 1 });
    const done = reduce(s, { type: "commit_done", data: { created: 3, skipped: 2, batchId: 7, idempotencyKey: "k" } });
    expect(done.commit).toMatchObject({ status: "done", created: 3, skipped: 2, batchId: 7, error: null });
    const failed = reduce(s, { type: "commit_failed", data: { stage: "batch", status: 409, message: "conflicts" } });
    expect(failed.commit).toMatchObject({ status: "failed", error: "conflicts" });
  });

  it("finishes on a terminal phase or the result event and records the csv path", () => {
    expect(play([{ type: "phase", data: { phase: "done" } }]).finished).toBe(true);
    const failed = play([{ type: "phase", data: { phase: "failed", detail: "no key" } }]);
    expect(failed).toMatchObject({ finished: true, error: "no key" });
    const result = play([{ type: "result", data: { csvPath: "/x/out.csv", rows: 9, error: null, cancelled: false } }]);
    expect(result).toMatchObject({ finished: true, csvPath: "/x/out.csv", resultRows: 9 });
  });
});

describe("exit codes", () => {
  const finish = (events: CliEvent[]) => exitCodeFor(play(events));
  it("maps outcomes", () => {
    expect(finish([{ type: "phase", data: { phase: "done" } }])).toBe(0);
    expect(finish([{ type: "phase", data: { phase: "failed", detail: "x" } }])).toBe(1);
    expect(finish([{ type: "phase", data: { phase: "cancelled" } }])).toBe(130);
    expect(finish([{ type: "file", data: { name: "a", status: "quarantined", detail: "" } }, { type: "phase", data: { phase: "done" } }])).toBe(3);
    expect(finish([{ type: "commit_failed", data: { stage: "batch", status: null, message: "x" } }, { type: "phase", data: { phase: "done" } }])).toBe(3);
  });
});

describe("formatting", () => {
  it("formats durations, money, tokens and the bar", () => {
    expect(formatDuration(null)).toBe("--");
    expect(formatDuration(5.4)).toBe("5s");
    expect(formatDuration(125)).toBe("2m05s");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.00123)).toBe("$0.0012");
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(25_500)).toBe("25.5k");
    expect(progressBar(0, 0, 10)).toBe("---------- " + "  0%");
    expect(progressBar(5, 10, 10)).toBe("#####----- " + " 50%");
    expect(progressBar(20, 10, 10)).toBe("########## " + "100%");
  });

  it("writes plain lines and a summary that ends with the CSV path", () => {
    expect(formatEvent({ type: "file", data: { name: "a.pdf", status: "parsed", detail: "cached" } })).toBe("[file] parsed        a.pdf  (cached)");
    expect(formatEvent({ type: "result", data: { csvPath: null, rows: 0, error: null, cancelled: false } })).toBeNull();
    const lines = summaryLines(
      play([
        { type: "file", data: { name: "bad.pdf", status: "quarantined", detail: "unreadable" } },
        { type: "progress", data: { done: 2, total: 2, elapsed: 3, eta: 0, stage: "done" } },
        { type: "result", data: { csvPath: "/out/run.csv", rows: 1, error: null, cancelled: false } },
      ]),
    );
    expect(lines[0]).toContain("Run done: 2/2 files");
    expect(lines.join("\n")).toContain("bad.pdf: quarantined - unreadable");
    expect(lines.at(-1)).toBe("CSV: /out/run.csv");
  });
});

describe("Store", () => {
  it("notifies subscribers and stops after unsubscribe", () => {
    const store = new Store();
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.dispatch({ type: "log", data: { message: "a" } });
    off();
    store.dispatch({ type: "log", data: { message: "b" } });
    expect(calls).toBe(1);
    expect(store.getState().logs).toEqual(["a", "b"]);
  });
});
