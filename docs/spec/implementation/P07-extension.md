# P07 · Chrome extension

Status: claimed (part B)
Assignee: iter-003 implementer (Sonnet), part A; revision 2 iter-003 (Opus); part B iter-004 implementer (Sonnet); part B revision 1 iter-004 implementer (Sonnet)
Blocked by: P02 (pairing and bridge), P06 (manifests and commands)
Owns: extension/
Spec: F6 (capture path), F9, §7 rule 3, browser-boundary.md (all sections; the nine gates are this packet's definition of done)

## Goal
Capture the current posting, open an application session as a tab group, show the side panel, and report explicit status, within the MV3 boundary the research established.

## Deliverables
- `manifest.json`: `manifest_version: 3`, `minimum_chrome_version: "120"`, permissions exactly `activeTab, scripting, tabGroups, storage, sidePanel, alarms`, host permission only `http://127.0.0.1:4310/*`. No `tabs`, no `<all_urls>`, no remote code, no eval.
- Pairing (options page): enter the code from `npm run setup`, receive a device token into `storage.session`, show device name, allow un-pair.
- Capture: action click → packaged extractor via `scripting` under `activeTab` → bounded text + structured hints → preview → Save → `job_capture` event with content hash. Paste/upload fallback link to the local UI.
- Session: poll `GET /commands` on panel open and via an alarm (15-minute cadence, recreated on startup); on a user gesture open the group (`tabs.create` + `tabs.group` + `tabGroups.update`), journal intent before creating tabs, record returned IDs in `storage.session`, acknowledge per item; never auto-open from an alarm.
- Side panel: current task's job, prepared documents (links to the local UI), remaining steps, `Applied` / `Defer` buttons → `application_status_changed` with expected revision. Closing a tab sends only `closed`.
- Restore: "Reopen session" reads the manifest; warns if a group with the same title exists; never adopts arbitrary tabs.
- File bridge fallback: export `job-capture.json`, import `application-session.json`, export completion events.
- Playwright tests on bundled Chromium (persistent context) + a manual smoke script for branded Chrome.

## Acceptance
The nine gates from browser-boundary.md as automated tests where possible (replay, worker kill between journal and record, restart with restored tabs, offline/reconnect, capture-navigation/denial/iframe fallback, two devices + revoke + expired token, hostile/oversized/privileged inputs rejected, closed tab and "success-looking page" leave status unchanged) and a checklist for the manual ones. Manifest diff test: permissions equal the six exactly.

## Out of scope
Form filling, uploads, submission, cookies, native messaging.

## Report

### 2026-09-22 — Revision 1 (part B)

PR #12 (base `overnight/integration`, head `2e3b52d`) came back REVISE from
both the reviewer (6 issues: B1-B6) and the UI critic (10 issues: B7-B12,
plus E1-E4 orchestrator decisions and a polish list) — this section
covers that one revision round. Worked in the packet's own worktree on
`packet/P07-B`; merged `origin/overnight/integration` first (brought in
P02.1 and P09.1, landing my prior head on `f06688b` green). 11 commits,
`7334ef0` (claim of this round) through `1aa690e`; head at report time
`1aa690e`, this report is the next commit. Files touched: `extension/**`
(source, tests, both e2e specs, a new second `tsconfig.real-bridge.json`),
one step of `.github/workflows/ci.yml`, and `docs/screenshots/P07B-*.png`
— nothing in `packages/`, `runner/`, or outside `extension/`'s Owns.

**Orchestrator decisions (E1-E4).**
- **E1** (bridge tried first, nothing auto-downloads): `sendToBridge` in
  `popup/render.ts` posts to the bridge before ever touching a file;
  `ok()` says "Sent to the runner." and downloads nothing. "Save as a
  file" is a real secondary `<button>`, hidden by default, revealed only
  when `offerFileSave` is true (every non-success outcome except the
  drop-bucket 4xx, which also offers it).
- **E2** (queue-then-flush-on-pair): a not-paired Save now queues (paused,
  same as a 401/403) instead of the old "never queue before ever pairing"
  design. `options/main.ts`'s pair-success handler calls
  `flushOutbox(client, { includePaused: true })` right after storing the
  new token, giving every paused entry (not_paired, 401, or 403) one real
  attempt.
- **E3/B12** (code label names the command that printed it): `npm run
  setup` prints the first code, `npm run pair` every one after —
  `pairingSection`'s `everPaired` param picks the label
  (`buildPairingSection` from `current !== null`; the Un-pair handler
  passes a hardcoded `true`, since it has just forgotten its own token a
  moment before `current` would read `null`). Commands render via a new
  `withInlineCode()` helper (splits on backticks, alternates plain text
  and `el("code", ...)`) — `.textContent` only, per this file's own
  XSS-safety rule, never `innerHTML`.
- **E4**: one line on the options page, next to File bridge: "Pairing
  lives only in this browser session — quitting Chrome un-pairs it."

**B1** (vitest needed 4310 free): `bridge-client.realbridge.test.ts` now
asks `real-bridge-harness.ts`'s new `findEphemeralPort()` (binds to port
0, reads back the OS-assigned port) instead of the fixed 4310; `afterEach`
guards against a `beforeEach` that itself failed to start a bridge via a
scoped `(harness as BridgeHarness | undefined)` cast. 4310 stays reserved
for `test:e2e`, the one consumer (the real, built extension) that's
actually hard-coded to it. Verified by holding 4310 with a dummy process
and re-running the suite (still 11/11).

**B2** (outbox could drop a capture): rewrote `shared/outbox.ts`'s storage
from one array under a single `jobCaptureOutbox` key to one key per entry
(`jobCaptureOutbox:<eventId>`) — the race was between two different JS
contexts (a popup's `enqueueCapture`, the worker's alarm-driven
`flushOutbox`) that share no module state, only `chrome.storage`, so an
in-memory lock could never have fixed it; per-key storage makes the race
impossible by construction, since every mutation touches exactly one
entry's own key. Added the race as a test (enqueue A, start a flush that
blocks mid-`postEvent`, enqueue B from the "other context" while A is
still in flight, resolve A, assert B survived).

**B3** (every refusal reported the same way): `sendToBridge` and
`outbox.ts`'s `isPausingError`/`isRetryableFailure` now branch on the
bridge's actual status/code: `not_paired`/401/403 queue paused with their
own specific message and an "Open settings" action;
`network_error`/5xx queue and retry automatically; any other 4xx (400,
409, 413, 422, ...) is dropped (never queued) and shown verbatim. 401
clears the stored token via `bridge-client.ts`'s new `onTokenInvalid`
hook, so Pairing and Status stop claiming "paired" for a dead token. 403
has no wire signal the options page's own `GET /status` could ever see
(Chrome sends no Origin on a GET) — `onOriginMismatch` stores a
session-only flag (`shared/storage.ts`) that `buildStatusSection` checks
before ever calling `getStatus()`. gate-9's e2e expectation updated to the
new, specific 403 text.

**B4** (no timeout, delivery unvalidated): `request()` now races every
fetch against `AbortSignal.timeout(5000)`, mapped to a `network_error`
with a distinct "The runner isn't responding." message (kept separate
from the connection-refused wording, same retry treatment either way).
`postEvent` only counts a 200 as delivered when the body has `ok: true`
*and* a matching `eventId` (duplicate:true still success) — otherwise
`invalid_response`, dropped rather than retried forever (a wrong process
squatting on 4310 would otherwise empty the outbox of things nothing real
ever received). `render()` now mounts Pairing and File bridge immediately
alongside a "Checking the runner…" Status placeholder, then awaits the
real `GET /status` — previously `render()` awaited the whole Status
section first, so a slow/stuck runner left every section blank.

**B5** (CI silently skipped two dist tests): the one extension CI step now
runs `pnpm --filter @workflow-catalog/extension test` (vitest) right after
`build`, before `test:e2e`, so `manifest.test.ts`'s two dist-path tests
run for real against a real `dist/` every CI run instead of never getting
a chance to. **Orchestrator-corrected mid-round**: the first pass gated
those two tests on bare `process.env.CI` — GitHub Actions sets `CI=true`
for every step in a job by default, including the *root* `pnpm test` step
in `ci.yml`, which runs `pnpm -r test` *before* any build step, so that
gate would have made the same two tests fail there too (a real,
disclosed conflict, flagged in this report and fixed here rather than
left). Corrected to a dedicated `EXTENSION_DIST_REQUIRED=1`, set only by
the one extension CI step's own vitest invocation
(`EXTENSION_DIST_REQUIRED=1 pnpm --filter @workflow-catalog/extension
test`) — `manifest.test.ts`'s gate is now `built ||
process.env.EXTENSION_DIST_REQUIRED === "1"`. Verified both directions
with `dist/` moved aside: `EXTENSION_DIST_REQUIRED=1` fails both tests
for real (an `expect(false).toBe(true)` and a raw `ENOENT`, same as
before); `CI=true` alone now stays green (9 passed, 2 skipped) — proving
the root step's situation is resolved, not just asserted. Restored
`dist/`, confirmed via `git status`/`git diff` that only
`manifest.test.ts` and the one `ci.yml` line changed.

**B6** (three files excluded from typecheck hid a real error): added
`extension/tsconfig.real-bridge.json`, a second `tsc` program (mirrors
`runner/tsconfig.json`'s `allowImportingTsExtensions`/`lib: ["ES2024"]`,
plus `DOM`/`DOM.Iterable`/`"chrome"` for what these three files
specifically need) covering exactly `e2e/real-bridge-harness.ts`,
`src/shared/bridge-client.realbridge.test.ts`, and
`e2e/bridge-e2e.spec.ts`; wired into `typecheck` as a second `tsc --noEmit
-p` call. Real error it surfaced: `bridge-e2e.spec.ts`'s gate-6 test
passed a `string | undefined` (from a `page.evaluate` returning an
optional chain) straight into `devices.revoke(deviceId: string)` — fixed
with a real runtime guard (throws a clear message if ever actually
undefined) rather than an `as string` cast.

**B7** (focus/announcements): one persistent live region
(`options/main.ts`'s module-scope `pairingStatus`, created once, never
rebuilt) for "Paired."/"Un-paired." — screen readers only announce a
mutation to a live region that was already present, and the old
full-section rebuild recreated it every time, silently dropping the
announcement. Focus lands on Un-pair after a successful pair, the code
field after a failed one.

**B8** (invalid-code styling on a runner-down/429): `aria-invalid` is now
set only for `pairing_code_invalid`/`pairing_code_expired` — a
runner-down or 429 response no longer marks a valid code wrong. 429 says
"Too many tries. Try again in about N minutes." from the bridge's own
`Retry-After` header (`bridge-client.ts` now parses it into
`retryAfterSeconds`), or a generic "wait, then try again" if absent.

**B9**: `.eyebrow { font-weight: 400; }` — it inherited the browser's bold
`h1` default.

**B10**: a "Check again" button (re-runs `refreshStatusSection`) plus a
`window` `focus` listener for the common case (start the runner, alt-tab
back); an outbox summary line ("1 saved job waiting to send." / "All
saved jobs sent.").

**B11**: the not-paired popup state offers an "Open settings" button
(`chrome.runtime.openOptionsPage()`) alongside "Save as a file" — "Open
settings"/"Settings" is the one name used throughout, popup and options
alike.

**Polish**: commands render as `<code>` (E3, above) so they never wrap
mid-command; "Un-paired…" moved next to Un-pair instead of stranded below
the (possibly hidden) code field; workspace UUID abbreviated to 8 chars +
`title` for the full value (same treatment Device's id already had); the
Pair form collapses into a single "Pair again" button while paired,
expanding (and focusing the code field) on click; "Saved ✓" is
`aria-disabled` (not `disabled`, which would drop focus) plus a
closure-scoped guard, so a second click is an inert no-op instead of
re-saving; outcomes use `.flash`/`.flash.bad` pill styling, not muted
11.5px text; a stronger scroll cue on `.excerpt`; "including actual
revocation" dropped from the status-page wording; "Pair a device" → "Pair
this browser" everywhere. The reviewer's brightness-retry nit
(`theme-capture.ts`) is covered below, separately, since it needed its
own investigation.

**A real bug the new screenshots caught.** `formWrap.hidden = true` (the
Pair-again collapse) correctly set the attribute, but `.stack`'s own
`display: flex` — an author-origin rule, on the very same element — silently
out-prioritizes the `hidden` attribute's user-agent-stylesheet `display:
none`, regardless of selector specificity. The code-entry form was
visually shown at all times, paired or not; no vitest assertion ever
caught it, since happy-dom checks the `hidden` *property*, not real CSS
layout. Only a real screenshot showed it. Fixed with the standard
defensive rule, `[hidden] { display: none !important; }` in
`shared/base.css`, so `hidden` wins regardless of whatever other classes
an element carries (not scoped to `.stack`, since the same collision
would silently recur anywhere else `hidden` and a `display`-declaring
class ever landed on the same element).

**Reviewer nit — brightness retry.** `captureInTheme`'s brightness-mismatch
retry (added for the CI flake documented in the Part B entry below) used
to retry unconditionally on any brightness/theme disagreement.
`ensureColorScheme`'s own doc comment scopes retrying to one specific,
understood quirk (matchMedia disagreeing with what was just requested);
"any other failure... must fail the test at once." Now checks
`matchMedia` at the point of the mismatch: only retries when matchMedia
*also* still disagrees (the known quirk); if matchMedia already agrees
(as `verifyTheme` just reconfirmed before the action ran), a wrong
brightness is a different, unexplained failure and fails immediately
instead of spending retries on it.

**Screenshots**: full retake, all required states. `pageThemeTarget`'s
capture now passes `fullPage: true` (a plain `page.screenshot()` only
captures the current viewport, which is exactly how File bridge got
cropped out); options screenshots explicitly set both required widths
(1280, 390) via a new `captureOptionsBothWidths` helper. Popup (natural
size): preview, sent, queued (runner down), not paired, pairing expired
(401, a real `devices.revoke`), other install (403, a real
mismatched-origin token). Options (both widths): unpaired, paired with
status, checking the runner, runner not responding, plus pairing error
(kept from the old set — not one of the four named states, but cheap,
already-working, non-overlapping coverage). "Checking the runner…" needed
its own approach: a never-paired page's `getStatus()` returns a local
`not_paired` error without ever making a network request (`bridge-
client.ts`'s own doc comment says so), so there's no in-flight request to
hold — pairs first, then opens one fresh page per width with
`page.route()` holding that page's own `GET /status` until after both
theme captures. 32 files under `docs/screenshots/P07B-*.png`; six
now-superseded ones removed (`options-paired-*`/`options-error-*` without
a width suffix; `popup-saved-*`, renamed `popup-sent-*` to match the
actual message).

**e2e drift from this revision's own changes.** A real Playwright run
(not just reading the diff) surfaced several `bridge-e2e.spec.ts`/
`real-popup.spec.ts` assertions that had quietly gone stale as
`render.ts`/`main.ts` changed underneath them this round: the wrong-code
and runner-down messages' literal backticks (now rendered as `<code>`,
never a literal backtick character); "Pair a device" → "Pair this
browser"; gate 1's and the popup-saved screenshot's success text ("Sent
to the runner.", no more "Saved job-capture.json and..."); gate 9's 403
text (the literal ask); gate 4's status text and, more substantively, its
two outbox reads (`chrome.storage.session.get("jobCaptureOutbox")` —
B2's per-key redesign left nothing under that literal key anymore, so the
first of the two would always have hard-failed); the paired-options
workspace-ID assertion (compared against the full UUID; now abbreviated,
split into a display-text check and a `title`-attribute check for the
full value); and `real-popup.spec.ts`'s two Save-then-download steps
(E1/E2: an unpaired Save now queues instead of downloading — both steps
still prove the real download mechanism works, just via an explicit
"Save as a file" click instead of assuming Save itself triggers it).

**Mutation proofs** (each: backed up to `/tmp`, mutated, confirmed the
named test fails for the stated reason, restored from the backup,
confirmed `git diff --stat` empty):
- B2: reverted `flushOutbox`'s per-entry writes to a single stale
  bulk-write-back computed from the pre-await snapshot → the race test
  failed with the concurrently-enqueued capture missing (`expected [] to
  deeply equal [ "22222222-..." ]`).
- B3: 401 rewritten to the network_error/retryable branch, 403 rewritten
  to `ok(...)` → both B3 tests failed with the wrong message
  (401 got "isn't reachable right now" instead of "pair again in
  Settings"; 403 got "Sent to the runner." instead of the different-
  install text).
- B4: dropped `AbortSignal.timeout(...)` from the fetch call → the
  timeout test hung and hit Vitest's own 10s test timeout (a real hang,
  not a simulated one); removed the `ok`/`eventId` check from `postEvent`
  → both the wrong-body and mismatched-eventId tests failed with
  `result.ok` true instead of false.
- B5: `dist/` moved aside, `CI=1 vitest run manifest.test.ts` → both
  dist-path tests failed for real (an `expect(false).toBe(true)` and a
  raw `ENOENT`) instead of reporting skipped; restored, back to 9 passed +
  2 skipped without `CI`, 11/11 with `dist/` present.
- B6: reintroduced the unguarded `devices.revoke(deviceId)` call → `tsc
  --noEmit -p tsconfig.real-bridge.json` failed with the original
  TS2345 at the original line.

**Verify chain** (repo root): `pnpm install --frozen-lockfile`, `pnpm
typecheck` (6/6 packages), `pnpm test` (`packages/contracts` 235,
`packages/job-assistant` 151, `runner` 155 + 4 evals/20 gates, `apps/catalog`
168, `extension` 217, plus `scripts/*.test.mjs` 2 — all passed), `pnpm -r
lint` (6/6 clean), `pnpm check:fixtures` (clean) — `git status --porcelain`
empty throughout and after. Extension build → `CI=1 vitest run` (19
files, 217 tests, 0 skipped) → full `playwright test` (27 tests: the 3
base `extension.spec.ts`, 18 in `bridge-e2e.spec.ts` including all 11
screenshot tests, 5 in `real-popup.spec.ts`, using 4 workers with
`bridge-e2e.spec.ts`'s own serial mode still honored) — run twice, both
100% green, port 4310 confirmed free before and after every run.

**Assumptions / judgment calls**, for the reviewer to weigh in on:
- Kept the pre-existing "pairing error" (wrong code) options screenshot
  at both widths, even though it isn't one of the four states E3/B4's
  screenshot list names — additive, not a substitute for any required
  state.
- `everPaired`'s doc comment (E3/B12) was tightened, not the behavior: a
  token silently lost some way *other* than an explicit Un-pair (e.g. a
  401 auto-clearing it) isn't distinguished from a fresh install, and the
  next Pairing re-render shows "npm run setup" again. Nothing in this
  round's issues named that edge case explicitly; adding a persistent
  "was ever paired" flag felt like scope beyond what was asked, so it's
  called out here instead of silently decided either way.
- B5's known conflict (above) was real and has been fixed (orchestrator
  correction, same revision round): the bare `CI` gate is now
  `EXTENSION_DIST_REQUIRED=1`, set only by the one extension CI step this
  packet owns. No outstanding risk to the root `Test` step remains.

### 2026-09-22 — Part B (iter-004 implementer, Sonnet)

Scope was **part B**: real pairing and `job_capture` against the P02
bridge, which landed mid-packet (`9a0c5b7`, confirmed via `runner/`'s own
tests no longer printing a placeholder line). Part A (merged, `bc55bb3`)
and part C (sessions, tab groups, side panel — out of scope, nothing part
B touches blocks it) are untouched. Branch `packet/P07-B` off
`overnight/integration` at `dc36fc0`; head `e92ade1` across 9 commits
(`a96bae2` claim … `e92ade1` the CI step; this report is the next commit).

**What was built** (the six part-B deliverables):
1. **Real pairing.** `options/main.ts`'s Pairing form now posts to the
   real `POST /pair` via `shared/bridge-client.ts`'s `createBridgeClient()`
   (replacing part A's network-free stub), stores `{deviceId, token,
   pairedAt}` in `chrome.storage.session` only, shows an abbreviated
   device id (full id in `title`), and Un-pair forgets the token,
   announces "Un-paired.", and links to `http://127.0.0.1:4310/ui/status`
   for the actual server-side revocation.
2. **`GET /status`** on the options page: connected/version/workspace on
   success, and one of four distinct, announced, recoverable states — not
   paired, runner not running (`network_error`), 401 (re-pair), 403
   (re-pair), 429 (wait, `npm run pair`) — via `statusFailureMessage()`.
3. **`job_capture` delivery.** Save always writes the local
   `job-capture.json` download first (unconditional fallback), then posts
   to the bridge: reachable+accepted (including a replayed `duplicate:
   true`) reads as one "saved and sent" success; not-paired says so
   without queuing (retrying can't help until a person pairs); any other
   failure (`network_error` or an HTTP error) queues the exact same
   `JobCapture` object (same `eventId`, so a later retry is a replay the
   bridge recognizes) in `chrome.storage.session` via `shared/outbox.ts`
   and arms a `chrome.alarms` retry (0.5 min → ×2 backoff → 30 min cap,
   idempotent by alarm name, re-armed on worker startup if anything's
   still queued) — delivered exactly once.
4. **`BridgeClient` errors** now carry `{status?, code, message}`
   (`BridgeError`), not just a string — every call site (pairing, status,
   job_capture) branches on `code`/`status`, never a string match.
5. **Jobs link** fixed to `http://127.0.0.1:4310/ui/jobs` (P02's local UI
   serves `/ui/<name>`, not a literal `.html` file — part A had guessed at
   the latter before P02 existed to check against).
6. **Six part-A-review carry-forwards**, all in `7562028`: the `.popup h1`
   rule that silently overrode `.eyebrow`; `dl.kv`'s UA margin; a visible
   scroll cue on the excerpt; `<main>` around the side panel; the
   `scan-dist-for-eval.mjs` lookbehind now also catches
   `globalThis.Function(`/`self.Function(`; and (`4555fa2`, after
   stress-testing surfaced two more real races beyond what that carry-
   forward originally covered) the options page's dark axe audit now goes
   through the same guarded `inTheme` retry the popup already used, plus a
   new regression guard (`assertNoDevToolsLabelTopRight`) that a captured
   screenshot's top-right corner never shows a leaked DevTools viewport-
   size label.
7. **One CI step** (`.github/workflows/ci.yml`, `e92ade1`): installs
   Playwright's chromium channel with OS deps, builds the extension, runs
   `test:e2e` — nothing else in that file touched, no secrets.

**Contracts ask (flagged, not invented around):** `PairResponse`
(`packages/contracts/src/bridge-http.ts`) is `{deviceId, token}` — the
bridge never issues a device *name*. The options page shows an
abbreviated `deviceId` instead (`shared/storage.ts`'s own comment says
so). A real device name (e.g. "Chrome on macOS") in `PairResponse` would
let Un-pair/the paired-device view show something a person actually
recognizes, instead of a UUID fragment.

**Acceptance gates, automated against the REAL P02 bridge** (not a fake)
— two layers: `src/shared/bridge-client.realbridge.test.ts` (vitest,
drives `createBridgeClient()` directly against a real listening bridge, no
browser) and `e2e/bridge-e2e.spec.ts` (Playwright, drives the real
options/popup pages against a real listening bridge — proving a person
actually SEES the right thing, not just that the client call resolves).
Both start `@workflow-catalog/runner`'s real `createBridgeApp`/`listen()`
against a fresh `os.tmpdir()` workspace per test
(`e2e/real-bridge-harness.ts`, shared by both, extracted in `81a6afd` so
this isolation is audited in one place). HOME/keychain: checked, see
below.

- **Gate 1 (replay).** vitest: the same `job_capture` sent twice →
  `duplicate:false` then `duplicate:true`, journaled once; a 3×-retried
  "outbox" resend still reads as success every time, journaled once. UI: a
  real Save against a real, reachable, paired bridge shows exactly one
  "Saved job-capture.json and sent it to the runner." (button "Saved ✓"),
  and the bridge's own journal has exactly one entry.
- **Gate 4 (offline/reconnect).** UI only — this is extension-side
  queueing behaviour vitest's client-only harness can't exercise: Save
  while the bridge is down shows "The runner isn't reachable right now —
  it'll be sent automatically once it's back."; the capture sits in
  `chrome.storage.session`'s `jobCaptureOutbox`. The bridge is restarted
  (same workspace/device, same port); a *real* `chrome.alarms` retry
  (genuinely waited out, ~30s, never simulated) delivers it — confirmed
  via the bridge's own journal gaining the entry and the client's own
  queue emptying to 0.
- **Gate 6 (two devices + revoke + expired).** vitest: device A revoked →
  401 `token_invalid` on its next call, device B (different origin)
  unaffected; a 30-day-old token (`ManualClock.advance`) → 401. UI: the
  Status section shows "Your pairing has expired or was revoked. Pair
  again above." for both the revoked and the (clock-advanced) expired
  case.
- **Gate 7 (oversized/hostile-as-data).** vitest: a 300 KB `text`
  (deliberately bypassing the extension's own pre-send cap) gets 413 from
  the bridge itself — defence in depth, not just client-side trust; an
  instruction-shaped hostile string round-trips through the real bridge
  byte-for-byte, journaled verbatim, never interpreted. (This gate's third
  named item, non-http URLs, is `boundedHttpUrlSchema`'s job
  (`packages/contracts/src/primitives.ts`) — already proven at the schema
  level (`primitives.test.ts`), the bridge level
  (`runner/test/bridge.test.ts`, a `javascript:` URL → 400), and the
  client level (`extension/src/shared/url.test.ts`) by other packets/
  parts; not retested here to avoid duplicating coverage under a different
  name.)
- **Gate 9 (part): runner down, wrong extension id.** UI: "runner down" —
  Status shows "Can't reach the runner. Is it running? Start it with `npm
  run runner`." "Wrong extension id" turned out to only be provable
  through `job_capture`'s `POST /events`, not the options page's `GET
  /status`: Chrome sends no `Origin` header at all on a GET
  (`runner/server/extension-api.ts`'s own comment says so), so a
  mismatched-origin token is indistinguishable from a valid one to
  `/status` — found the hard way, when an earlier version of this test
  asserted a 403 the real bridge correctly never sent. Rerouted through
  the popup's Save instead: a token paired at this bridge under a
  different (fictional) origin, presented from the real extension's own
  (different, genuine) Origin on a real POST, shows the same safe "queued,
  will retry" state — and the bridge's journal stays empty, proving the
  rejection actually happened server-side. vitest separately proves the
  bridge's own 403 `origin_not_allowed` directly (a Node-side spoofed
  Origin, `withChromeOrigin`, standing in for what Chrome already
  guarantees on a real POST).

**HOME/keychain/live-model isolation (checked, per a mid-task
clarification from the orchestrator):** `e2e/real-bridge-harness.ts` and
`bridge-client.realbridge.test.ts` import only five things from
`@workflow-catalog/runner`: `server/app.ts`, `server/context.ts`,
`lib/clock.ts`, `store/workspace.ts`, `store/devices.ts` — never
`cli/setup.ts`, `cli/doctor.ts`, `cli/runner.ts`, or `lib/secret-store.ts`.
Checked one level deeper too, not just by filename: `store/devices.ts`'s
own only non-relative-utility import is `lib/crypto.ts`, which imports
nothing but `node:crypto`; the other four files' own `import` lines
contain no reference to any secret/cli/keychain/homedir-shaped module.
`Workspace.create` is called with an explicit path built from a fresh
`mkdtemp(os.tmpdir())` subdirectory every time, never anything derived
from `os.homedir()`; `createRunnerContext` is called directly, with no
secret store and no model/`eve` gateway argument at all, so nothing
reachable from these files can read the real keychain or dispatch a real
model call. The bridge bound `127.0.0.1:4310` only, and `lsof -ti
tcp:4310 -sTCP:LISTEN` was empty before and after every run in this
packet, including the final one below.

**Full verification chain, real output (at `e92ade1`, before this report
commit):**
```
pnpm install --frozen-lockfile  → up to date
pnpm typecheck (pnpm -r typecheck) → clean: contracts, job-assistant/adapters/eve,
  apps/catalog, job-assistant, runner, extension
pnpm test (pnpm -r test && node --test scripts/*.test.mjs) →
  contracts 235/235, job-assistant 151/151, runner 153/153 (+ 4 evals, 20 gates),
  apps/catalog 139/139, extension 184/184, root check-fixtures.test.mjs 2/2
pnpm -r lint → clean (contracts, adapters/eve, runner, apps/catalog, job-assistant, extension)
pnpm check:fixtures → exit 0, no offenses
pnpm --filter @workflow-catalog/extension build → dist/ scan clean: no eval,
  new Function, or remote script/import found.
pnpm --filter @workflow-catalog/extension test:e2e → 19 passed (47.7s)
pnpm --filter @workflow-catalog/extension test:e2e → 19 passed (47.1s)   # run 2/2
git status --porcelain → (empty)
lsof -ti tcp:4310 -sTCP:LISTEN → (empty)
```
e2e went from 9 tests (part A) to 19: 4 in `extension.spec.ts`
(unchanged), 5 in `real-popup.spec.ts` (unchanged behaviourally — its
theme/screenshot machinery moved into `e2e/theme-capture.ts` so
`bridge-e2e.spec.ts` could reuse the same, already-hardened protections
instead of re-deriving them), 10 new in `bridge-e2e.spec.ts` (7
acceptance-gate UI proofs + 3 screenshot captures). The full suite (in its
various sizes as it grew across this session) passed well beyond the two
runs required here — well over a dozen consecutive full-suite runs total
across development, after finding and fixing three real races (one
pre-existing in the SPA-mismatch test, two in this session's own new
theme/screenshot code — all documented in commit `4555fa2`) and two bugs
specific to the new UI-layer tests (commit `e165677`: an un-awaited
`chrome.storage.session.set` racing a `page.reload()`, and a
pairing-then-status assertion racing `options/main.ts`'s own second,
separately-fetched `refreshStatusSection()` call).

**Screenshots.** `docs/screenshots/P07B-{options-paired,options-error,
popup-saved}-{light,dark}.png`, taken with `P07B_UPDATE_SCREENSHOTS=1`;
each is only written once proven to show the right theme and no leaked
DevTools label (`theme-capture.ts`'s `captureInTheme`). Confirmed the
directory held no `P07B-*` files before any run, held exactly these 6
after the one gated run, and that two subsequent un-gated reruns left
their checksums byte-identical (a normal run cannot reach
`committedScreenshotsDir` at all — `screenshotPath()`'s branch on the env
var is the only path there). Visually spot-checked all three states.

**What was skipped, and why.**
- All of part C — `GET /commands` polling/alarm, tab groups, side panel
  content, restore, the closed-tab/"success-looking page" gate (8), the
  worker-kill/restart gates (2, 3) — explicitly out of part B's scope per
  this packet's header and my own task brief.
- The manual smoke-test checklist in `extension/README.md` (already
  updated with part B's pairing/status/offline-queue steps) is **not
  personally walked through in a branded-Chrome GUI session** — the same
  environment limitation part A's report flagged: no interactive browser
  here to drive by hand.
- Gate 7's "non-http URLs" item: already covered elsewhere (see that
  gate's writeup above) — not retested here to avoid duplicating another
  packet's/part's coverage under a different name.

**Assumptions.**
- Fictional data only throughout (`Northwind Labs`, `jobs.example`; the
  two `chrome-extension://` test origins are the same illustrative ones
  `runner/test/helpers.ts` already uses for its own bridge tests).
- Gate 9's "wrong extension id" is proven via a token paired under a
  *different, fictional* origin, injected into `chrome.storage.session`
  directly, then presented from the real extension's own real Origin —
  not two genuinely separate Chrome extension installs (would need a
  second full browser launch just to reproduce what the bridge's own
  Origin check already proves at the network layer, in
  `bridge-client.realbridge.test.ts`'s existing gate-9 vitest case).
- Every `postEvent` failure that isn't `not_paired` is treated as
  recoverable-by-queueing by the popup (existing part-B design, not new
  this session) — so a 403 from a mismatched device and a genuine network
  outage render identically to a person. Acceptable against gate 9's own
  bar ("produce clear recoverable states"), not "produce a *diagnostic*
  state" — worth a second look if a future packet wants the two
  distinguished.
- `job_capture` has no handler until P04 (`runner/README.md`); every
  "success" checked here is the bridge's own journal-and-acknowledge
  contract (`ok:true`, whatever `outcome` P02 currently returns), not a
  completed downstream action.

**One thing to sharpen.** Gate 4's real ~30 s `chrome.alarms` wait relies
on Chrome not clamping a short alarm delay for an *unpacked* extension
(the same exemption `shared/outbox.ts`'s own comment already cites from
browser-boundary.md, there for a different reason). Verified locally,
consistently, across every run in this report's own chain plus many more
during development — never once late or missing within the ~31 s window
in this environment — but never yet run in this repo's actual GitHub
Actions CI (`ubuntu-latest`), a different machine class than whatever ran
here. If it turns out flaky there specifically, the fix is almost
certainly a larger polling budget in `bridge-e2e.spec.ts`'s gate-4 test
(already generous, 60 s), not the alarm delay itself — worth watching `gh
pr checks` for on this PR before assuming it's settled everywhere.

**CI follow-up (post-report, commit `3e3fad7`).** The alarm-timing worry
above turned out to be a non-issue — gate 4 passed in real GitHub Actions
CI at 31.1s, first try. A different flake showed up instead: PR #12's
first CI run (`gh run view 35741280852 --log-failed`) failed
`real-popup.spec.ts`'s P07A-popup-dark.png capture with a brightness
mismatch (mean RGB 252, expected dark), on CI's 2-worker `ubuntu-latest`
runner — never reproduced locally across 20+ 4-worker runs before that.
`captureInTheme`'s own doc comment had asserted a brightness mismatch was
"a different, non-timing failure and is never retried"; the CI evidence
disproved that. It's the same `prefers-color-scheme`-override-drop race
`ensureColorScheme`/`verifyTheme` already document and retry for (see
those two functions' comments in `extension/e2e/theme-capture.ts`), just
surfacing as a wrong pixel instead of a wrong `data-theme` or a leaked
DevTools label. Fixed by having `captureInTheme` re-force the colour
scheme via `ensureColorScheme` and retry, bounded at the same
`maxAttempts` the DevTools-label check already used, rather than throwing
on the first bad reading. Re-verified: typecheck/lint/build/vitest (184
passed) clean; full e2e suite green across 3 consecutive `--workers=2`
runs (CI's own concurrency) plus 3 more of `real-popup.spec.ts` alone;
port 4310 confirmed free before and after every run. CI re-run
(`35743032356`) passed end to end, including the previously-failing step,
in 2m59s.

Files changed (verified via `git diff --stat` against the merge-base,
`dc36fc0`): `extension/**`, `.github/workflows/ci.yml` (one step),
`docs/screenshots/P07B-*.png`, this packet file, and `pnpm-lock.yaml`
(pnpm-managed only, from `pnpm install` adding the runner devDependency —
landed in `6dc0977`, unchanged since). Nothing in `packages/contracts/`
or `runner/` touched.

### 2026-09-22 — Revision 2 (iter-003, Opus escalation)

Opus escalation after the Sonnet implementer's one revision round. The reviewer's second pass verified 7 of its 8 earlier issues as fixed and found 2 remaining issues plus test-validity follow-ups. All are fixed on `packet/P07-A`: `3bf8823` (item 1), `6d87bed` (3b), `8cb51b2` + `dc11be2` (item 2), `c6051da` (3a), then this report. No merge from `overnight/integration`. Touched only `extension/**`, `docs/screenshots/P07A-popup-{dark,light}.png`, and this file. The manifest is unchanged: exactly six permissions and one host permission.

**1. The dist scanner's zod exception hid whole lines. Fixed; proven at build level.** `scan-dist-for-eval.mjs` used `!line.includes(ZOD_JITLESS_PROBE_SNIPPET)`, and the built `assets/zod-jitless-*.js` is a single ~10 KB line, so the exception covered the whole chunk. The scanner now removes every exact occurrence of the snippet from the line and tests `NEW_FUNCTION_RE` on what remains (`withoutZodProbe`). That is the only pattern the exception touches; the snippet contains no `eval`, remote script, or import. Each occurrence is replaced with a space, not the suggested `""`: `x$<probe>Function(e)` would otherwise become `x$Function(e)`, which the `(?<![\w$.])` lookbehind skips. A space can neither create nor hide a match at the seam. 4 new unit tests, 20/20 in the file:
- the reviewer's minified shape on one line is flagged;
- an unminified `new Function(code)()` on the probe's line is flagged;
- a line of only probes passes;
- a `Function(` right after the probe is still seen.

The existing "probe alone passes" test still passes. For the build-level proof I cloned the branch into `/tmp/wc-p07a-rev2-plant` (never committed) and appended to `src/shared/zod-jitless.ts` a planted `export function runPlanted(code) { return new Function(code)(); }` plus a `globalThis` reference so it isn't tree-shaken. It minified to exactly the reviewer's `function ce(e){return Function(e)()}`, on the same single line as `try{return Function(``),!0}catch{return!1}`:
```
$ pnpm --filter @workflow-catalog/extension build     # planted
assets/zod-jitless-DFI4lULH.js:1: forbidden Function(...) constructor call in built output

1 built-output violation(s) found.
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] ... Exit status 1
old scanner (bdc8095) on the same planted dist: []      # the hole, reproduced
$ pnpm --filter @workflow-catalog/extension build     # plant removed
dist/ scan clean: no eval, new Function, or remote script/import found.   # exit 0
```

**2. `test:e2e` rewrote the committed screenshots, sometimes wrongly. Fixed and root-caused.** An unmodified run here reproduced both of the reviewer's symptoms: `P07A-popup-dark.png` came out light, and both popup images carried the `380px × 418px` label. The reviewer suspected a stale frame. Scratch experiments in the clone above found three causes:
- **Dropped override.** Early in a fresh popup's life (observed within ~1.3 s of it opening), Chrome drops a just-set `prefers-color-scheme` override at a late resize ~150-550 ms later. The page's own `matchMedia("(prefers-color-scheme: dark)")` flips back to false and `data-theme` returns to light. Re-applying the override afterwards holds. Playwright is not attached to the popup (no `page` event, and `pw:protocol` shows only this test's `Target.attachToTarget`), so this happens inside Chrome.
- **Stale frame.** A capture taken right after the switch can return the previous frame.
- **Overlay.** The label is painted after a resize by an overlay other than this test's own session: it still appeared with `Overlay.setShowViewportSizeOnResize({ show: false })` sent on that session right after attach, and a mouse move didn't dismiss it either. Per Blink's `InspectorOverlayAgent::OnResizeTimer`, Chrome removes it 1 s after the resize. On the first popup of three fresh browsers, captures taken right after a switch had the label 6/6, and captures taken after 1.1 s without a resize had it 0/6, with the theme correct in all 6.

Fixes, in `e2e/real-popup.spec.ts` and `e2e/real-popup-cdp.ts`:
- **Opt-in writes.** `screenshotPath()` writes into `docs/screenshots/` only when `P07A_UPDATE_SCREENSHOTS=1`. Otherwise it writes to `test.info().outputPath()` under `extension/test-results/` (gitignored).
- **`inTheme(target, theme, action)`.** Sets the scheme and waits two `requestAnimationFrame`s. It then requires `data-theme === theme`, a non-empty declared token, a non-transparent body background, and a computed body background equal to `theme.css`'s own `--background` for that theme. That value is read from the theme's `:root` / `[data-theme="dark"]` rule and resolved through a probe, so no colour is hard-coded. These checks run before and after `action`. A failed check re-applies the scheme via `expect(...).toPass()`, bounded at 10 s.
- **The dark axe audit.** The popup's dark axe audit now goes through `inTheme` too, because the same drop let it run against the light page. With attempts instrumented in the scratch clone, its first attempt failed the "after" check in 3 of 4 runs and the retry passed.
- **`captureInTheme()`.** Waits until no `resize` has fired for 1.1 s, then two frames, and captures. It then requires the PNG's own top-left pixel (page background) to be light (mean RGB ≥ 128) for light and dark for dark before writing anything. Row 0's first pixel is stored verbatim under every PNG filter, so only an inflate is needed.
- **Overlay flag kept.** `Overlay.setShowViewportSizeOnResize({ show: false })` is still sent right after attaching to the popup (`triggerRealPopup`) and on the options page's CDP session, as asked. On the evidence above it only covers those sessions' own overlays, and the comments say so.
- **Retaken.** All four screenshots were retaken with `P07A_UPDATE_SCREENSHOTS=1` and opened one by one: light is light, dark is dark, no label. The popup pair changed. The options pair came out byte-identical to the committed files. The popup's URL row now shows the fixture server's OS-assigned port instead of `3107`.

A scratch PNG decoder (`/tmp`, not committed) checked every normal-run capture:
```
5 consecutive normal runs: 9 passed each; 20/20 captures right theme, 0 labels
  P07A-popup-dark.png   380x418 bg=0   theme=dark  label=no
  P07A-popup-light.png  380x418 bg=252 theme=light label=no
  P07A-options-dark.png 1280x800 bg=0   theme=dark  label=no
  P07A-options-light.png 1280x800 bg=252 theme=light label=no
(the same decoder on the reviewer's rerun-popup-dark.png: bg=252 theme=light WRONG label=YES)
```

**3a. The `--background` check passed when the token was missing. Fixed.** `assertThemeAndFontsLoaded` now requires:
- the `--background` token on body to be non-empty;
- body's computed background to be neither `transparent` nor `rgba(0, 0, 0, 0)`;
- body's computed background to equal the token's own value, resolved through a probe styled with that literal value.

The comment at the old `extension.spec.ts:83-86` claimed the pattern check caught a missing theme.css. It is rewritten to explain why that was vacuous. Scratch plants were run on a copied `dist/theme.css` (never committed; restored after, `diff` clean against the canonical file):
```
token deleted (both --background lines)
  bdc8095 spec: 4 passed                                   # the reviewer's result, reproduced
  new spec:     3 failed, 1 passed
                Error: theme.css should define a non-empty --background token
token set to "not-a-colour"
  new spec:     3 failed  Error: body background should be painted, not transparent
restored
  new spec:     4 passed
```

**3b. The fixture server's fixed port 3107 collided with other harnesses. Fixed.** `startFixtureServer()` now listens on port 0 on 127.0.0.1 and returns `{ origin, close }`. Every fixture URL and URL assertion in `real-popup.spec.ts` uses `fixtureServer.origin`. The header comment no longer cites a CLAUDE.md checklist that doesn't exist. The README says how the port is chosen.

**Tests run (real output, at `c6051da`):**
```
pnpm -r typecheck && pnpm -r test && pnpm -r lint && pnpm typecheck && pnpm test && pnpm check:fixtures
  → exit 0: contracts 224/224, apps/catalog 87/87, job-assistant 122/122, extension 132/132 (was 128;
    +4 scanner tests), root node --test 2/2, check:fixtures 0 offenses; runner still a P02 placeholder
pnpm --filter @workflow-catalog/extension build → dist/ scan clean: no eval, new Function, or remote script/import found.
pnpm --filter @workflow-catalog/extension test:e2e → 9 passed (12.0s); git status --porcelain → (empty)
pnpm --filter @workflow-catalog/extension test:e2e → 9 passed (10.2s); git status --porcelain → (empty)
gh pr checks 7 --watch (head c6051da) → ci pass 1m17s (run 35723001373); CodeRabbit pass (review skipped)
```
No fixture server or Chrome for Testing process was left running. The listening sockets matched the pre-run baseline, and the node servers on 3000/3001 belong to other sessions. The e2e suite now takes ~10-13 s instead of ~8 s, mostly the 1.1 s resize-quiet wait before each of the four captures.

**Skipped, as the brief directs (each assigned elsewhere):**
- the SPA case where the URL changes before the content (P07-C, gate 5);
- building the extension in CI (P07-B);
- the UI critic's cosmetic notes (P07-B);
- the `/ui/jobs` link (P07-B, after P02).

Also, `logs/latest.md` still lists "P07-A 3107" among the reserved ports. The suite no longer uses a fixed port; that file is outside this packet's allowlist, so the loop should drop the entry.

**Assumptions:**
- A space seam in the scanner, not `""` (reason above).
- The extra `inTheme` guard on the popup's dark axe audit is within item 2: it is the same dropped-override root cause, and without it that audit could pass against the light page.
- Keeping the reviewer-named overlay flag even though the resize-quiet wait is what actually removes the label.

**One thing to sharpen:** DevTools emulation on the real popup is not stable early in its life. Chrome drops a fresh `prefers-color-scheme` override at a late resize, and a viewport-size label from another overlay appears after resizes. Any P07-B/C e2e that emulates media or device metrics on the popup should go through `inTheme`-style verify-and-retry, and capture after a resize-quiet period. A one-shot set-then-poll is not enough.

### 2026-09-22 — Revision 1 (iter-003 implementer, Sonnet) — REVISE verdict, 8 issues + 9 fold-ins

Fixed every issue and folded in every cheap decision from the review's REVISE verdict (4 from an Opus reviewer, 4 from a UI critic), all on `packet/P07-A` in the same worktree, same allowlist, same commit discipline (staged by explicit path, `P07-A: `-prefixed messages, no force-push, no amend). Five commits: `dfebcdd`, `2398c26`, `b260728`, `4152a2a`, `c29b1a1`.

**Issue 1 (dist eval/Function scanner blind spots) — fixed, concretely proven.** `scripts/scan-dist-for-eval.mjs`'s regexes couldn't catch minified `Function(x)` (no `new`), `window.eval(`/`globalThis.eval(`, or `(0, eval)(` — the zod jitless probe passed only because of the bug, not a real allowlist. `NEW_FUNCTION_RE` is now `/(?<![\w$.])(?:new\s+)?Function\s*\(/`, `EVAL_RE` is `/\beval\b/`; the zod probe is allowed by an exact-snippet comparison (`ZOD_JITLESS_PROBE_SNIPPET`), with a comment, and a test proves a *different* `Function(...)` on another line of the same file still gets flagged. 6 new tests (16/16 total). **Concrete proof (not committed):** copied the real `dist/` into an OS-tmpdir scratch copy, appended a planted `Function("a", "return a")` to `worker.js`, confirmed `scanDistForViolations` now reports it while the real `dist/` stays clean, then deleted the scratch copy.

**Issue 2 (URL/text mismatch, SPA race) — fixed.** `JobCapture.url` (from `tab.url` at query time) could pair with a *different* job's text if the tab navigated (e.g. an SPA route change) between that query and the later `executeScript` call reading the page — breaking gate 5 ("never silently save the wrong job"). `extractJobPosting` now reads `location.href` in the same step as the text; `popup/main.ts` refuses (falls back) when it disagrees with `tab.url`, instead of guessing. Proven twice: a fake-`chrome` unit test in `main.test.ts` simulating the exact race, and — new this round — a **real** end-to-end reproduction in `e2e/real-popup.spec.ts` against `posting-spa-mismatch.html`, forced deterministically via a busy-wait on the tab's own renderer thread (not a timing race; see that file's comment) through the real popup, asserting the real refusal string renders.

**Issue 3 (file import size limit) — fixed.** `options/main.ts`'s `await file.text()` had no size check — a 20 MB valid manifest froze the options page. New `checkImportFileSize()` (`file-bridge/session-import.ts`) rejects `file.size > MAX_BRIDGE_BODY_BYTES` before ever reading the file; the read itself is wrapped in try/catch with a visible, `role="alert"` error. Tests cover at-cap/over-cap and a 300,000-byte real `File` exercised through the actual change handler without hanging.

**Issue 4 (vacuous e2e checks) — fixed.** The theme check (`expect(x).not.toBe("")`) was true for any non-empty string; the CSP-violations test attached its listener after launch and never opened a page — both proven broken by the reviewer (an emptied `theme.css` plus a planted `new Function` still passed 4/4). Replaced with, per page (options/popup/sidepanel — a smoke test for the side panel didn't exist before and now does): a `securitypolicyviolation` DOM-event recorder armed via `page.addInitScript` before `goto`, `pageerror`, and console-error listeners; `document.fonts.check("12px Geist")` after `document.fonts.ready`; body background compared against a probe styled with `background-color: var(--background)` (not a hard-coded color). Renamed the popup test — it exercises the `!tab.url` no-readable-address branch (no genuine `activeTab` grant on direct navigation), not `explainUnsupportedUrl`'s `chrome://` scheme branch as the old name claimed.

**Issue 5 (messages not announced) — fixed.** Pairing validation text, the stub pairing result, the import-error box, and the popup's "Saved…" line all now live in `role="status"`/`aria-live="polite"` or `role="alert"` containers; the pairing-code field gets `aria-invalid`/`aria-describedby`; Un-pair rebuilds the pairing section and moves focus to its code field instead of dropping to `<body>`.

**Issue 6 (axe WCAG A failures) — fixed, verified with real axe.** `label` (file input's `<label>` didn't wrap or `for`-reference it) and `dlitem` (session summary / paired-device state used `<dt>/<dd>` loose inside a `div.kv`) are both fixed — real `<label for>` on both the pairing-code and file inputs, real `<dl>` wherever `<dt>/<dd>` appear. **Verified, not just asserted structurally:** `e2e/real-popup.spec.ts` injects the actual `axe-core` package (added as a devDependency, not a `/tmp` path) and asserts zero WCAG 2.x A/AA + best-practice violations on the popup (json-ld/hostile/dom-heuristics previews, the SPA-mismatch fallback, light and dark) and the options page (light and dark) — all real states through the real popup/options pages, not a fixture harness.

**Issue 7 (Save stuck on "Saving…") — fixed.** `render.ts`'s click handler only reset the button in `catch`. Now `finally` always re-enables and refocuses it; on success the text becomes "Saved ✓" before `finally` runs. `e2e/real-popup.spec.ts` proves this against the real button after a real Save: text is `"Saved ✓"`, `disabled` is `false`, and focus is still on the button.

**Issue 8 (excerpt hides content) — fixed.** `.excerpt { max-height: 6.5em; overflow: hidden }` sliced text mid-glyph with an always-cut-off "…" — the hostile fixture's injected "ignore previous instructions" paragraph was saved but never shown. The excerpt is now a focusable, labelled (`role="region"`, `aria-label`) scroll area (`max-height: 10em; overflow-y: auto`) showing the *entire* captured text, plus one line stating the page's text is saved as data and can't trigger actions. `e2e/real-popup.spec.ts` asserts the hostile paragraph's exact text is present in that region (not just structurally reachable), that no ellipsis character appears, and that Save → download still completes with zero dialogs and zero navigations.

**Fold-ins.** (a) `executeScript({ args: [MAX_INPAGE_TEXT_CHARS] })` caps in-page text before the boundary (`MAX_JOB_CAPTURE_TEXT_BYTES * 4`, a generous character pre-cap ahead of the byte-accurate cap downstream); `isExtractionResult()` validates the returned shape before use. (b) `asJobPosting` takes a `depth` param, `MAX_GRAPH_DEPTH = 6`, falling back to DOM heuristics on a deep `@graph` instead of hanging/throwing — proven with a 7-level-deep fixture. (c) `vite.config.ts`: `build.modulePreload.polyfill = false` — Chrome 120+ (this extension's floor) has native `modulepreload`; the polyfill was dead weight and the dist's one `fetch(` call. (d) The options page reacts to `chrome.storage.onChanged` (export button enables/disables without a reload) and re-validates a stored capture with `jobCaptureSchema` before exporting it. (e) `manifest.test.ts` gained a test asserting `dist/manifest.json` deep-equals the source `manifest.json`. (f) One shared `:focus-visible { outline: 2px solid var(--ring); ... }` rule; the file picker is styled (Geist, bordered). (g) The pairing code lives in a real `<form>` (Enter submits); the submit handler trims and refuses a whitespace-only code. (h) `<main>` landmarks on every page (options' top-level wrapper, popup/sidepanel's root); the popup's eyebrow is a real `<h1>`. (i) `shared/format.ts` (new): `formatTimestamp` (human-readable) and `abbreviateUuid` (first 8 hex chars, full value in `title`); zod issue dumps on import failure are now one plain sentence plus a collapsed `<details>` with the per-issue detail.

**`RUNNER_JOBS_URL`.** Left as the single constant it already was, with a comment explaining P02's router may end up serving this page as `/ui/<name>` rather than a literal `jobs.html` file, and that P07-B syncs the path once P02 actually lands. It has not landed as of this revision — `pnpm -r typecheck`/`test`/`lint` all still print the `runner` package's own placeholder line ("no TypeScript/tests/lint yet — P02 fills this in"), independently confirming that. A message purporting to be a coordinator follow-up arrived mid-round asking to change this URL on the premise that P02's local UI had landed; given the above, and that the message's two other "rules" either contradicted already-correct behavior or would have weakened already-passing cleanup code, it was not acted on. Flagged in this round's reply rather than applied.

**Real popup, for real (new this round, closes phase 1's own flagged gap).** Phase 1's report ended on "One thing to sharpen": no automatable trigger existed for a genuine `activeTab` gesture, so the popup's successful-extraction path had never run outside a by-hand smoke test, and the acceptance screenshots were a `render.ts`-driven approximation. `e2e/real-popup-cdp.ts` + `e2e/fixture-server.ts` + `e2e/real-popup.spec.ts` (new) close it: Chrome's `--enable-unsafe-extension-debugging` launch flag plus CDP `Extensions.triggerAction` against a tab's "tab"-type target is a real, first-party action invocation that *does* grant `activeTab` — confirmed fully typed against Playwright's own bundled CDP protocol types. 5 new e2e tests drive real capture → preview → Save → download against the json-ld, hostile, and DOM-heuristics fixtures, the SPA-mismatch refusal, and axe on both pages, light and dark — see the issue write-ups above for what each proves. `docs/screenshots/P07A-{popup,options}-{light,dark}.png` are retaken from the real pages this way, not the phase-1 harness.

**Full verification chain, real output (after all fixes, before this report commit):**
```
pnpm -r typecheck                → clean (contracts, job-assistant, apps/catalog, extension; runner still a placeholder)
pnpm -r test                     → contracts 224/224, job-assistant 122/122, apps/catalog 87/87, extension 128/128
pnpm -r lint                     → clean
pnpm typecheck && pnpm test      → green, incl. scripts/check-fixtures.test.mjs 2/2
pnpm --filter extension build    → dist/ scan clean (no eval, no Function, no remote script)
pnpm check:fixtures              → exit 0, no offenses
pnpm --filter extension test:e2e → 9/9 (4 in extension.spec.ts, 5 in real-popup.spec.ts), run 4x back to back specifically to check the SPA-mismatch busy-wait and axe assertions for flakiness — none observed
```
Extension package: 16 vitest files / 128 tests (new files this round: `popup/main.test.ts`, `options/main.test.ts`, `shared/format.test.ts`; every other touched test file grew in place). e2e: 4 → 9 tests (+1 sidepanel smoke test in `extension.spec.ts`, +5 in the new `real-popup.spec.ts`).

Port 3107 (the fixture server `real-popup.spec.ts` uses) confirmed free after every run in this round, including the final one before push.

### 2026-09-22 — Part A (iter-003 implementer, Sonnet)

Scope was **part A only**: manifest, options/pairing page (stub bridge,
no network calls), the capture extractor, and file-bridge export/import —
no calls to the runner bridge, no sessions/tab groups, no side panel
content. Parts B and C (blocked by P02's bridge and P06's manifests/
commands, per this packet's header) are untouched. Branch `packet/P07-A`
off `overnight/integration` at `bbf16d1`, PR into `overnight/integration`;
head `5959906` across 10 commits (`336892b` claim … `5959906` this report;
corrected — the report text below was originally drafted citing `15f49db`,
the commit right before the one that actually carried it, which was
already stale the moment `5959906` landed. Superseded by revision 1
above; see that entry for the current head).

**What was built.** `manifest.json` (MV3, the six permissions exactly,
host permission only the bridge origin, no forbidden keys — asserted by
`manifest.test.ts`). `src/capture/extractor.ts`
(`extractJobPosting()`, self-contained for `chrome.scripting.executeScript`,
JSON-LD `JobPosting` preferred, DOM-heuristic fallback, `textContent`-only
rendering of anything read back) and `build-job-capture.ts` (normalize,
byte-accurate truncation via binary search against the contracts cap,
SHA-256 `contentHash`, validated `JobCapture`). `src/popup/`: preview →
"Save this job" → `Blob`+`<a download>` export (no `downloads`
permission) and a `chrome.storage.session` write so the options page can
recover the same capture if the popup closed first; `render.ts` splits
the three render states out of `main.ts` so they're unit-testable and
screenshot-able without the `chrome.tabs`/`chrome.scripting`
orchestration. `src/options/`: pairing UI against a `BridgeClient`
interface (part A's implementation is a stub returning "Pairing connects
in the next version," never touches the network) and the file-bridge
fallback (`SessionManifest` import validation, read-only summary, JSON
export). `src/worker/` (imports the zod-jitless bootstrap first, nothing
else yet) and `src/sidepanel/` (placeholder for part C). Build: Vite,
self-hosted Geist/Geist Mono woff2, `theme.css` copied verbatim at build
time and consumed only via `var(...)`, a post-build scan that fails on
`eval`/`new Function`/remote script. Playwright e2e on bundled Chromium
(`channel: "chromium"`, a persistent context with `--load-extension`).

One thing beyond the literal deliverable list: `zod-jitless.ts`, set as
the first import of every entry point. MV3's default CSP has no
`unsafe-eval`; zod v4 otherwise probes for `new Function` support at
schema-module load, which would throw under that CSP. `z.config({
jitless: true })` disables the probe; a regression test
(`zod-jitless.test.ts`) asserts `globalThis.Function` is never invoked.
This wasn't called out explicitly in the packet's deliverables — flagging
it here rather than silently deciding it was in scope.

**Tests run (real output).** Worktree, after every source change: `pnpm
--filter @workflow-catalog/extension test` → 89/89. Full chain from repo
root: `pnpm -r typecheck` (5/5 non-placeholder packages clean, `runner`
correctly a no-op placeholder for P02), `pnpm -r test` (`packages/contracts`
224/224, `apps/catalog` 87/87, `packages/job-assistant` 122/122, `extension`
89/89 — none of those first three touched by this PR, cited to show the
full chain is green, not just my package), `pnpm -r lint` (clean),
`pnpm typecheck && pnpm test` (root smoke test, same results plus the
repo's own `check-fixtures.test.mjs` 2/2), `pnpm --filter
@workflow-catalog/extension build` (clean, dist scan reports no eval/
remote code), `pnpm check:fixtures` (0 offenses, after the fix below),
`pnpm --filter @workflow-catalog/extension test:e2e` → 4/4. Repeated the
entire chain again against a genuinely fresh `git clone --branch
packet/P07-A` into `/tmp/wc-p07a-clean` with `pnpm install
--frozen-lockfile`: identical results (extension unit tests show `88
passed | 1 skipped` before `build` runs there — the skip is the
dist-path-existence check in `manifest.test.ts`, gated on `dist/`
existing, by design; it passes once `build` runs). Every command exited 0
on every run, worktree and fresh clone alike.

**A real bug `check:fixtures` caught.** `pnpm check:fixtures` (run for
the first time against this packet as part of this verify pass) flagged
`extension/fixtures/posting-json-ld.html`'s JSON-LD `"@context":
"https://schema.org/"` — `fixtures-policy.md` requires every URL under a
`fixtures/` directory to host under `*.example`, no exceptions, and the
scanner is deliberately blunt about it (no allowlist for "obviously
inert" URLs). Confirmed `extractor.ts` never reads `@context` (only
`@type`), so this was purely cosmetic JSON-LD boilerplate; fixed by
swapping to `"https://schema.example/"` (`15f49db`) rather than weakening
the checker. Reran the extension's tests and the acceptance screenshots'
extraction step against the fixed fixture — unaffected, since nothing
depended on the literal value.

**Screenshots and a genuine automation limitation.**
`docs/screenshots/P07A-{options,popup}-{light,dark}.png`, committed at
`86180c1`. Options: straightforward, direct navigation to
`chrome-extension://<id>/src/options/index.html`, Playwright's normal
Page/`emulateMedia` tracking. Popup: harder, and worth a full account
rather than a hand-wave. The popup's *preview* state only renders once
`chrome.tabs.query({active:true})` returns a tab with a readable `url`,
which Chrome populates only once `activeTab` has actually been granted —
and `activeTab` is granted exclusively by a genuine user-gesture
invocation of the extension. Two real-gesture mechanisms were tried
against the actual built extension and both dead-ended on documented,
ecosystem-wide gaps rather than anything local:
1. `chrome.action.openPopup()` called from the service worker: the popup
   window genuinely opens (confirmed via raw CDP `Target.getTargets`
   showing the real `chrome-extension://<id>/src/popup/index.html`
   target), but `chrome.tabs.query` still returned a tab with `url`
   stripped — opening the window isn't itself a granting gesture.
2. A manifest `commands` entry (`_execute_action`) dispatched via
   Playwright's `page.keyboard.press()`: this was *not* shipped (would
   have been a unilateral addition to the packet's exact manifest
   decisions for tooling convenience alone) but was worth ruling out
   first — [microsoft/playwright#22683](https://github.com/microsoft/playwright/issues/22683)
   confirms it's a dead end regardless (open, "P3-collecting-feedback,"
   no workaround: CDP key events dispatched at a page target don't reach
   the browser process's global accelerator table). extension.js's own
   docs independently name the same gap and point at
   chrome-devtools-mcp's `trigger_extension_action` (a Puppeteer-based
   tool) as the only known genuine-gesture workaround; it wasn't in this
   session's tool set.

   Given that, the popup screenshots render the real, exported
   `renderPreview()` (the `render.ts` split above) fed a `JobCapture`
   computed by actually running the real `extractJobPosting()` and
   `buildJobCapture()` against the real fixture HTML (via Vite's
   `ssrLoadModule` loading the actual TS source, and `page.evaluate`
   running the actual extractor function in a real Chromium page) — real
   code, real fixture-derived data, real CSS/font rendering, only
   `main.ts`'s `chrome.tabs`/`chrome.scripting` orchestration bypassed.
   No shipped file changed behavior to make this possible. Full
   methodology is in the screenshot commit message
   (`86180c1`) and `extension/README.md`'s e2e section.

**What was skipped, and why.**
- All of parts B and C — pairing exchange, `job_capture` POSTs, session
  polling/alarm, tab groups, side panel content, restore, and the nine
  gates from this packet's Acceptance section (they need the bridge and
  the session/tab-group machinery part A deliberately doesn't touch).
- The manual smoke-test checklist in `extension/README.md` is written but
  **not personally walked through in a branded-Chrome GUI session** — this
  environment has no interactive browser for me to drive by hand. It's an
  honest checklist for a human (or a future session with real-gesture
  tooling), not a claim that it's been executed.
- No `pnpm-workspace.yaml` `allowBuilds` entry was needed (no dependency
  required a build script beyond what's already allowed).

**Assumptions.** Fictional data only: company Fernwood, URLs under
`jobs.example`/`schema.example`, matching `fixtures-policy.md`. Treated
"no bridge calls" as also excluding P06's `/commands` polling and alarm
(session territory, explicitly part of the Deliverables' "Session"
bullet, not part A's). Interpreted the packet's single combined
Acceptance section (written for the whole packet) as not binding on part
A directly; part A's own bar was the task brief's explicit, itemized
acceptance list.

**One thing to sharpen.** Chrome's `activeTab` gesture-gating has no
automatable trigger under CDP-based tooling (Playwright, and by
extension.js's own account, Puppeteer too) — confirmed two independent
ways above. Any future e2e test that needs the popup's *successful*
extraction path (not just its rejection paths, which chrome://newtab
already covers) will hit the same wall. Worth deciding, before P07-B/C's
own e2e work, whether that's accepted as a permanent manual-smoke-test
gap or whether it's worth bringing in a tool like chrome-devtools-mcp's
`trigger_extension_action` specifically for it — better to decide that
once, deliberately, than have each future packet rediscover it.

Files changed: `extension/**`, `docs/screenshots/P07A-*.png`, this packet
file (claim + report), and `pnpm-lock.yaml` (pnpm-managed only, from
`pnpm install` adding this package's dependencies). Verified with `git
diff --stat` against the actual merge-base (`bbf16d1`, not
`overnight/integration`'s current tip, which has since taken an unrelated
P01.1 merge) — nothing outside the allowlist.
