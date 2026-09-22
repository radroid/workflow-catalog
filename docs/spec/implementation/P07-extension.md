# P07 · Chrome extension

Status: claimed (part A)
Assignee: iter-003 implementer (Sonnet), part A
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

### 2026-09-22 — Part A (iter-003 implementer, Sonnet)

Scope was **part A only**: manifest, options/pairing page (stub bridge,
no network calls), the capture extractor, and file-bridge export/import —
no calls to the runner bridge, no sessions/tab groups, no side panel
content. Parts B and C (blocked by P02's bridge and P06's manifests/
commands, per this packet's header) are untouched. Branch `packet/P07-A`
off `overnight/integration` at `bbf16d1`, PR into `overnight/integration`;
head `15f49db` across 9 commits (`336892b` claim … `15f49db` this report).

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
