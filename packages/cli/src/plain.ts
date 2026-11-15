import { FAILURE_STATUSES, formatDuration, formatTokens, formatUsd, type CliEvent, type ProgressState } from "./progress.ts";

/** One line of text per event for non-interactive output; null for events that add nothing (progress is shown on change only). */
export function formatEvent(event: CliEvent): string | null {
  switch (event.type) {
    case "phase":
      return `[phase] ${event.data.phase}${event.data.detail ? ` - ${event.data.detail}` : ""}${typeof event.data.total === "number" ? ` (${event.data.total} files)` : ""}`;
    case "file":
      return `[file] ${event.data.status.padEnd(13)} ${event.data.name}${event.data.detail ? `  (${event.data.detail})` : ""}`;
    case "progress":
      return `[progress] ${event.data.done}/${event.data.total} ${event.data.stage} elapsed ${formatDuration(event.data.elapsed)} eta ${formatDuration(event.data.eta)}`;
    case "cost":
      return `[cost] ${formatTokens(event.data.tokens)} tokens, ${formatUsd(event.data.usd)}`;
    case "log":
      return `[log] ${event.data.message}`;
    case "commit_started":
      return `[sink] ${event.data.dryRun ? "dry run: preflight only for" : "committing"} ${event.data.rows} row(s) to campaign ${event.data.campaignId}`;
    case "commit_preflight":
      return `[sink] preflight: ${event.data.ready} ready, ${event.data.duplicate} duplicate, ${event.data.conflict} conflict, ${event.data.invalid} invalid`;
    case "commit_done":
      return `[sink] done: ${event.data.created} created, ${event.data.skipped} skipped${event.data.batchId !== null ? `, batch ${event.data.batchId}` : ""}`;
    case "commit_failed":
      return `[sink] FAILED at ${event.data.stage}${event.data.status ? ` (HTTP ${event.data.status})` : ""}: ${event.data.message}`;
    case "result":
      return null;
  }
}

/** The closing summary, printed after the live display ends. The CSV path is always the last line when there is one. */
export function summaryLines(state: ProgressState): string[] {
  const lines: string[] = [];
  const status = state.cancelled ? "cancelled" : state.error || state.phase === "failed" ? "failed" : "done";
  lines.push(`Run ${status}: ${state.done}/${state.total} files read, ${state.resultRows} row(s), ${formatTokens(state.tokens)} tokens, ${formatUsd(state.usd)}, ${formatDuration(state.elapsed)}`);
  const counts = Object.entries(state.counts).map(([k, v]) => `${v} ${k}`);
  if (counts.length) lines.push(`Files: ${counts.join(", ")}`);
  if (state.error) lines.push(`Error: ${state.error}`);
  if (state.failures.length) {
    lines.push(`Failed files (${state.failures.length}):`);
    for (const f of state.failures) lines.push(`  ${f.name}: ${f.status}${f.reason ? ` - ${f.reason}` : ""}`);
  }
  const c = state.commit;
  if (c) {
    if (c.status === "done") {
      lines.push(c.dryRun
        ? `Sink (dry run): ${c.ready} ready, ${c.duplicate} duplicate, ${c.conflict} conflict, ${c.invalid} invalid; nothing committed`
        : `Sink: ${c.created} created, ${c.skipped} skipped (${c.duplicate} duplicate, ${c.conflict} conflict, ${c.invalid} invalid)${c.batchId !== null ? `, batch ${c.batchId}` : ""}`);
    } else if (c.status === "failed") lines.push(`Sink: failed - ${c.error}`);
  }
  if (state.csvPath) lines.push(`CSV: ${state.csvPath}`);
  return lines;
}

export { FAILURE_STATUSES };
