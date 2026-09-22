# P07 · Chrome extension

Status: claimed (part B)
Assignee: iter-003 implementer (Sonnet), part A; revision 2 iter-003 (Opus); part B iter-004 implementer (Sonnet)
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
