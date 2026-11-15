# mock-crm: porting notes

New package, not a port of a running service. It re-creates just enough of the downstream ingestion API for demos and tests.

## What it mirrors
| Source | Here |
| --- | --- |
| Ingestion service: item normalisation (`email`/`phone` aliases, CSV column names, derived lead id, phone key = last 10 digits) | `src/ingestion.ts` `normalizeItem` |
| Preflight statuses `READY`, `DUPLICATE`, `CONFLICT`, `ERROR` (`BLOCKED` and `REJECTED` exist in the status type but are never produced: no blacklist or ATS in the demo) | `CrmStore.preflight` |
| Duplicate detection by lead id, email and phone key, inside one batch and against stored applications for the same campaign | `CrmStore.classify` |
| Identity conflict (identifiers pointing at different profiles) answers 409 on batch | `CrmStore.commitBatch` |
| Batch: key required (max 200 chars), same key + same payload replays (`replayed: true`), same key + different payload 409, any non-READY row means 422 and nothing is imported | `CrmStore.commitBatch` |
| Max batch 1000 (413) | `MAX_BATCH_SIZE` |
| Token minting: `base64url(claims) "." base64url(Ed25519 signature over the payload text)`, claims `{aud, sub, role, iat, exp}` | `src/tokens.ts` |

## Dropped, with reasons
- SQLite and the full schema (profiles, identifiers, audit events, role fields, recruiter assignment, split overrides): an in-memory store is enough for a demo, and it keeps the package install small.
- Blacklist, ATS rejection, recruiter and client assignment, role-specific fields: not exercised by the intake tool.
- Token hashing and revocation, admin session: the demo token endpoint is deliberately unauthenticated and the key pair lives only as long as the process.
- Campaign/company names from the source: replaced with generic `Backend Engineer`, `Teacher`, `Sales` (plus an archived `Operations Analyst` to exercise the archived-campaign error).

## Choices worth knowing
- Token audience is `resume-intake` (the server's `DEFAULT_AUDIENCE`), role `admin`.
- The same signed token is accepted on the ingestion routes, so the demo needs one token for both the web page and the sink. A static token can also be set with `MOCK_CRM_INGESTION_TOKEN`; `MOCK_CRM_OPEN=1` turns auth off.
- The DEMO public key is written to `demo-data/public_key.pem` at startup and served at `/.well-known/public-key.pem` and `/api/uploader/public-key`.
- CORS is open (`*`) because this is a local demo stand-in.

## Fixtures (`fixtures/`)
Ported in spirit from the Python batch maker used for manual testing: seeded RNG, fictional names, `example.com` emails.
Differences: contact numbers use the UK drama range `+44 7700 900000-900999` (reserved for fiction), file names and templates are generic, and the generator is async TypeScript (`pdf-lib` for text PDFs, `@napi-rs/canvas` to draw scanned-style image-only PDFs, `fflate` for zips). New kinds: scanned pages, duplicate people under new file names, one corrupt PDF. A `manifest.json` records the ground truth per file.

## Not verified
- Scanned PDFs render with the system `sans-serif` font; on a machine with no fonts the text would be blank.
- The fake LLM in core has to extract from these PDFs; that pairing is checked by the CLI end-to-end test, not here.
