# cli: porting notes

New package. The Python engine had a PySide desktop window and a launcher; neither is ported. This package replaces them with a terminal UI and a thin window launcher.

## Ported
- `src/sink.ts` is the commit logic of the Python `crm_commit.py` with generic names: item building (rows without a name or a contact are left out), identity key (email, else phone digits, else lead id), idempotency key (`intake-` plus 32 hex digits of the sha256 of the compact, key-sorted, ASCII-escaped JSON of campaign and sorted identities; golden values taken from the Python formula are in `test/sink.test.ts`), preflight then batch with READY rows only, fixed failure sentences by HTTP status, no server bodies echoed, redirects refused, base URL check (https, or http for loopback).
- Event shapes (`phase`, `file`, `progress`, `cost`, `log`, and the `commit_*` events) are the ones the pipeline and committer emit; the reducer in `src/progress.ts` consumes them.

## Dropped, with reasons
- GUI, tray, launcher, single-instance lock, updater, installer: desktop-only concerns.
- The committer's retry state (`_last_batch` replay): the CLI is one process per run. A rerun of the same input sends the same idempotency key, so the sink replays it.
- Settings store and secrets vault: the CLI reads secrets from the environment (`INTAKE_OPENROUTER_API_KEY`, `INTAKE_SINK_TOKEN`) and never writes them anywhere.
- Roster files, Drive OAuth flow: not part of the web edition either.

## Added
- `intake run` (Ink live display, `--plain` and `--json` for non-interactive use), `intake serve`, `intake app`.
- `--dry-run` means: JD scoring keeps everyone (the core option of the same name) and the sink gets a preflight only, nothing is committed.
- `--mint-token` asks a mock CRM for a demo session token; `--campaign "<name>"` finds the sink campaign id by name.
- Each run gets its own folder under the working folder (`runs/<timestamp>`), inputs are copied in (originals untouched), the parse cache is shared across runs.
- `intake app` is the thin native-window option: Edge or Chrome started with `--app=URL`. No Electron.

## Exit codes
0 success, 1 run failed (or sink lookup failed before the run), 2 bad usage or missing input/key, 3 finished but some files failed or the commit failed, 130 cancelled.

## Contract deviations
See the final report: `src/core.ts` is the only file that touches `@intake/core`.

## Demo helpers
- `intake fake-llm` serves core's fake provider over loopback HTTP, because the server only accepts the real provider or `http://127.0.0.1:<port>` as `llmBaseUrl`.
- `intake connect` mints a demo token, reads the mock CRM's campaigns and pushes CRM address, campaigns, ingestion token and (optionally) the fake LLM address to the server's `POST /settings`.
- `src/core.ts` is `export * from "@intake/core"`; core is loaded lazily so `intake help` stays fast.
- TypeScript is `^7.0.2` like core: core's source type-checks with it (TS 5 rejected a literal U+2028 in a regex at the time of writing, since fixed in core).
