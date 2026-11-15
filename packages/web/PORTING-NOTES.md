# @intake/web: porting notes

Standalone Vite + React 18 + TypeScript port of the CRM's résumé-upload page. Same component structure, behaviour, markup and
CSS rules; no CRM shell. `npm run build` (typecheck + Vite) writes `dist/`, which `@intake/server` serves at `/`.

Scripts: `npm run dev` (Vite, proxies the API to `INTAKE_SERVER`, default `http://127.0.0.1:47831`), `npm run dev:mock`
(`dev/mock-server.ts`, scenarios `default|nosink|auth|commit-fail`), `npm test` (vitest, 46 tests), `npm run shots`
(Playwright + installed Edge, screenshots in `dev/shots/`, fails on console errors)

## Module map

| TypeScript | Original (CRM) | Notes |
| --- | --- | --- |
| `src/use-resume-engine.ts` | `use-resume-engine.js` | connection, event stream, runs; phases `checking, connecting, ready, unreachable, unauthorized, error` |
| `src/run-state.ts` | inside `use-resume-engine.js` | the pure part: event reducer, `normaliseCommit`, commit line |
| `src/use-batch-queue.ts` | `use-batch-queue.js` | the queue hook; pure parts in `src/queue-logic.ts` |
| `src/upload-form.tsx` | `upload-form.jsx` | drop tray, form, repeat-campaign confirmation lock, orphan notice |
| `src/activity-list.tsx` | `activity-list.jsx` | queue entries, rows dialog, commit summary |
| `src/header-actions.tsx`, `run-settings.tsx`, `settings-dialog.tsx` | same names | |
| `src/runs-history.tsx` + `src/history.ts` | `runs-history.jsx` | see below |
| `src/resume-upload-view.tsx` | `resume-upload-view.jsx` (+ `uploader-runtime.jsx`) | includes the top bar (title, actions, theme toggle) |
| `src/state-panels.tsx` | `install-panel.jsx` (`ConnectingPanel`) | connecting, server not reachable, access token needed |
| `src/lib/api.ts` | `lib/uploader-engine.js` + `lib/api.js` | same-origin calls to the server's routes |
| `src/format.ts` | `format.js` | plus campaign line parsing |
| `src/ds/*` | `components/ds/*`, `campaigns/crumbs.jsx` | icon sprite (only the 13 icons used), LED number, dialog, dot track, empty panel, toast, popover, crumb menu, menu glide |
| `src/styles/design.css`, `page.css` | `design.css`, `pages.css`, `overrides.css` | filtered copy, see below |

## CSS

Generated once by a script that parsed the three CRM stylesheets and kept only rules whose class names the page's sources use
(plus the shell classes of the top bar), dropping sidebar/flyout rules and unused keyframes; then dead comments were removed.
Light and dark tokens, the Bitcount Grid Single LED face (`src/styles/bitcount-grid-single-latin.woff2`) and the dot-matrix
classes are kept. Fonts: Inter Tight and JetBrains Mono from `@fontsource-variable` (no network at run time).
Added: `--rail: 8px` (no sidebar). Theme is the `dark` class on `<html>` (`intake-theme` in localStorage, system preference otherwise).

## Dropped, and why

| Dropped | Reason |
| --- | --- |
| Install panel, "Start the engine" protocol launch, installer download/checksum, engine discovery on ports 47831-47840, local-network-blocked hint | no desktop exe; the page talks to its own origin |
| Engine update banner, `UpdateProgress`, `update` events, version compare, manifest fetch | no updater |
| `/api/uploader/session` token minting, `pushSettings` after connect, `ensureCommitTarget`, `mintIngestionToken`, "Reconnect and retry" with a new token | the server owns settings and the sink token; a refused token says "replace it in Settings" |
| `settingsLoaded === false` gate on the queue and its notice | the server decides whether a run can start |
| Owner / admin roles (`canEdit`, `canEditLimited`, `canSeeCosts`, owners list, read-only settings view) | no accounts; everything is editable, costs always shown |
| `/api/uploader/runs` report and `/api/uploader/history` | replaced by a browser-local history (below) |
| Campaign list and breadcrumb from the CRM (`/api/campaigns`, hold toggle, company grouping, per-campaign Drive folder creation) | campaigns come from `config.campaigns`; optional group, type and Drive folder per entry |
| "Open campaign" link, CRM page chrome, sidebar, sidebar LED (`uploader-led.jsx`), cross-page toast and runtime provider (`uploader-runtime.jsx`) | no CRM shell; one page, so hooks live in the view. A running upload shows in the tab title instead of the sidebar light |
| Google-token notice and Drive pill when no campaign names a Drive folder | Drive is optional now |
| Per-user parallel setting key | no accounts; one key per browser |

## Standalone changes

- **History** is kept in this browser (`resume-intake-history-v1`, last 200 uploads); spend panels are computed from it; "By" column and
  per-person split dropped.
- **Campaigns / sources / types** come from the server settings: `config.campaigns` (`{id, name, group?, type?, driveFolderId?}`),
  `config.platforms`, `config.campaignTypes`. The settings dialog edits campaigns as lines `id, name, group, type, folder`.
  The commit switch is disabled when `/state.commit.configured` is false (CSV only); the campaign is required only when committing.
- **Auth**: token from `#token=...` in the address (kept in `sessionStorage`, removed from the bar) or typed in the "Access token needed" panel
  (shown on a 401); sent as bearer, and as `?token=` on `/events`. Only 401 means "sign in"; a 403 from `/open` shows the server's message.
- Dialogs render into `<body>` (a dialog opened from the glass top bar was otherwise confined to it by `backdrop-filter`).
- Default commit source sent: `Resume intake` (matches the server default); campaign ids that are digits are sent as numbers.
- User-visible "engine" became "server"; "Add to CRM" became "Commit rows".

## Contract deviations / needs from the server

- **Settings are not readable.** The server has no `GET /settings`, and `/state` carries no config, so the page cannot show the saved
  campaigns, sources or types after a reload. `api.getSettings()` calls `GET /settings` (answer `{config, secrets: {name: {set, hint?}}, secretsReady?}`)
  and falls back to `config`/`secrets` inside `/state`. One of the two must be added server-side; until then the lists are empty on load.
- Config key for the sink address is `crmBaseUrl` (as the server validates it). Settings saves send the full parameter set with `null` for blank values.
- `/state.commit.lastError` may be `null`; handled.

## Tests (46)

`format` (bytes, duration, money, percent, campaign lines, parallel storage, zip central-directory reader), `run-state` (every event type,
terminal phases, cancelling, log cap, commit lines, `normaliseCommit`), `queue-logic` (grouping, states, counts, run options, stored queue
and restore-as-failed, orphans, retry problems, entries from the form), `history` (store, record, spend sums and splits).
Not unit-tested: the React components and hooks themselves; they were exercised by `dev/shots.ts` (mock).
