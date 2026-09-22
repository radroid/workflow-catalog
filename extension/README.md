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
  excerpt) → "Save this job" (downloads `job-capture.json` via `Blob` +
  `<a download>`, part A has no `downloads` permission; also writes to
  `chrome.storage.session` so the options page's file-bridge export can
  recover the same capture if the popup closed on focus loss first).
  `render.ts` holds the three render states (`renderLoading`/
  `renderFallback`/`renderPreview`) as plain functions so they're unit-
  testable and screenshot-able in isolation from `main.ts`'s
  `chrome.tabs`/`chrome.scripting` orchestration.
- `src/options/` — pairing UI (code input against the real `POST /pair`,
  a short abbreviated device id once paired, Un-pair, and a link to the
  runner's `/ui/status` page where actual revocation lives), a status
  section (`GET /status`: connected/version/workspace, or a clear re-pair/
  wait/offline state per failure), and the file-bridge fallback
  (`SessionManifest` import validation with a read-only summary, JSON
  export). Device token state lives in `chrome.storage.session`, never
  `storage.local`.
- `src/shared/bridge-client.ts` — `createBridgeClient()`, the real
  `fetch`-backed `BridgeClient` (pair/postEvent/getCommands/getStatus).
  Every failure carries the bridge's own HTTP status and error code, not
  just a message.
- `src/shared/outbox.ts` — the `job_capture` outbox: when Save can't reach
  the bridge, the capture is queued in `chrome.storage.session` and retried
  with backoff via a `chrome.alarms` alarm the service worker owns, so it's
  delivered exactly once.
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
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest unit tests (happy-dom) — extractor fixtures (JSON-LD, DOM-heuristic, hostile posting), byte-cap truncation, URL refusals, `contentHash` format, `JobCapture`/`SessionManifest` validation, token storage against a fake `chrome.storage`, manifest exactness, popup render states, a static no-`eval` source scan |
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
`real-popup.spec.ts` drives real capture → preview → Save → download
against the json-ld, hostile, and DOM-heuristics fixtures (including
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
3. Click **Save this job** → `job-capture.json` downloads.
4. Switch to a tab you can't capture (`chrome://newtab`, a PDF, a
   `file://` page) and click the icon → fallback message, with a working
   link to `http://127.0.0.1:4310/ui/jobs`.
5. With the runner running (`npm run runner` in `runner/`) and a pairing
   code from `npm run pair`, open the options page → entering the code and
   clicking **Pair** shows a short device id and the status section flips
   to connected, with the runner's version and workspace. **Un-pair**
   forgets the token, announces it, and the page still links to
   `http://127.0.0.1:4310/ui/status` for actual revocation.
6. Stop the runner, reload the options page → the status section shows a
   clear "can't reach the runner" state, not a stuck spinner or a raw
   error. Save a job from the popup while it's still stopped → the status
   line says the runner isn't reachable; restart the runner and the queued
   capture is delivered on the next retry alarm (or reopen the popup and
   save again — either way, the same `eventId` reaches the bridge exactly
   once).
7. In the options page's **File bridge** section, import a
   `job-capture.json` saved in step 3 → a read-only summary renders.
8. Toggle the OS between light/dark appearance and reopen the popup and
   options page → both follow it immediately (no stale theme).

## What part C still owes

Sessions, the tab group behavior, side panel content, and the remaining
gates named in the P07 packet (`GET /commands` polling and its 15-minute
alarm are part C's "Session" deliverable, not part B's).
