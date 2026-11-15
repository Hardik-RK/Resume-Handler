# @intake/core: porting notes

TypeScript port of the Python pipeline (`engine/pipeline/*.py` plus the redaction and event-bus parts of `engine/events.py`).
Reference behaviour is pinned by golden fixtures generated from the Python code (see "Proof" below).

## Module map

| TypeScript | Python source | Notes |
| --- | --- | --- |
| `src/types.ts` | `engine/server.py` `RunContext`, pipeline `RunResult`, `_Emitter` | public contract, written first |
| `src/pipeline.ts` | `pipeline/__init__.py` | `runBatch`, `discover`, emitter, worker pools |
| `src/config.ts` | `DEFAULTS`, `resolve_config` | values identical (golden) |
| `src/redact.ts` | `redact`, `_secret_values` | pipeline log-line redaction |
| `src/events.ts` | `engine/events.py` | `redactEvent`, `registerSecret`, `scrub`, `EventBus` (SSE writing stays in the server package) |
| `src/llm.ts` | `pipeline/llm.py` | prompts, strict schemas, normalisers, body builder, `post` (retry/backoff/gate), `Transport` |
| `src/parse.ts` | `pipeline/parse.py` | PDF reading, text-vs-vision routing, fallback model flow |
| `src/jd.ts` | `pipeline/jd.py` | scoring prompt, fail-open verdicts, `passes` |
| `src/names.ts` | `pipeline/names.py` | name heuristics |
| `src/csvout.ts` | `pipeline/csvout.py` | Lead ID, phone E.164, CSV writer (byte-identical), atomic writes, retry list, JD index |
| `src/cache.ts` | `pipeline/cache.py` | append-only JSONL cache |
| `src/zips.ts` | `pipeline/zips.py` | safe unzip with the same limits |
| `src/drive.ts` | `pipeline/drive.py` | `DriveUploader`, credentials, REST client behind `DriveClient` |
| `src/usage.ts` | `_write_usage`, `_metric` | PII-free usage log |
| `src/concurrency.ts` | `_CancelFlag`, `RateGate`, thread pools | `CancelFlag`, `RateGate`, `TaskPool`, `asCompleted` |
| `src/pyish.ts`, `src/pyjson.ts` | n/a | Python semantics the port depends on (truthiness, `float()`, `int()`, `casefold`, `json.dumps` spacing, `difflib` ratio) |
| `src/fake-llm.ts`, `src/fake-drive.ts` | new | deterministic offline provider and in-memory Drive |

## Public API (what the server codes against)

```ts
import { runBatch, resolveConfig, DEFAULTS, redact, createFakeLlm, createFakeDrive } from "@intake/core";
import type { RunContext, RunResult, EventSink, PipelineEvent } from "@intake/core";
```

* `RunContext`: `{ dirs, config, secrets, options, emit, cancelled, http?, drive?, fields? }`.
  `dirs`: `input, output, old, database, logs, cache?`. `config` is the camelCase settings object (see `PipelineConfig`).
  `secrets`: `openrouterApiKey`, `googleTokenJson`. `options`: what `POST /run` validates (`campaignType, platform, jd, parallel, dryRun, jdFilter, jdThreshold, driveFolderId, inputs, commit`).
  `cancelled` is an `AbortSignal` (the server keeps the `AbortController`). `http` (an `HttpClient`) and `drive` (a `DriveClient` or a factory) are the injection points: leave them out in production, pass `createFakeLlm()` and `createFakeDrive()` for keyless runs.
* `emit(event)` receives `{ type, data }` where `data` is exactly the Python `emit(kind, **data)` payload (`phase`, `log`, `file`, `progress`, `cost`). The server adds `id` and `ts` (`WireEvent`) via `EventBus.publish(type, data)`.
* `RunResult`: `rows, csvPath, counts, cost, failedFiles, cancelled, error, retryPath, runId, processed` (paths are strings, `null` when absent).
* `runBatch` never rejects: an unexpected exception becomes a `failed` phase and `error = "unexpected error in the pipeline (<ErrorName>)"`.

## Dropped (and why)

* `parsers/openai_parser.py`: replaced by `pipeline/llm.py` in the reference too; only the live `pipeline/llm.py` copy was ported.
* `crm_commit.py`, settings store, auth, signing, server, updater, installer, launcher, single-instance lock, DPAPI/keyring: out of scope for core (server package or dropped per the shared rules).
* `pipeline/__init__.py` `EXAMPLE_KEY_MAP` / `EXAMPLE_KEY_EXCEPTIONS`: only existed to compare DEFAULTS with the reference `config.example.json`; the golden `defaults.json` pins the values instead.
* `load_fields()` reading `fields.json` next to the engine (and the `sys._MEIPASS` bundle lookup): the file is not part of the reference tree and the compact prompt and schema never use the field list. `ctx.fields` is optional and only feeds the `legacy` prompt mode.
* pdfplumber fallback and the markdown converter (see deviations). No DOCX: the Python only accepts PDF, zip and roster files, so no DOCX reader was added.
* Roster matching: roster files (`.xlsx`, `.csv`) are discovered and reported, never processed, as before.
* The Python `requests.Session` pooling: `fetch` pools connections itself.
* `Counter` objects, dataclass helpers and `__all__`.

## Deliberate deviations

1. **PDF text extraction.** pymupdf4llm/PyMuPDF/pdfplumber (AGPL, native) became `unpdf` (pdf.js, MIT/Apache) for text, links and image detection, and `@napi-rs/canvas` (MIT, prebuilt native binary) for page rendering. Text is plain lines, not markdown; the name heuristics already strip markdown. Raw text length differs by a few characters from PyMuPDF on the same file but lands on the same side of the 200-character threshold on every fixture. Hybrid/scan routing, link harvesting and contact recovery are identical on every fixture. `@napi-rs/canvas` is the only non-pure-JS dependency; `PdfDoc.render` is the single place that uses it.
2. **Environment variable** `RESUME_EXTRACT_ATS` is now `INTAKE_EXTRACT_ATS`. The OpenRouter `user` tag prefix `resume-uploader:` is now `resume-intake:`. The default cache folder is `<APPDATA or home>/ResumeIntake/cache` (only used when `dirs.cache` is absent); temp work folder prefix is `intake_resume_`.
3. **Zip hardening beyond the reference:** entries are CRC-checked (`BadZipFile` skip reason, as Python's `zipfile` does on a full read; skipped on Node without `zlib.crc32`), declared sizes are validated while streaming (`yauzl`), and entry names are decoded raw (UTF-8 if flagged, else CP437) so that `../x` names never fail the archive; only the basename is a label, files are stored by hash.
4. **Cache hardening:** an append after a torn last line starts on a new line (the reference glued the new record onto the torn one, losing it on the next load).
5. **Timeouts:** the reference used `(connect, read)` socket timeouts; `fetch` has one timer, so the per-attempt read timeout is a total-response timeout and `connectTimeoutMs` is passed to custom clients only. In-flight requests are not aborted on cancel (same as the reference: a finished call is still cached); waits and retries are interrupted immediately.
6. **Number formatting:** JSON cannot tell `5.0` from `5`, so a float-valued cell such as `Team size` prints `5` where Python printed `5.0`. Everything else in the CSV is byte-identical (golden), including Python `csv` quoting (a lone `\r` is quoted on Python 3.14) and `json.dumps` spacing inside list/object cells.
7. **Python `\d`/`\s` Unicode semantics** are kept where cheap (`digitsOnly`, name tokens); the phone/email regexes use ASCII `\d` in JS.
8. **File discovery order** is a plain string sort of full paths (Python sorted `Path` objects, which is case-insensitive on Windows only).

## Reference quirks kept on purpose (flag for the lead)

These are faithful ports, pinned by golden tests, and probably deserve a decision before publishing:

* `asList` splits strings on `[;,|\\n]` written as a raw string in Python, i.e. on `; , | \` **and the letter `n`**, not on newlines (`LIST_SPLIT` in `llm.ts`). It only matters when the model returns a string for a list field, which the strict schema prevents. One-line fix: `/[;,|\n]+/`. Golden `llm-helpers.json` (`asList`, `normalise`) would then need regeneration after the Python is fixed too.
* In the compact prompt, `campaign_type` falls back to the phrase "the selected campaign", so with no campaign type the "Role fields in scope" list is empty (`Role fields in scope: .`).
* `jdThreshold: 0` in the run options is replaced by the configured threshold (`int(0 or cfg)`), as in Python.
* A name-only quality problem is repaired from the text without a second call; a fallback row replaces the primary only when it has no more issues.

## Proof: golden tests against the Python reference

`scripts/gen-golden.py` imports the reference modules, feeds them synthetic inputs and writes `test/golden/*.json` and the small fixtures under `test/fixtures` (PDFs made with PyMuPDF, zips made with `zipfile`).
Regenerate with the reference's interpreter in isolated mode:

```
python -I scripts/gen-golden.py --reference <reference folder> --out test/golden --fixtures test/fixtures
```

What is pinned (all assertions compare the TypeScript output with the recorded Python output): names (30 texts), identity keys, 39 phone formats (E.164 matches `phonenumbers`), CSV text, `DEFAULTS`, both redactors, cache keys, 14 prompt and schema configs, 64 request bodies, 25 normaliser cases, phone recovery, snapping, validation, JSON extraction, `difflib` ratios, usage accounting, 16 scripted transport flows (retry, back-off, truncation budget bump, 429 gate, quota, network errors), 22 scripted `extract_resume` flows (fallback, vision, merge, errors), 15 JD flows, 15 zip cases (bombs, ratios, totals, CRC, traversal names), 8 PDFs through the reader, and 12 whole-pipeline runs (CSV bytes, counts, events, cost, usage log, retry list, JD index, cache).
The ported pytest cases (`test_pipeline.py`, `test_units.py`, `test_events.py`, `test_extraction_guards.py`, `test_names.py`, `test_mock_contract.py`, the parser checks in `test_request_parity.py`) are in `test/*.test.ts` next to them. Cases that compared against the removed legacy parser module are replaced by the golden comparison with `llm.py` itself.

Run: `npm test` (vitest) and `npm run typecheck` (`tsc --noEmit`, strict).

## Not verified

* Real Google Drive and a real provider: only the fake Drive, the fake provider and a `fetch`-stub REST test were exercised. The resumable-upload request shapes follow the Drive v3 documentation.
* Token refresh against Google's real token endpoint.
* Scanned-PDF rendering was verified for PNG validity, DPI scaling and an opaque white background, not for model accuracy.
* Behaviour on Node 20.0 to 20.14 (`zlib.crc32` is skipped there; developed and tested on Node 24).
