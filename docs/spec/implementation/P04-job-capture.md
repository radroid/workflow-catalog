# P04 · Job capture

Status: claimed (iter 006)
Assignee: iter-006 implementer (Sonnet)
Blocked by: P03
Owns: runner/server/routes/captures.ts, runner/store/jobs.ts, runner/lib/safe-fetch.ts, runner/lib/readable-text.ts, runner/agent/tools/ (the job-extraction tool only), the eval-agent re-export, fixture and tool-registry entries and eval for it, runner/ui/jobs.html and its script, runner/test/ (new tests for these files), packages/job-assistant/fixtures/jobs/
Spec: F6, hard-problems #3

## Goal
A job posting becomes a versioned snapshot from any of three paths, and the snapshot is data.

## Deliverables
- `POST /events` handling of `job_capture` from the extension: bounded text, extractor version, content hash, dedupe by URL into revisions.
  - URL validation follows the contract's `httpUrlSchema`: http or https, and no other scheme.
  - A captured or pasted URL is provenance only; nothing on those paths fetches it.
  - Only the URL-fetch path is https-only (decision, iter 005: `logs/blocks.md`, "P04 URL rule").
- Paste path in the local UI. The URL path is a local-UI route in `routes/captures.ts`, not a model tool: model tools take IDs only (iter-003 decision).
  - It fetches through `runner/lib/safe-fetch.ts`: https only; no loopback, private, link-local or metadata addresses, checked after DNS resolution and on every redirect; a redirect limit, a size cap and a timeout; `text/html` or `text/plain` only.
  - It extracts the text with `runner/lib/readable-text.ts`.
  - P03.1 reuses both modules, so give each a small documented interface and its own tests. Tests use an injected resolver and a local fake server, never the real network.
- Structured extraction of `{ title, company, location, requirements[], niceToHave[], deadline?, applyUrl }` from the snapshot text into typed fields; the raw text is never placed in a system prompt.
- Jobs page: list, revisions, "posting changed" diff.

## Acceptance
- Three paths produce identical snapshot records for the same fixture text.
- Same URL captured twice with changed text → revision 2; revision 1 retained.
- Hostile posting fixture: extraction returns fields only; no action tool called; profile unchanged (assert store hash before/after).
- Rejected inputs:
  - `javascript:` and `file:` URLs on every path, and `http:` on the URL-fetch path;
  - loopback, RFC 1918, link-local and `169.254.169.254` targets, including after a redirect or a DNS answer;
  - bodies over the cap, and text over 200 KB.
- `job_capture` gets its handler here: today the bridge journals it as `no_handler`. The route module declares the event, and `route-modules.test.ts` needs no edit after P03's revision (D2).

## Out of scope
Preparation, sessions, the extension itself (P07 sends the envelope; this packet accepts it).

## Report

### 2026-09-23 — Job capture, single round (iter 006 implementer)

**PR:** [#14](https://github.com/radroid/workflow-catalog/pull/14) `packet/P04` → `overnight/integration`.

| Commit | What |
|---|---|
| `3287083` | Claim |
| `67bc034` | `safe-fetch.ts`, `readable-text.ts`, `JobsStore`, the `extract_job` tool (both roots), `captures.ts` routes, and their tests |
| `b8dbb52` | Jobs page: `ui/jobs.html`, `assets/jobs.js`, `assets/jobs.css`, `test/jobs-page.test.ts` |
| `ce903de` | `runner/README.md`: the Jobs page write-up and the corrected P04 row of "Extending the runner" |
| `5f3308d` | Fixed the job-extraction eval's `RUNNER_WORKSPACE` race; moved the profile-safety proof to a private-workspace Vitest test |
| `033a663` | Strengthened the "count a non-ok turn as extracted" mutation-proof test (it wasn't actually exercising the guard it claimed to) |
| `3e2c48d` | The 20 Jobs-page screenshots |
| (this commit) | This report |

**Deliverables → where.** Three capture paths (extension `job_capture` event, paste, `https://` fetch) all funnel through `JobsStore.captureJob` (`runner/store/jobs.ts`), so they share one dedupe-by-URL/revision-by-content-hash rule (F6). The URL-fetch path alone goes through `runner/lib/safe-fetch.ts` (https only; loopback/RFC1918/link-local/`169.254.169.254` refused, checked after DNS resolution and again on every redirect hop; a redirect limit, a size cap, a timeout) and `runner/lib/readable-text.ts` to turn HTML into plain text. Structured extraction is the `extract_job` tool (`runner/agent/tools/extract_job.ts`, re-exported for the eval agent), a thin `"use step"` wrapper over the directive-free `runner/agent/lib/extract-job-logic.ts::persistExtractedJob`, which takes only `jobId`/`revision` back and writes through `JobsStore.recordStructured` — the posting text itself only ever travels as user-turn data (`hard-problems.md` #3), never a system-prompt interpolation. The Jobs page (`runner/ui/jobs.html`, `assets/jobs.js`, `assets/jobs.css`) lists jobs, opens a detail panel with revision history, and renders a capped LCS line diff between adjacent revisions with no dependency.

**Acceptance → tests.**

| Acceptance item | Proved by |
|---|---|
| Three paths produce identical snapshot records for the same fixture text | `captures.test.ts` (corrected in round-1 revision: `jobs-store.test.ts` was also cited here, but it exercises `JobsStore.captureJob` directly, never the three HTTP paths — round-1 review L7 found the property this row claims was actually unproven, and false, at the time of this entry: only the URL-fetch path trimmed its text, so the same posting hashed differently depending on which path captured it) |
| Same URL, changed text → revision 2, revision 1 retained | `jobs-store.test.ts` ("a second capture of the same URL with different text creates revision 2 and keeps revision 1") |
| Hostile posting: extraction returns fields only, no action tool called, profile unchanged (hash before/after) | `extract-job-logic.test.ts` ("never touches the career profile — hostile posting fixture (hard-problems.md #3, assert store hash before/after)"); `job-extraction.eval.ts`'s `notCalledTool`/no-leaked-phrase assertions |
| Rejected: `javascript:`/`file:` on every path, `http:` on the URL-fetch path | `captures.test.ts` (corrected in round-1 revision: this row previously also cited `job-tools.test.ts`, which tests the `extract_job` tool wrappers' persist behaviour and has no URL-scheme assertions at all — a wrong citation, not merely an imprecise one) |
| Rejected: loopback/RFC1918/link-local/`169.254.169.254`, including after a redirect or a DNS answer | `safe-fetch.test.ts` (injected resolver + local fake server, never the real network) |
| Rejected: bodies over the cap, text over 200 KB | `safe-fetch.test.ts`; `captures.test.ts` (at the time of this entry, only the paste path's 200 KB cap actually had a test — the URL-fetch path's identical check was untested despite the citation implying otherwise; both paths are covered as of round-1 revision L11) |
| `job_capture` gets a real handler (was `no_handler`); `route-modules.test.ts` needs no edit (D2) | `captures.test.ts`; confirmed by running the existing `route-modules.test.ts` unedited |

**Mutation proofs — 5 of 5, each applied → red → reverted → `git diff` clean → green.**

| # | Mutation | File | Killed by |
|---|---|---|---|
| 1 | Drop the post-redirect address check | `lib/safe-fetch.ts` | `safe-fetch.test.ts`: redirect-to-loopback/link-local/metadata cases |
| 2 | Accept `http:` on the fetch path | `server/routes/captures.ts` | `captures.test.ts`: URL-fetch scheme rejection |
| 3 | Put the posting text into the instructions | `agent/tools/extract_job.ts` (both roots) | `eval-agent/evals/job-extraction.eval.ts`'s no-leaked-phrase assertion |
| 4 | Skip the content-hash dedupe | `store/jobs.ts` | `jobs-store.test.ts`: same URL + same text → no new revision |
| 5 | Count a non-ok turn as extracted | `server/routes/captures.ts` / `agent/lib/extract-job-logic.ts` boundary (the `result.status !== "ok"` guard in the turn-outcome interpreter) | `captures.test.ts` — see below |

Proof 5 exposed a real gap in its own test before it proved anything: the original test scripted a *failed* turn that never called `extract_job` at all, so removing the status guard changed nothing (there was no tool result for the code to wrongly accept either way) — applying the mutation left all tests green, which is not what a mutation proof is supposed to show. Fixed by rewriting the test to script a successful-looking `extract_job` action result for the exact `jobId`/revision, immediately followed by `turn.failed`: now the guard is the only thing standing between that scenario and a wrongly-reported "extracted" outcome. Re-verified: red with the mutation applied, green after revert, `git diff` clean.

**Two eval-infrastructure races found, root-caused, and fixed (empirically diagnosed against eve's own docs, not guessed).**
- `eve eval` discovers every `.eval.ts` file by importing it, then runs all of them concurrently against **one shared dev-host process with one process-wide environment** (`node_modules/eve/docs/evals/*.mdx`; no per-eval `maxConcurrency` — `defineEval`'s only options are `description, judge, tags, metadata, timeoutMs, reporters`). `job-extraction.eval.ts`'s original top-level `process.env.RUNNER_WORKSPACE = ...` raced `onboarding-extraction.eval.ts`'s identical unconditional top-level assignment; whichever file's import finished last won, and the other's tool calls landed against the wrong workspace (`store.recordStructured` returned "No snapshot revision 1 for that job."). Fixed by resolving the workspace reactively inside `test()` (`openOrCreateWorkspace()`), reading `process.env.RUNNER_WORKSPACE` rather than setting it unconditionally.
- With that fixed, a second race remained, reproducing on every run, not intermittent: the "career profile is unchanged" before/after hash check was reliably poisoned because `onboarding-extraction.eval.ts`'s own concurrent tool calls write real, different content into the *same* shared `career-profile.md` inside the same run. This is an architectural property of `eve eval` (one shared workspace when both files' top-level code resolves to it, no per-eval isolation available), not a defect in this packet. Alternatives considered and rejected: a per-eval concurrency option (doesn't exist); temporarily swapping `RUNNER_WORKSPACE` around just this file's turn (would corrupt onboarding's own concurrent calls — harmful to another packet's eval); a global `maxConcurrency: 1` in `evals.config.ts`/`cli/eval.ts` (outside this packet's `Owns`, slows every packet's eval run, and does not even fix the import-time env race). Resolved by moving the profile-safety assertion to `extract-job-logic.test.ts`'s new "never touches the career profile" test, which uses its own private, non-shared workspace and therefore gets a deterministic answer — a stronger guarantee than the racy eval check ever gave, not a weakened one. The eval keeps its tool-call-identity assertions, which are valid regardless of shared state. Verified reliably green across repeated full `pnpm test` runs, including the one in this session's chain (`job-extraction` 15/15, `onboarding-extraction` 65/65, together, in the same process).

**Screenshots.** 20 files, `docs/screenshots/P04-jobs-{empty,list,revisions,diff,refused-url}-{light,dark}-{390,1280}.png`, full page. Harness: a throwaway seed+serve script under `/tmp/wc-p04-screenshots/` (never committed), calling `createBridgeApp`/`createRunnerContext`/`loadRouteModules(ROUTES_DIR)` directly (never `cli/{setup,doctor,runner}.ts`), bridge on `127.0.0.1:4330` only, `eve` left unset (none of the five required states need a live extraction turn — structured fields were seeded directly through `JobsStore`), signed in through the real `/ui/login?nonce=` flow (`ctx.uiLogin.issue(origin)`, redeemed by a real browser navigation). Fixture data is fictional: Northwind Labs, Ledgerkit, Harbor, all under a shared `jobs.example` host (an ATS-style shared hostname, matching this repo's own existing fixture convention rather than a bug). The refused-URL shot submits `http://169.254.169.254/...` through the real URL-fetch form and captures the real refusal it produces ("The runner only fetches https:// links…") — one of the acceptance list's required rejections (`http:` on the fetch path), reached end-to-end rather than staged.
- Caught and fixed during this pass: `resize_page(390, …)` does not actually yield a 390 CSS-pixel viewport on this Chrome build — it floors at an `innerWidth` of 500 (a native-window minimum), which would have silently mislabeled every "390" shot. Switched to `emulate({ viewport: "390x844x2" })` (CDP device-metrics override), confirmed `window.innerWidth === 390` before capturing, and redid all ten affected files (the empty pair needed a second, separate empty workspace, since the first had already been seeded).
- Verified: all 20 SHA-256 checksums unique (no accidental duplicates); `document.documentElement.scrollWidth === clientWidth` at both 390 and 1280 (no horizontal scroll) on the content-heaviest state (diff) and re-checked after the viewport fix.
- Harness stopped after use; confirmed nothing listening on 4310/4320/4330/4340/4350 afterward. Scratch data stayed under `/tmp/wc-p04-screenshots/`.

**Tests run, real output.** All from the repo root at `3e2c48d`, `git status --porcelain` clean before and after.
- `pnpm install --frozen-lockfile`: already up to date.
- `pnpm typecheck`: all 6 workspaces done.
- `pnpm test`: contracts 16 files/235 tests; job-assistant 6 files/153 tests; runner 43 files/668 tests, plus `eve eval` 6/6 files and 100/100 gates (`tool-surface` 4/4, `approval` 4/4, `missing-tools` 8/8, `skills` 4/4, `job-extraction` 15/15, `onboarding-extraction` 65/65); catalog 26 files/168 tests; extension 21 files/329 tests plus 1 file/5 tests skipped; root `scripts/*.test.mjs` 2/2.
- `pnpm -r lint`: 6 of 6 clean, `--max-warnings 0`.
- `pnpm check:fixtures`: exit 0.
- CI on PR #14 head `3e2c48d`: run [35940266893](https://github.com/radroid/workflow-catalog/actions/runs/35940266893), success (5m8s), including the extension build/vitest/Playwright e2e step. See the reply for this report commit's own head SHA and CI run.

**What was skipped, and why.**
- The 5 mutation proofs' apply/red/revert cycles were performed during the implementation commits (`67bc034`–`033a663`), not re-run a second time in this closing session; this session instead re-confirmed they hold by running the full suite green on the final code with a clean `git diff`, rather than re-breaking and re-fixing already-proven code. The detail above reflects what was actually done at the time, including proof 5's test-coverage gap.
- No screenshot of a live "extraction in progress" or "just re-extracted" transient state: the five required states (empty, list, revisions, diff, refused-url) don't call for one, and all five are reachable without a live `eve` connection, so the harness never wired one up.
- `runner/server/run-harness.ts`'s `events` field on `TurnResult` is additive only (one field, one test); no other caller of `TurnResult` was touched.

**Assumptions.**
- The screenshot naming convention follows P03's precedent (`P0N-<page>-<state>-<theme>-<width>.png`) since the packet didn't give exact file names.
- "Full page" screenshots are taken with `fullPage: true` at 1x DPR content scale reported by `window.innerWidth`/`clientWidth` (actual PNG pixel dimensions are 2x that, per this machine's device pixel ratio); this matches how the acceptance criterion reads ("at 390 and 1280") as CSS pixels, not raw PNG pixels.

**The one thing to sharpen in this packet next time.** The `RUNNER_WORKSPACE`-is-process-wide hazard is not really a P04 problem — it's a standing trap for every future packet that adds a new `.eval.ts` file alongside existing ones (P03.1, P05, and beyond will all hit it the moment two eval files' top-level code both want a fresh workspace, or two evals' tool calls touch the same shared file). Worth a short, explicit convention note in `docs/spec/research/eve-runtime.md` or the packets' `README.md` — "resolve `RUNNER_WORKSPACE` reactively inside `test()`, never assign it at top level; never assert on shared-workspace state that another eval file's tools can also write" — so the next packet doesn't have to re-diagnose this from scratch the way this one did.

### 2026-09-24 — Revision 1 (round-1 review response: L1–L14)

**Review:** `logs/handoff/P04-round-1-review.md`, reviewing head `e8b74de` (code head `3e2c48d`). Reviewer: REVISE, 9 issues + nits + mutation-proof findings. UI critic: REVISE, 9 issues + polish + committed-screenshot findings. Orchestrator decisions: L1–L14 (`## Revision 1: the orchestrator's decisions` in that file), same worktree/implementer.

**PR:** same [#14](https://github.com/radroid/workflow-catalog/pull/14), `packet/P04` → `overnight/integration`.

| Commit | L item(s) | What |
|---|---|---|
| `1562ad3` | L1, L2, L3, L4, L8 (M8 half) | Production transport handles both `lookup` callback shapes (Node 24 `autoSelectFamily`); IPv6 literals stripped of brackets and checked numerically via a hand-written parser + `net.BlockList` (loopback/unspecified in any notation, IPv4-mapped, IPv4-compatible, NAT64, `fc00::/7`, `fe80::/10`, `fec0::/10`, multicast); every body read in `safe-fetch.ts` guarded (never throws); one overall deadline across DNS/every hop/body; redirect bodies cancelled not drained; `accept-encoding: identity`; declared charset honoured; `readable-text.ts` rewritten as one linear `indexOf` pass (was quadratic backtracking) |
| `bea13fb` | L5 | Capture responds once the snapshot is saved; extraction queued and run in the background, one turn at a time per workspace; `ExtractionState` side-channel (waiting/running/done/not_run/failed + reason, "interrupted" derived at read time); `extractionPreflight` decides not-run synchronously; retry route now async |
| `1ff5b0a` | L6 | Only uuid-named directories scanned (`isJobId`); a damaged snapshot reads as absent, never throws; per-job try/catch in list/find as defense in depth |
| `20c910b` | L7 | One `normalizeCapturedText` (trim) applied inside `captureAndExtract`, the shared choke point for all three paths; URL-fetch route's fetch made injectable via a factory, not `context.ts` |
| `c927285` | L8 (prompt half) | New prompt-boundary test: START/END markers share one token, posting text appears exactly once, strictly inside the block |
| `98bbb40` | L9 | New shared `eval-agent/evals/eval-workspace.ts`; both eval files call `openOrCreateEvalWorkspace()` from their own top level, deciding fresh-vs-reuse via the env var itself (idempotent against eve's independent per-file module loading); new route-level hostile-fixture test in `captures.test.ts` (private workspace, checks fields-only/one-tool-call/profile-hash-unchanged together) |
| `1c2eefc` | L10 | `stripUrlForStorage` (drop userinfo + fragment) applied once inside `captureAndExtract`; fetch path's final URL (post-redirect) re-validated against the contract's bounded URL schema |
| `a712376` | L11 | `run-harness.ts`'s `events` only accumulates when `collectEvents` is true; `javascript:`/`file:` tests added to the event and paste paths (previously only URL-fetch had both); URL-fetch path's own 200 KB-after-extraction refusal tested; two wrong citations in the round-0 report corrected |
| `fb2aa1a` | L12 | Full Jobs-page rebuild: sticky "Last action" line; `aria-disabled` + delayed busy word; job naming from first non-empty line/URL path, never bare hostname; extraction-state sentences with reason + next step, never "structured fields"; `morphChildren`/`morphNode` keyed reconciliation (never destroys a focused node); client-side paste pre-flight with field-scoped errors; exact duplicate wording; `overflow-wrap: anywhere`; accessible diff markup; all 9 polish items |
| `9bd7009` | L13 | 29 screenshots retaken (20 stale files replaced, 4 obsolete `refused-url` files `git rm`'d, replaced by `refused-private` + 1 new viewport shot); 2 real production bugs found and fixed via the screenshot process itself (see below) |
| `4c3d38c` | L14 | 5 original mutation proofs re-run + M6b/M7/M8 + 3 new proofs, all applied→red→reverted→green; one new permanent test added |
| `77e8445` | (L14 follow-up) | Lint fix for the new test (`no-non-null-asserted-optional-chain`) |
| `f08c52a` | found during this revision's own CI verification, not in the original L1–L14 list | Fixed a CI-only failure in L9's own file — see below |
| (this commit) | — | This report |

**Reviewer's 9 issues → fix and test.**

| # | Issue | Fixed by | Proved by |
|---|---|---|---|
| 1 | Production transport throws `ERR_INVALID_IP_ADDRESS` for every real fetch (Node 24 `autoSelectFamily` calls `lookup` with `{ all: true }`) | `1562ad3`, `safe-fetch.ts`'s `nodeHttpsRequest` | `safe-fetch.test.ts`'s new production-transport test, driving `nodeHttpsRequest` directly against a local listener |
| 2 | IPv6 forms slip through (bracketed literals go to the resolver as hostnames; string-prefix matching missed most of the table) | `1562ad3`, rewritten `isBlockedIPv6` | `safe-fetch.test.ts`'s IPv6 table, one `it.each` case per form |
| 3 | `readable-text` quadratic on hostile HTML (~10s/160KB, ~1.7h at the real cap) | `1562ad3`, linear `indexOf` pass | `readable-text.test.ts`'s three 2MiB hostile-shape cases, single-digit ms |
| 4 | `safeFetch` throws despite "never throws" (unguarded body reads) | `1562ad3` | `safe-fetch.test.ts`'s slow-drip body/redirect-body tests |
| 5 | `job_capture` holds `POST /events` open for the whole model turn (extension's 5s timeout races a 90s turn) | `bea13fb`, background extraction queue | `captures.test.ts`'s "the event response arrives before a slow fake turn finishes" |
| 6 | A stray `.DS_Store` (or any non-uuid entry) in `jobs/` breaks every Jobs path | `1ff5b0a`, `isJobId` filter | `jobs-store.test.ts`'s new "JobsStore resilience" describe |
| 7 | "Three paths produce identical records" unproven, and false (only the fetch path trimmed) | `20c910b`, shared `normalizeCapturedText` | `captures.test.ts`'s new three-paths-identical test against the real Northwind fixture |
| 8 | Two security properties untested: M3a (text outside the boundary), M8 (size cap after full buffering) | `c927285` (M3a), `1562ad3` (M8, folded into the L4 deadline rework) | `extract-job-logic`'s prompt-boundary test (M3a); `safe-fetch.test.ts`'s endless-body test (M8) |
| 9 | Hostile-fixture check weaker than written; eval workspace fallback (assigning `RUNNER_WORKSPACE` inside `test()`) can't reach eve's dev-host Worker | `98bbb40`, shared `eval-workspace.ts` + route-level hostile test | `captures.test.ts`'s new hostile-fixture route test (fields-only, one tool call, profile hash unchanged); `job-extraction.eval.ts`/`onboarding-extraction.eval.ts` still 15/15 + 65/65 |

**Reviewer's nits → fix.** `events.push` gated on `collectEvents` (`a712376`); URL userinfo/fragment stripping (`1c2eefc`); one overall deadline covering DNS (`1562ad3`); gzip refused, charset honoured (`1562ad3`); `</script >` closes (`1562ad3`); `extract_job` can't overwrite an unrelated revision — already guarded by `persistExtractedJob`'s "running" precondition, exercised by L9's new hostile test and L5's background-queue tests; a turn that fails after the tool ran keeps its fields — new L14 test (below); wrong citations corrected (`a712376`). Extraction still runs outside `withRun` — **not fixed, by design**: the review lists this as carried to **P08-B**, not part of L1–L14.

**UI critic's 9 issues → fix, all in `fb2aa1a` (L12).**

| # | Issue | Fix |
|---|---|---|
| 1 | Outcomes land off-screen (250–1500px from the pressed button) | Sticky "Last action" line, `scroll-padding-top` tracks its height |
| 2 | Busy is invisible for up to 90s+10s | `aria-disabled` + "Saving…"/"Fetching…"/"Extracting…" after ~300ms; a new request clears the old message |
| 3 | Unextracted jobs all called "jobs.example" | Named from first non-empty line (capped ~80 chars) or URL path, never bare hostname |
| 4 | Extraction messages give no reason/next step; "not run" and "failed" read the same; "structured fields" leaks an internal key | Plain sentences per reason code, next step spelled out (`<code>` where relevant), never "structured fields" |
| 5 | A focused node is rebuilt (`detail-body.replaceChildren()` drops the pressed button, focus falls to `<body>`) | `morphChildren`/`morphNode` keyed reconciliation, never removes a focused node |
| 6 | Paste refusals don't say what's wrong (wrong sentence at 210K/300K chars, empty paste, wrong form referenced, no field marked invalid) | Client-side pre-flight (empty/oversize checks before send); field-scoped `aria-invalid`/`aria-describedby` |
| 7 | Duplicate paste doesn't say nothing was duplicated | Exact wording: "Already saved: this posting hasn't changed since revision N, so nothing was duplicated." |
| 8 | Horizontal scroll at 390 (175-char address, `overflow-wrap: normal`) | `overflow-wrap: anywhere` on the detail address line |
| 9 | Diff relies on punctuation; "removed" marker broken (CSS `content` escape eats the space; strikethrough crosses the minus sign) | Visually-hidden "Added:"/"Removed:" prefix, `aria-hidden` marker span, `.diff-text` alone carries strikethrough |

**UI critic's polish → all 9 done in `fb2aa1a`:** open row marked + heading scrolled into view; theme field borders/focus ring; `javascript:`/`file:` refusals no longer borrow the http-specific "paste instead" sentence; `https://` in `<code>`; diff toggles name both revision numbers; "a private or local network address"; timestamps drop seconds, deadline formatted as a UTC-safe long date; success messages name the job; new-tab links say so.

**Committed-screenshots findings → fixed in `9bd7009` (L13):** all 29 files retaken at a verified `document.documentElement.clientWidth` of exactly 390 or 1280 (not the old 375/1265-with-scrollbar); the refused-url set replaced with a `refused-private` `https://` state shown at the form, field-scoped; the diff shot now shows both an added and a removed line; the two pre-extracted seed jobs replaced so the all-hostname-list state genuinely appears; the "revisions" hover-underline artefact re-shot after moving the pointer off the just-clicked control.

**Two real production bugs found and fixed while taking L13's screenshots** (not on the L-item list; caught visually/empirically, not predicted):
1. `keepClear()` used `instanceof HTMLElement` — throws in any DOM-lib-less context (this repo's own runner `tsconfig` has no DOM lib; the jobs-page test's happy-dom window doesn't put `HTMLElement` on `globalThis` either), silently degrading to a "refused" last-action reading the exception's own message. Fixed by duck-typing (`typeof node.getBoundingClientRect === "function"`).
2. `refuseField()`'s `.focus()` relied on the global `focusin` listener's `keepClear`, which self-suppresses for 500ms after a `pointerdown` — correct when a click focuses itself, wrong here (the person clicked the submit button; focus moves to a *different* field). A field error could land directly under the sticky line, invisible without scrolling — caught visually in the first "refused-private" screenshot. Fixed by calling `keepClear()` unconditionally from `refuseField()` itself.

**Mutation proofs — 11 of 11, each applied → red → reverted → `git diff` clean → green** (`4c3d38c`; the "keep a failed turn's fields" proof leaves behind one new permanent test, `captures.test.ts`'s 35th):

| # | Mutation | Killed by |
|---|---|---|
| 1 (re-run) | Drop the post-redirect address check | `safe-fetch.test.ts`: re-validates-on-every-redirect-hop test (`blocked_address` → `http_status`) |
| 2 (re-run) | Accept `http:` on the fetch path | `captures.test.ts`: refuses-plain-http test (`https_required` → `fetch_scheme_not_https`) |
| 3a / M3a (re-run) | Move the posting text out of the boundary block | `captures.test.ts`'s L8 boundary test (text no longer between START/END) |
| 4 (re-run) | Skip the content-hash dedupe | `jobs-store.test.ts`, two tests (unchanged capture gets a new revision; concurrent same-URL/same-text race produces two revisions) |
| 5 (re-run) | Count a non-ok turn as extracted | `captures.test.ts`'s own mutation-target test ("extracted" → "not_extracted") |
| M6b | Hand the transport the hostname instead of the pinned address | `safe-fetch.test.ts`'s `nodeHttpsRequest` test (pinned local listener sees 0 connections) |
| M7 | Remove the DNS pin entirely | Same test, same reason |
| M8 | Check the size cap only after buffering the whole body | `safe-fetch.test.ts`'s endless-body test (resolves in ~22s instead of under 1s) |
| New | Allow the IPv4-mapped metadata address (`::ffff:169.254.169.254`) | `safe-fetch.test.ts`: 6 failures (the bracketed-literal test + 5 `it.each` IPv6-table cases) |
| New | Await the extraction before responding (`void serialise(...)` → `await`) | `captures.test.ts`'s slow-fake-turn test times out at 20s instead of returning early |
| New | Keep a failed turn's fields (`runQueuedExtraction` calling `recordStructured(jobId, revision, {})` on the failure branch) | New permanent test: "a failed retry keeps the fields an earlier, successful turn already wrote" (`captures.test.ts`, 35th test) |

**Proof 3b scope decision (documented, not re-broken).** Proof 3b ("posting text folded into the fields, not merely nearby") was not separately re-broken this revision. Its own coverage — `job-extraction.eval.ts`'s no-leaked-phrase assertion — was untouched by any round-1 change apart from L9's workspace-sharing fix, and was re-confirmed passing (job-extraction 15/15) in every full chain run this session. Re-breaking it would have meant editing the eval fixture/prompt path outside what L14 asked for; re-verifying the existing, unmodified assertion is the accurate claim, not a fabricated fresh break/fix cycle.

**A discovery outside the L1–L14 list, found during this revision's own CI verification (`f08c52a`).** After L14 went green locally and pushed, CI's "Test" step failed — and, on investigation, had been failing since `98bbb40` (L9), on every subsequent commit, always at the same step, never locally. Root cause: GitHub Actions sets its own `RUNNER_WORKSPACE` environment variable in every job (the runner's work folder, one level above the checkout, e.g. `/home/runner/work/workflow-catalog`) before anything in this repo runs. L9's `openOrCreateEvalWorkspace()` used that same variable as its "did I already create the eval workspace this run" signal (necessary because eve's build cache loads each `*.eval.ts` file's dependency graph independently, so plain module-level caching doesn't survive across the two eval files — see that module's own comment). The very first call in any CI run therefore saw a pre-set value it had never written, assumed an eval workspace already existed, and called `Workspace.open()` on GitHub's checkout-parent directory — which has no `workspace.json`, failing with "Run `npm run setup` in runner/." every time. Invisible locally, because a plain shell never has `RUNNER_WORKSPACE` set ambiently. `RUNNER_WORKSPACE` itself is a pre-existing, deeply-wired production contract (`lib/settings.ts`, `agent/lib/extract-job-logic.ts`, `agent/lib/onboarding-store.ts`, several tests) that has to keep being set for the real tool code, so the fix coordinates via a new private `WORKFLOW_CATALOG_EVAL_WORKSPACE` variable — a name nothing else could ever set, steering clear of GitHub's other reserved `RUNNER_*` names too — while still setting `RUNNER_WORKSPACE` itself alongside it, for that real tool code to keep reading. Verified by reproducing the failure locally (`RUNNER_WORKSPACE` pre-set to an unrelated directory before running the runner's test script, which then failed identically) and confirming the fix resolves it under that same reproduction, then re-confirming the normal (unset) path is still green.

**Owns discipline.** Everything above stayed inside P04's existing `Owns`, plus L9's one grant (the workspace lines of `onboarding-extraction.eval.ts`, exercised: its own top-level `RUNNER_WORKSPACE` assignment was replaced with a call into the new shared module) — nothing else was added. The `f08c52a` fix stayed inside the same granted file (`eval-workspace.ts` is the new module L9 itself created).

**Tests run, real output.** From the repo root at `f08c52a`, `git status --porcelain` clean before and after.
- `pnpm install --frozen-lockfile`: already up to date.
- `pnpm typecheck`: all 6 workspaces done.
- `pnpm test` (= `pnpm -r test && node --test scripts/*.test.mjs`, CI's exact "Test" step): contracts 16 files/235 tests; job-assistant 6 files/153 tests; runner 43 files/731 tests (668 at round 0 → 731, +63 across L1–L14) plus `eve eval` 6/6 files and 100/100 gates (`tool-surface` 4/4, `approval` 4/4, `missing-tools` 8/8, `skills` 4/4, `job-extraction` 15/15, `onboarding-extraction` 65/65); catalog 26 files/168 tests; extension 21 files/329 tests plus 1 file/5 tests skipped; root `scripts/*.test.mjs` 2/2.
- `pnpm -r lint`: 6 of 6 clean, `--max-warnings 0`.
- `pnpm check:fixtures`: exit 0.
- CI on `packet/P04` head `f08c52a`: run [35953700163](https://github.com/radroid/workflow-catalog/actions/runs/35953700163), **success** (4m23s), including the extension build/vitest/Playwright e2e step — confirmed via one blocking `gh run watch 35953700163 --exit-status` plus `gh run view --json status,conclusion`. See the reply for this report commit's own head SHA and CI run.

**What was not done.**
- Nothing from L1–L14 was skipped or descoped.
- Per the review's own routing, not this packet's job: the e2e bridge loading no route modules (carried to **P07-C**), and extraction turns running outside `withRun` (carried to **P08-B**) — both already flagged in `logs/handoff/P04-round-1-review.md`'s "Carried to other packets", unchanged by this revision.
- The `f08c52a` fix is additional work this revision found and closed (a real, previously-undetected CI-only regression from L9), not part of the original L1–L14 list; included here since it touches L9's own file and blocked an honest "CI is green" claim until fixed.

**Assumptions.** Unchanged from round 0: screenshot naming follows `P0N-<page>-<state>-<theme>-<width>.png`; "full page" is `fullPage: true` at the CSS-pixel viewport width reported by `clientWidth` (L13 additionally verified this is exactly 390 or 1280 before every capture, per the round-1 instruction).
