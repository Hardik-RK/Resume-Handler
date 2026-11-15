# @intake/server: porting notes

Port of the reference Python engine's HTTP layer (`server.py`, `events.py` framing, `auth.py`, `settings_store.py`,
`crm_commit.py`, `paths.py`) to TypeScript on `node:http`. No runtime dependencies besides `@intake/core`.

Run: `npm start` (tsx), `npm test` (vitest), `npm run typecheck`. Configuration is environment only, see `src/config.ts`.

## Module map

| TypeScript | Reference | Notes |
| --- | --- | --- |
| `src/http.ts` | `server.py` (`EngineHandler`, routes, SSE) | same routes, status codes, messages and JSON shapes |
| `src/engine.ts` | `server.py` (`Engine`, `validate_run_options`, run worker) | one run at a time, pipeline-end interception, archive to `processed/` |
| `src/uploads.ts` | `server.py` (name rules, limits, streaming multipart, zip listing) | hand written streaming parser, same algorithm; central-directory zip reader instead of `zipfile` |
| `src/auth.ts` | `auth.py` | Ed25519 verify, bearer parsing, origin rules; adds `none` and `token` modes |
| `src/settings-store.ts` | `settings_store.py` | config store, secret store, URL validators; secrets in an AES-256-GCM vault |
| `src/sink-commit.ts` | `crm_commit.py` | generic ingestion sink; JSON field names unchanged |
| `src/paths.ts` | `paths.py` | `INTAKE_DATA_DIR`, no Windows folders |
| `src/events.ts` | `events.py` | thin re-export: the bus and redaction live in `@intake/core`; the SSE framing is in `http.ts` |
| `src/static.ts`, `src/config.ts`, `src/logger.ts`, `src/main.ts`, `src/index.ts` | new | web UI hosting, env config, redacted logger, entry point, public API |

## Contract with the web UI

Every route and JSON shape the two hooks use is unchanged (`GET /hello`, `GET /state`, `POST /settings`, `GET|POST /files`,
`DELETE /files/<name>`, `POST /run`, `POST /cancel`, `POST /commit/retry`, `GET /events`, `GET /results`, `GET /results.csv`,
`POST /open`, `POST /shutdown`). Files are uploaded as multipart/form-data with one `files` field per request.
`/events` accepts the token in the query (`?token=`) and `lastEventId`; frames are `id`, `event`, `data={id,type,ts,data}`.

Deviations the web package must know about:

- `/hello.app` is `resume-intake` (the original id was product branded). `/hello` also carries `auth` (`none`|`token`|`signed`),
  so the page can decide whether to ask for a token. `updateInProgress` is gone from `/hello` and `/state` (no updater).
- `/state.secretStore` is `vault` or `memory` (was `keyring`/`dpapi`/`memory`).
- Token modes: `signed` (Ed25519 session token from a downstream issuer, claims `aud`, `role`, `exp`; audience default
  `resume-intake`, role default `admin`, both configurable), `token` (static bearer from `INTAKE_TOKEN`), `none` (no
  credentials, loopback only). In `token` mode the page itself is served without credentials; the API is not.
- The 401 message is `Missing, expired or invalid access token.` (was `... uploader token.`).
- The ingestion idempotency key prefix is `intake-` (was `uploader-`); the 32 hex digits are byte for byte the reference's.
  The default `commit.source` is `Resume intake`.
- `lastRun.detail` is also set when a run ends `failed` through the pipeline's own error (the reference only put it in the
  final `phase` event), so the page's `/state` polling fallback can show it.
- Read-only deployments: `POST /open` answers 501 unless the opener is enabled (default on for `none` auth only);
  `POST /shutdown` answers 403 unless enabled (same default).
- Same-origin is always an allowed origin (the page served from this server), besides the configured origin list.
  `Host` is checked against the loopback names in `none` mode; in hosted modes only when `INTAKE_ALLOWED_HOSTS` is set.

## Dropped, and why

| Dropped | Reason |
| --- | --- |
| `/update/check`, `/update/apply`, `updater.py`, `update` events, `version-swap` logic | auto-update is out of scope; the page's update banner has nothing to talk to |
| `installer.py`, `launcher.py`, `single_instance.py`, `__main__.py` | desktop packaging; the server is started with `npm start` or by the CLI package |
| Windows DPAPI vault and `keyring` backend | replaced by the AES-256-GCM vault (`INTAKE_SECRETS_KEY` or a 0600 key file) |
| `known_documents_folder()`, `%APPDATA%` / `%LOCALAPPDATA%` / program folder logic | replaced by `INTAKE_DATA_DIR` and `INTAKE_CONFIG_DIR` |
| `set_pipeline_runner` test hook, `importlib` loading of `engine.pipeline` | the runner is an injectable `EngineOptions.runner`; the default lazily imports `@intake/core` and keeps the 503 path |
| `_jsonable` | results are already JSON values |
| `HTTP/1.0` one request per connection, `ThreadingHTTPServer` | `node:http` keep-alive; an unread large request body gets `Connection: close` instead |
| Default allowed origins naming the original product's hosts | defaults are the loopback dev origins plus the page's own origin |
| the reference's product-prefixed env variables | `INTAKE_*` |

Kept behind a flag: `POST /open` (local mode only, OS file manager via `explorer.exe` / `open` / `xdg-open`).

## Behaviour notes

- Error wording that the page shows still says "CRM" (a generic word; the UI texts do too). Internal names say "sink".
- Settings validation is ported with a hand written `urlsplit` equivalent, because the reference returns the netloc as typed
  (`https://App.Example:443` stays as typed) and the WHATWG `URL` would normalise it. All 43 URL cases agree with Python.
- `identityKey` uses `\p{Nd}` because Python's `\D` is Unicode aware. The idempotency key's canonical JSON is ASCII only
  (`ensure_ascii`) and sorts keys by code point, like Python.
- Token verification is stricter than the reference in one corner: a payload whose JSON holds `NaN` as `exp` is refused
  (Python's `json.loads` accepts it and `nan < now` is false). Not covered by the golden file.
- The run's `cache` folder is `<data>/.cache` (the reference used a per-user folder), so a hosted instance keeps everything
  under one data folder.
- The run is asynchronous in-process: `ctx.cancelled` is an `AbortSignal`; a CPU-bound `runBatch` shares the event loop with
  the HTTP server (core awaits I/O throughout, so the page stays responsive).
- Secrets: never logged (the logger redacts every line, the query token is not logged), never in events, `config.json` or
  responses (`/settings` answers only which secrets are set). The vault binds each ciphertext to its name (GCM AAD).

## Tests

`npm test`: 8 files, 495 tests, no network beyond loopback, ephemeral ports, temp folders.

| File | Covers | Reference |
| --- | --- | --- |
| `auth.test.ts` | token verification (35 golden cases), bearer, origins, the three modes | `test_handshake`, `test_signing` (token part) |
| `handshake.test.ts` | token/origin/host rules over HTTP, CORS, preflight, all three auth modes | `test_handshake` |
| `settings.test.ts` | golden URL rules (43 x 2), golden secret rules, golden `apply()` sequence and masking, vault, key file, atomic writes | `test_settings`, `test_settings_rules` |
| `uploads.test.ts` | golden name sanitising (35), upload, collisions, limits, delete traversal, zip listing, streaming parser | `test_uploads`, `test_file_limits` |
| `sink-commit.test.ts` | golden parse/items/identity/idempotency, preflight statuses, READY-only, retry, token secrecy, archive | `test_crm_commit` |
| `runs.test.ts` | run lifecycle, cancel, failure redaction, options, results, SSE, event bus, golden redaction, shutdown, `/open` | `test_runs`, `test_events` |
| `server.test.ts` | env config, packaged entry, static UI, a browser-style session (fetch, FormData, SSE) | new |
| `integration.test.ts` | the real `@intake/core` pipeline with the fake LLM and fake Drive behind the server | new |

Golden fixtures: `test/golden/generate.py <reference folder>` runs the Python reference on synthetic inputs and writes
`test/golden/fixtures.json` (committed). Not ported: `test_installer`, `test_launcher`, `test_swap`, `test_updater`,
`test_single_instance`, `test_paths` (all about dropped Windows packaging), and `test_signing` (it signs release files for the
updater; the token half is covered above).

Not verified: running behind a real reverse proxy, TLS (terminate it in front), more than 10 simultaneous event streams, and
macOS/Linux (developed and tested on Windows; file modes of the secret files are asserted only on POSIX).

## Addition: `GET /settings` (deliberate, not in the reference)

The Python engine had no route to read settings back because they lived in the downstream system's own database. This server
is the only place they live, so the page needs one. `GET /settings` (bearer protected like the rest) returns
`{config, secrets: {<name>: {set: boolean}}, secretsReady: boolean}`: `config` is the saved non-secret config as stored
(`campaigns`, `platforms`, `campaignTypes`, `crmBaseUrl`, ...), `secrets` is presence only (no value and no hint is ever
returned; `hint` is deliberately omitted), `secretsReady` is true when an encrypted vault backs the secrets. `GET /state`
carries the same `config`, `secrets` and `secretsReady` fields. `POST /settings` now also validates `campaigns`
(up to 500 of `{id, name, group?, type?, driveFolderId?}`, 422 otherwise) and `platforms` / `campaignTypes` (up to 200 names, as
text or `{name}`). Tests: `test/settings-read.test.ts`.
