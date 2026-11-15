# Running the whole demo

Everything runs offline on one machine, with no API keys: a synthetic résumé batch, a fake LLM, a mock downstream system (the "CRM") and the real server, web page and CLI.

Ports used: mock CRM `47900`; the server takes the first free port from `47831`.

## 0. One-time setup

Each package installs on its own (there is no root install; see docs/ARCHITECTURE.md). From the repo root:

```bash
npm run install:all   # npm ci in every package, dependency order
npm run build         # builds packages/web into packages/web/dist, which the server serves
```

Shortcut: `npm run demo` does steps 1 to 4 below in one go (fixtures, mock CRM, server in signed mode, connect) and prints the address and a session token. Ctrl-C stops it.

## 1. Make the fixture batch

```bash
cd packages/mock-crm
npm run fixtures -- ../../demo-fixtures --count 12 --seed 2026
```

This writes `demo-fixtures/batch-backend-12.zip`, the same files unpacked in `demo-fixtures/resumes/`, and `manifest.json` (what each file really contains). The batch holds 12 fictional candidates (names are made up, emails are `@example.com`, phones are in the UK drama range `+44 7700 900xxx`), two scanned-style image PDFs, two duplicate people under new file names, and one corrupt file. Use `--campaign teacher` or `--campaign sales` for the other flavours.

## 2. Start the mock CRM

Terminal A:

```bash
cd packages/mock-crm
npm start
```

It listens on http://127.0.0.1:47900, generates a DEMO Ed25519 key pair, writes the public key to `packages/mock-crm/demo-data/public_key.pem`, and serves:

| Route | Purpose |
| --- | --- |
| `GET /` | candidates and campaigns page (refreshes every 5 s) |
| `POST /api/uploader/token` | mints a signed session token (`{"ttlSeconds": 86400}` for a day) |
| `GET /.well-known/public-key.pem` | the public key |
| `GET /api/ingestion/campaigns`, `POST /api/ingestion/preflight`, `POST /api/ingestion/batch` | the ingestion API (bearer token required) |
| `POST /api/admin/reset` | empty the store between demos |

## 3. Start the server in `signed` mode against the mock CRM

Terminal B. `intake serve --fake` runs the server package in-process with the offline model and an in-memory Drive, so no keys are needed. Auth is chosen by the server's own environment:

```bash
cd packages/cli
INTAKE_AUTH=signed INTAKE_PUBLIC_KEY_FILE=../mock-crm/demo-data/public_key.pem node bin/intake.mjs serve --fake --no-open
```

PowerShell:

```powershell
cd packages/cli
$env:INTAKE_AUTH='signed'; $env:INTAKE_PUBLIC_KEY_FILE='../mock-crm/demo-data/public_key.pem'; node bin/intake.mjs serve --fake --no-open
```

It prints its address (the first free port from 47831, or pass `--port N`; another program may already hold 47831, which the CLI ignores because it checks that `/hello` reports `app: resume-intake`). In `signed` mode every route except `GET /hello` and the page itself needs `Authorization: Bearer <token>`; the token is signed by the mock CRM's private key and carries `aud: resume-intake`, `role: admin` and an expiry. The server holds only the public key.

To run the real server with a real model instead, drop `--fake` (the CLI starts `packages/server` as a child process) and set the model key in the page's settings.

## 4. Connect the server to the CRM

Terminal C:

```bash
cd packages/cli
node bin/intake.mjs connect          # add --server http://127.0.0.1:<port> if the server is not on the default range
```

This mints a token, reads the CRM's campaigns, and pushes the settings the page needs to the server (CRM address, campaign list, the ingestion token). It prints the session token.

## 5. Use the web page

Open the address printed in step 3 (for example http://127.0.0.1:47831) in a browser, or as a standalone window:

```bash
node bin/intake.mjs app          # Edge or Chrome in --app mode, no tabs or address bar
```

The page asks for a token because the server is in `signed` mode: paste the token printed in step 4. Then:

1. Drop `demo-fixtures/batch-backend-12.zip` on the upload area.
2. Choose the campaign *Backend Engineer* (the campaign type fills in), pick a source such as *LinkedIn*, and leave "Commit rows" on.
3. Start the run and watch the files, progress and cost update live. The corrupt file shows up as a failure; the duplicate people are reported as duplicates; the scanned PDFs go through the vision path (the fake provider answers them with empty fields, so those rows have little data, which is the expected "needs a human" case).
4. Open http://127.0.0.1:47900. The candidates are there, once each, in campaign *Backend Engineer*.

Run the same batch again: the sink reports every row as a duplicate and creates nothing. A retry of the same run sends the same idempotency key, so the CRM replays instead of duplicating.

## 6. The same thing from the terminal

No server needed for the first command, no keys, fully offline:

```bash
cd packages/cli
node bin/intake.mjs run ../../demo-fixtures/batch-backend-12.zip --fake --campaign "Backend Engineer"
```

You get a live display (files read, tokens and cost so far, per-file status, failures) and, at the end, the path of the CSV. Add `--plain` for line-by-line output or `--json` for one event per line.

Commit to the mock CRM (it must be running; reset it first with `curl -X POST http://127.0.0.1:47900/api/admin/reset` if you used the web page):

```bash
node bin/intake.mjs run ../../demo-fixtures/batch-backend-12.zip --fake \
  --campaign "Backend Engineer" --sink http://127.0.0.1:47900 --mint-token
```

`--mint-token` asks the mock CRM for a session token; against any other sink use `INTAKE_SINK_TOKEN`. `--dry-run` preflights only (it shows what would be created and commits nothing).

Exit codes: `0` success, `1` the run failed, `2` bad usage or missing input, `3` finished but some files failed or the commit failed (the demo batch ends with `3` because of the corrupt file), `130` cancelled.

## Other ways to open the UI

- `intake serve` starts the server package for you (default `none` auth, loopback only) and opens the browser; add `--fake` for the offline model.
- `intake app --serve [--fake]` does the same and opens the standalone window.
- `intake fake-llm` serves the offline model over loopback HTTP, for pointing a separately started server at it (`llmBaseUrl`).

## Troubleshooting

- **The page keeps asking for a token or answers 401**: the server was started without the CRM's current public key. The key pair is regenerated every time the mock CRM starts, so restart the server after restarting the CRM, then run `intake connect` again.
- **`intake connect` says no server found**: start the server first, or pass `--server http://127.0.0.1:<port>`.
- **Port in use**: `MOCK_CRM_PORT` changes the CRM's port; `--port N` (or `INTAKE_PORT`) the server's. Pass the matching `--crm` and `--server` to `intake connect`.
- **Scanned PDFs render blank**: the fixture generator draws text with the system sans-serif font; a machine with no fonts installed would produce empty pages.
