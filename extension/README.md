# @workflow-catalog/extension

Chrome MV3 extension for the job-assistant workflow. Packet **P07**. Parts A
and B are done: manifest, options/pairing page, the capture extractor, file
export, real pairing and `job_capture` against the runner bridge, and the
offline outbox. Part C (sessions, tab group, side panel content, the
remaining gates) is still ahead.

## What's here

- `manifest.json` — MV3, `permissions` exactly `activeTab, scripting,
  tabGroups, storage, sidePanel, alarms`, `host_permissions` exactly
  `["http://127.0.0.1:4310/*"]` (the runner bridge, loopback only). No
  `tabs`, `debugger`, `<all_urls>`, `content_scripts`, remote code, or
  `eval` — Chrome's default MV3 CSP applies unmodified.
- `src/capture/extractor.ts` — `extractJobPosting()`, a fully
  self-contained function (no closures, no module-scope references) meant
  to run via `chrome.scripting.executeScript({ func: extractJobPosting })`
  against the active tab: JSON-LD `JobPosting` preferred, a DOM-heuristic
  fallback otherwise. Renders any hostile page content it reads back via
  `textContent` only, never `innerHTML`.
- `src/capture/build-job-capture.ts` — normalizes/caps extracted text and
  builds a `JobCapture` envelope validated against
  `@workflow-catalog/contracts`.
- `src/popup/` — action popup: preview (title/company/location/size/
  excerpt) → **Save this job**, which sends the capture to the runner
  (`POST /events`). The status line then says which of five things
  happened:
  - **sent** — the runner has it;
  - **queued for retry** — the runner isn't reachable, had a problem, or
    something other than the runner answers on its port; the service
    worker's retry alarm sends it;
  - **queued until this browser is paired** — not paired yet, or the
    pairing expired, was revoked, or belongs to another install; it's sent
    after the next pairing;
  - **refused** — the runner turned this capture down, so nothing kept it;
    the line says why, in plain words;
  - **not stored** — the browser wouldn't store the capture (for example
    `chrome.storage.session` is full), so it isn't queued either.

  Nothing downloads on its own. **Save as a file** (`job-capture.json`,
  via `Blob` + `<a download>`; there's no `downloads` permission) is the
  explicit fallback, offered whenever the capture isn't the runner's yet.
  Save also writes the capture to `chrome.storage.session`, so Settings'
  **Export last capture** can produce the same file after the popup has
  closed. `render.ts` holds the three render states (`renderLoading`/
  `renderFallback`/`renderPreview`) as plain functions so they're unit-
  testable and screenshot-able in isolation from `main.ts`'s
  `chrome.tabs`/`chrome.scripting` orchestration.
- `src/options/` — Settings:
  - pairing: a code field that posts to the real `POST /pair`, a short
    device id once paired, **Un-pair** and **Pair again**, and a link to
    the runner's `/ui/status` page, where actual revocation lives. Its
    line announces what happens on the page. A pairing the runner refused
    shows there too, without being announced, because Status's alert
    already says it;
  - status: `GET /status` shows connected/version/workspace, or one plain
    sentence per failure (not running, not responding, pairing expired or
    revoked, another install, another program on the port, too many
    tries), plus how many saved jobs are still waiting, and whether they
    wait on a pairing (any other reason is the one Status gives);
  - the file bridge: **Export last capture** writes `job-capture.json`,
    and importing an `application-session.json` validates it as a
    `SessionManifest` and shows a read-only summary.

  Device token state lives in `chrome.storage.session`, never
  `storage.local`.
- `src/shared/bridge-client.ts` — `createBridgeClient()`, the real
  `fetch`-backed `BridgeClient` (pair/postEvent/getCommands/getStatus).
  Every failure carries the bridge's own HTTP status and error code; what
  a person sees is worded from those in the popup and Settings, never
  shown raw.
- `src/shared/outbox.ts` — the `job_capture` outbox. A capture Save
  couldn't deliver is queued in `chrome.storage.session`, one key per
  capture, and retried with backoff via a `chrome.alarms` alarm the
  service worker owns. A retry resends the same capture with the same
  `eventId`, and the bridge answers a replay with `duplicate: true`, so a
  queued capture is journaled exactly once. A capture waiting on a pairing
  is held, not retried, until a new pairing; each such pause records the
  pairing it was refused under, so one left from an older pairing never
  holds a capture back under the current one.
- `src/sidepanel/` — placeholder; content lands in part C.
- `src/worker/` — service worker; imports the zod-jitless bootstrap first
  (see below), then registers the outbox's retry-alarm listener and arms it
  at startup if anything is already queued.
- `src/shared/zod-jitless.ts` — sets `z.config({ jitless: true })` as the
  literal first import of every entry point. MV3's default CSP forbids
  `unsafe-eval`; zod v4 otherwise probes for `new Function` support at
  module load. Import-order evaluation (ES modules fully evaluate their
  imports, in textual order, before the importing module's own statements
  run) guarantees this lands before any schema is touched.

## Build

```sh
pnpm --filter @workflow-catalog/extension build
```

Runs `scripts/copy-static-assets.mjs` (copies `manifest.json`,
`docs/spec/visuals/theme.css`, and the two self-hosted Geist woff2 files
into `public/`, which Vite then copies verbatim into `dist/`), then `vite
build`, then `scripts/scan-dist-for-eval.mjs` (fails the build if anything
in `dist/` contains `eval(`, `new Function`, or a remote `<script src=
"http...">`/`import("http...")`). Output is `extension/dist/`, gitignored,
never hand-edited.

## Load unpacked

1. Build first (above).
2. Chrome → `chrome://extensions` → enable **Developer mode** (top right).
3. **Load unpacked** → select `extension/dist`.
4. The action icon appears in the toolbar; the options page is reachable
   from the extension's card (**Details** → **Extension options**) or by
   right-clicking the icon.

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm typecheck` | Two `tsc --noEmit` programs: `tsconfig.json` (src, scripts, e2e) and `tsconfig.real-bridge.json` (the three files that import the runner's bridge source, under the runner's own compiler options) |
| `pnpm test` | Vitest unit tests (happy-dom) — extractor fixtures (JSON-LD, DOM-heuristic, hostile posting), byte-cap truncation, URL refusals, `contentHash` format, `JobCapture`/`SessionManifest` validation, token storage against a fake `chrome.storage`, the bridge client (also against the real bridge on an ephemeral port), the outbox and its races, the popup's and Settings' states, the screenshot guard, manifest exactness, a static no-`eval` source scan. Five tests read `dist/` and are skipped until it's built; `EXTENSION_DIST_REQUIRED=1` (CI) makes a missing `dist/` fail them instead |
| `pnpm lint` | `eslint . --max-warnings 0` |
| `pnpm build` | see above |
| `pnpm test:e2e` | Playwright, see below |

## End-to-end tests

```sh
npx playwright install chromium   # one-time, downloads Playwright's bundled Chromium
pnpm --filter @workflow-catalog/extension build   # test:e2e loads dist/, not source
pnpm --filter @workflow-catalog/extension test:e2e
```

`e2e/fixtures.ts` loads `extension/dist` into a persistent Chromium
context (`chromium.launchPersistentContext`, `--load-extension`) — the
Playwright-documented way to test an extension, and the reason this runs
on Playwright's bundled Chromium rather than a system browser: **branded
Chrome/Edge removed the command-line extension-sideloading flags this
depends on** (`browser-boundary.md`). `channel: "chromium"` in that same
launch call is required, not cosmetic — Playwright picks between two
separate downloaded binaries based on the `headless` option alone, and the
headless one (`chromium-headless-shell`) has no extensions subsystem at
all; `channel: "chromium"` forces the full binary regardless of
`headless`. `extension.spec.ts` checks: the extension loads and its
service worker starts; the options, popup, and side panel pages each
render with real fonts/theme applied (`document.fonts.check`, and body
background compared against the live `--background` token, not just
"non-empty"); none of the three produces a `securitypolicyviolation`,
`pageerror`, or console error on load; the popup shows the
no-readable-address fallback when opened without a genuine `activeTab`
grant (direct navigation to the popup's URL isn't one).

**`real-popup.spec.ts`: the popup's successful-extraction path, for
real.** Chrome's `activeTab` grant requires a genuine user-gesture
invocation of the extension (a real toolbar click, or a real key event
reaching the browser's accelerator table) — `chrome.action.openPopup()`
called without a DOM gesture opens the popup window but does not grant
`activeTab`, and CDP key events dispatched at a page target don't reach
extension keyboard commands
([playwright#22683](https://github.com/microsoft/playwright/issues/22683),
open, no workaround). Chrome's own `--enable-unsafe-extension-debugging`
launch flag plus the CDP `Extensions.triggerAction` command *is* a
genuine, first-party invocation of the action button, and does grant
`activeTab` — `e2e/real-popup-cdp.ts` wraps it (launch with that flag,
resolve the tab's "tab"-type CDP target, trigger the action, attach to
the popup's own target via a raw non-flattened session, since neither
Playwright's `context.pages()` nor its typed `CDPSession` cover a target
reached only through `Target.sendMessageToTarget`). `e2e/fixture-server.ts`
serves `extension/fixtures/*.html` over `http://127.0.0.1:<port>`, where
the port is whatever free one the OS assigns (it listens on port 0, so it
never collides with another harness); the specs read the origin from the
server handle (capture needs an http(s) page; `file:` is refused outright —
see `shared/url.ts`).
`real-popup.spec.ts` drives real capture → preview → Save (unpaired, so
the capture is queued) → **Save as a file** → a real download, against
the json-ld, hostile, and DOM-heuristics fixtures (including
proving the hostile posting's injected instruction is fully visible, not
clipped, and never fires a dialog or navigation), the SPA-mismatch
refusal (`posting-spa-mismatch.html`'s `__simulateRouteChangeTo`, a
deliberate, generous main-thread busy-wait so the tab's URL changes
*between* the popup's `chrome.tabs.query` and the injected extractor's
`location.href` read — deterministic because `chrome.tabs.query` is
answered entirely by the browser process from cached tab state, unaffected
by that tab's renderer being busy; not a timing race against real router
latency), and axe (0 WCAG 2.x A/AA + best-practice violations) against
every state above plus the options page, light and dark. It also captures
the P07A acceptance screenshots from the real popup and options pages, and
accepts a capture only once the page shows the requested theme before and
after it (body background equals `theme.css`'s `--background` for that
theme), and the captured image's own background is light or dark to match.
It re-applies the colour scheme if the popup drops it, and captures only
after 1.1 s with no resize, so DevTools' viewport-size label is gone. A
normal run writes these captures under `extension/test-results/`
(gitignored) and leaves the working tree clean. To rewrite the committed
`docs/screenshots/P07A-*.png`, opt in:

```sh
P07A_UPDATE_SCREENSHOTS=1 pnpm --filter @workflow-catalog/extension test:e2e
```

**`bridge-e2e.spec.ts`: pairing and `job_capture` against the real
bridge.** It starts the runner's real P02 bridge (fresh temp workspace,
`e2e/real-bridge-harness.ts`) on `127.0.0.1:4310` — the one origin the
manifest's host permission allows — so **nothing else may be listening on
4310** while it runs. Through the real options page and popup it covers
pairing and Un-pair, a wrong code, a revoked and an expired pairing, a
stopped runner and a stuck one (a listener that never answers), Save
sent, queued while the runner is down and
delivered by the real retry alarm, and a wrong-install 403. For the states
the real bridge can't be driven into from a real Save — a refusal (409),
another program answering on the port, a re-pair landing mid-Save — a
small stand-in listens on 4310 instead. Every state is checked (axe, empty
message areas, `[hidden]`, commands kept on one line, inert buttons at
4.5:1 or more) and captured light and dark (Settings at 1280 and 390 px
wide) into `docs/screenshots/P07B-*.png` when opted in:

```sh
P07B_UPDATE_SCREENSHOTS=1 pnpm --filter @workflow-catalog/extension test:e2e
```

## Manual smoke test (branded Chrome)

`real-popup.spec.ts` now covers the happy path (steps 2-3 below) on
Playwright's bundled Chromium; this checklist is still the only way to
check it on your actual, branded browser. Branded Chrome can still
**load unpacked** through the UI (only the command-line flag was
removed), so it's also the way to check anything the e2e suite can't
reach at all:

1. Build, then load unpacked as above in your real Chrome.
2. Open any real job posting page in a tab, click the toolbar icon →
   preview shows a plausible title/company/location/size/excerpt.
3. Before pairing, click **Save this job** → the button reads **Saved ✓**
   and the status line says it's queued until you pair; nothing
   downloads. **Save as a file** downloads `job-capture.json`.
4. Switch to a tab you can't capture (`chrome://newtab`, a PDF, a
   `file://` page) and click the icon → fallback message, with a working
   link to `http://127.0.0.1:4310/ui/jobs`.
5. With the runner running (`npm run runner` in `runner/`) and a pairing
   code (`npm run setup` prints the first one, `npm run pair` any later
   one), open the options page → entering the code and clicking **Pair**
   shows a short device id and the status section flips to connected, with
   the runner's version and workspace. The capture queued in step 3 is
   sent right after pairing. **Un-pair** forgets the token, announces it,
   and the page still links to `http://127.0.0.1:4310/ui/status` for
   actual revocation.
6. Pair again, stop the runner, reload the options page → the status
   section shows a clear "can't reach the runner" state, not a stuck
   spinner or a raw error. Save a job from the popup while it's still
   stopped → the status line says the runner isn't reachable; restart the
   runner and the queued capture is delivered on the next retry alarm (the
   first comes about 30 s after the Save; they back off while the runner
   stays down), once: a retry resends the same capture with the same
   `eventId`. Reopening the popup and saving again is a new capture with a
   new `eventId` (the popup mints one each time it opens,
   `build-job-capture.ts`), so the runner gets it as a second event.
7. In the options page's **File bridge** section, **Export last capture**
   downloads the last capture you saved as `job-capture.json`. Importing a
   file takes an `application-session.json` (a session manifest, going the
   other way: runner to extension) → a read-only summary renders; any
   other file, a `job-capture.json` included, is refused with a plain
   message. The runner doesn't write session manifests until part C, so
   use a hand-written fictional one for now:
   `extension/fixtures/application-session.example.json`, which follows
   `sessionManifestSchema` in `packages/contracts/src/session.ts` (a unit
   test keeps it valid). To write your own, follow the same schema and use
   fictional data only (`docs/spec/implementation/fixtures-policy.md`).
8. Toggle the OS between light/dark appearance and reopen the popup and
   options page → both follow it immediately (no stale theme).

## Known limitations

- **Pairing at the exact moment an old token is refused.** When the runner
  refuses a token (expired or revoked), the extension forgets it — but only
  if it's still the stored one. `chrome.storage` has no compare-and-set, so
  a new pairing stored in the few milliseconds between that check and the
  removal is forgotten with it. If you pair at the exact moment an old
  token is refused, pair again.

## What part C still owes

Sessions, the tab group behavior, side panel content, and the remaining
gates named in the P07 packet (`GET /commands` polling and its 15-minute
alarm are part C's "Session" deliverable, not part B's).
