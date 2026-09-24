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
| Three paths produce identical snapshot records for the same fixture text | `captures.test.ts`, `jobs-store.test.ts` |
| Same URL, changed text → revision 2, revision 1 retained | `jobs-store.test.ts` ("a second capture of the same URL with different text creates revision 2 and keeps revision 1") |
| Hostile posting: extraction returns fields only, no action tool called, profile unchanged (hash before/after) | `extract-job-logic.test.ts` ("never touches the career profile — hostile posting fixture (hard-problems.md #3, assert store hash before/after)"); `job-extraction.eval.ts`'s `notCalledTool`/no-leaked-phrase assertions |
| Rejected: `javascript:`/`file:` on every path, `http:` on the URL-fetch path | `captures.test.ts`, `job-tools.test.ts` |
| Rejected: loopback/RFC1918/link-local/`169.254.169.254`, including after a redirect or a DNS answer | `safe-fetch.test.ts` (injected resolver + local fake server, never the real network) |
| Rejected: bodies over the cap, text over 200 KB | `safe-fetch.test.ts`, `captures.test.ts` |
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
