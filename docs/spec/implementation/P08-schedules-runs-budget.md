# P08 · Schedules, run log, and budget pause

Status: done (part A iter 005, PR #13, squash 360ac69; part B 2026-09-25, PR #20, squash c33689a)
Assignee: manual session (Sonnet)
Blocked by: P05
Owns: runner/store/runs.ts, runner/scheduler/ (catch-up + fallback trigger, including runner/scheduler/prompts/ — see the Gate fix round 1 report entry: moved from runner/agent/schedules/, which eve itself discovers as cron schedules), runner/server/routes/runs.ts, runner/ui/runs.html, runner/ui/settings.html (schedules and budget sections)
Spec: F10, F11, §8 schedules and run modes, hard-problems #4 and #7

## Goal
Daily preparation of newly saved jobs and a weekly review that survive laptops sleeping and never draft twice or burn quota silently.

## Deliverables
- `scheduler/prompts/daily-prepare.md` (markdown prompt: prepare Saved jobs, cap N per run) and `scheduler/prompts/weekly-review.md`; per-schedule timezone, pause, run history in Settings. These live under `runner/scheduler/prompts/`, not `runner/agent/schedules/`: in mode A the runner's own scheduler owns firing (the bridge's clock, through `withRun` and the budget), and a `.md` under `agent/schedules/` is eve's own markdown-schedule form, discovered and fired by eve itself in task mode (and required to declare `cron` frontmatter) — a second, uncontrolled trigger the design rules out. See "Gate fix round 1" in the Report.
- Catch-up: `last-successful-run` marker per schedule; on `npm run runner` start, run any overdue schedule once. In mode (B) the bridge's own clock dispatches via `POST /eve/v1/dev/schedules/<id>`.
- Run log: every run writes `runs/<date>/<runId>.json` with kind, inputs, idempotency key, outcome, model, tokens, duration; Runs page lists them; the file is human-readable.
- Budget: per-day run cap and per-run item cap; provider limit (429 after eve's three attempts) → schedule paused with reason "provider limit" shown on the board and Settings; manual resume.

## Acceptance
- Two consecutive daily runs over the same inputs create zero new documents.
- Stop the runner across a scheduled time, start it: exactly one catch-up run.
- Simulated 429 storm: schedule paused, reason recorded, no retry loop (assert call count).
- Cap exceeded: run stops at the cap, remaining items stay Saved, reason logged.
- Pause state survives restart.

## Out of scope
Opening tabs from a schedule (never), catalog cron (none).

## Carried into part B (from the part-A reviews, iter 005)
Findings are in `logs/handoff/P08-A-round-3-review.md`.
- **Reviewer's nits:**
  1. Test a body that returns `{ turns: [] }` (the `n/a` side of `metaLine`, `run-harness.ts:372`).
  2. When no turn reached eve (for example "eve is not running"), record the model as `n/a`, not `unknown` with 0/0 tokens.
  3. Document that `hasSucceededWithIdempotencyKey` rejects when a folder can't be listed. A rejection means "unknown", never "not done", so no caller may write `.catch(() => false)`. Part B's catch-up and idempotent retries must fail closed on it.
  4. `GET /api/runs/:runId` answers a clean 200 or 404 when `runs/` is unreadable, as `listRuns` does, not a 500.
  6. `pauseBudget` can reject if `runs/budget.json` can't be written. Keep it contained wherever part B calls it outside `withRun`.
- **UI critic's polish:**
  - **P-a.** No "No runs yet." when records or folders were skipped. When `runs/` itself is unreadable, Settings must not promise that Resume restarts runs (Resume answers 500 today); say what to do instead.
  - **P-b.** Folders are listed before files in the skipped note, or flagged by the server, and a lone folder reads as a folder.
  - **P-c.** The run-log pause note says what to do: "Runs restart on their own once the runner can read this folder again; check its permissions." With a stored pause on top, the usage line gives a reason for "unknown".
- **eve:** the authorization case in `eve-runtime.md` §8 item 15 applies to any schedule turn once a connection exists.
- **Extraction turns and the budget** (P04 round-1 reviewer). P03's onboarding extraction and P04's background job extraction run outside `withRun`, so the daily run limit doesn't see them. P04's extraction already refuses to start while the budget is paused. Decide whether these turns count against the daily limit, or get a limit of their own, and record the choice. P03.2 decides the provider-limit pause for interactive turns; keep the two consistent.
- **An authorization request with no webhook counts as ok** (P05 round-1 reviewer, iter 007). `classifyTurn` treats `authorization.required` without a `webhookUrl` as an ok turn; in the reviewer's probe, a preparation saved its documents. Nothing adds an eve connection yet, but eve item 15 says a pending authorization is waiting on the person. Classify it as parked, with a real-`Client` test. `run-harness.ts` is granted for this.
- **A parked preparation is not a failure for schedules** (P05 round-1 reviewer, iter 007). P05 records a preparation parked on gap questions as a run-log `failure`. Schedules and catch-up must not treat it as one: no retry, no failure count, no backoff. P06 adds a waiting state for it.
- **A stale comment** (from P03.2's round-3 reviewer). `run-harness.ts:12` still says no real route calls the classifier; since P03.2, the onboarding extraction, the model check, P04's capture extraction and P05's preparation all do. Fix it with the run-harness grant above.

## Part B alongside P06 and P03.1 (iter 008)
- **Starting preparations.** Import `startPreparation` and `waitForPreparationQueue` from `runner/server/routes/applications.ts`, and don't edit that file: P06 extends it. P06 keeps both signatures stable.
- **A parked preparation.** Read it from P05's preparation record (`status: "parked"` in `runner/store/applications.ts`, read-only), not from the waiting value P06 is adding to the contract.
- **The board.** P06 shows the budget pause on the board. P08-B keeps Settings, and adds its schedules as a new `<section>` in `settings.html` with its own script. The budget section stays as it is.
- **Extraction turns and the budget.** If they count toward a limit, do it inside `run-harness.ts`. Never edit `routes/onboarding.ts` (P03.1) or `routes/captures.ts` (P06.1).
- **No new dependencies.** `runner/package.json` and the lockfile belong to P03.1 in this wave. If you need one (a cron parser, say), stop and ask.
- **Styles.** `runner.css` belongs to P06.1. Settings and Runs styles go in `settings.css` and `runs.css`.

## Report

### 2026-09-25 — Gate fix round 1 (manual session, Sonnet)

Fixed the two BLOCKING findings from the gate review (`/tmp/wc-manual/
P08-B-gate-review.md`, PR #20 head `e6d4333`). The 23 FOLLOW-UPs (F1–F23)
are the orchestrator's to triage into `FOLLOWUPS.md`; none are touched here.

**B1 — `eve build` failed.** eve discovers every `.md` under
`runner/agent/schedules/` as its own markdown schedule, requiring `cron`
frontmatter (`node_modules/eve/docs/schedules.mdx`, "Markdown form"); adding
`cron` would hand both schedules to eve's own task-mode firing, outside
`withRun` and the budget — the exact second trigger the design rules out.
Fix: moved both prompt files to `runner/scheduler/prompts/`, which eve never
scans, and updated `scheduler/config.ts`'s `SCHEDULES_PROMPT_DIR` and every
reference (`runner/README.md`'s P08-B row, the two rows in
`docs/learn/reference/eve-prompt-map.html`, this packet's Deliverables and
Owns lines) to the new path, each with a short note on why. Added
`test/scheduler-config.test.ts`: asserts `runner/agent/schedules/` holds no
`.md` files, and — as a regression guard — that any `.md` that does show up
there in the future must declare `cron` frontmatter or the test fails with
that reason named, before `eve build` would ever hit it again.

Verified against the real build, exactly as the reviewer reproduced it
(`sh /tmp/wc-manual/eve-build-check.sh <worktree>`: adapter `sync-skills.mjs`
+ `eve extension build`, then `eve build` in `runner/`, with a temp `HOME`
and `RUNNER_MODEL_PROVIDER=chatgpt RUNNER_MODEL=gpt-5.6-luna`): exit code
`EVE_BUILD_EXIT=0`, last real build line `[BUILD] built output at
.../runner/.output`. `git status --porcelain` afterward showed only this
round's own source edits — the `.eve/`/`.output/` build directories are
gitignored, so nothing leaked in.

**B2 — three Acceptance bullets mapped to tests that stayed green with the
behaviour broken.** `scheduler-dispatch.test.ts` mocks `startPreparation`
and asserts only the tally of its own mocked return value, so it could not
see the real pipeline's actual document/turn count or claim-file set. Added
`test/scheduler-dispatch-real.test.ts`: no `vi.mock` anywhere in the file,
driving `runDailyPrepare`/`runDueSchedules` over the real (imported, unmocked)
`startPreparation`/`waitForPreparationQueue`, with P05's own `scriptedModel`
and `seedReadyProfile`/`seedDetails`/`seedJob` (`test/preparation-helpers.ts`)
— the same helpers and fixture (Ada Quill, `platformLeadJob()`) P05's own
suite uses, so a real document is really written and a real (scripted) model
turn really runs.

- Bullet 1 ("zero new documents"): one job, run twice. Asserts
  `model.prompts.length` is unchanged after the second run (zero new turns)
  and the application's document count is unchanged (zero new documents) —
  the correct mechanism is that a prepared job's stage moves off `"saved"`,
  so the schedule's own Saved-stage-only scan finds nothing left to do, not
  a same-inputs/"already prepared" branch.
- Bullet 2 ("exactly one catch-up"): one job prepared on an on-time fire,
  then a second job saved during a simulated multi-day outage (no calls made
  during the "down" days — a stopped process makes none), then a catch-up
  fire several days later. Asserts the *exact* claim files on disk
  (`scheduler/claims/daily-prepare--2026-09-20.json` and `…--2026-09-25.json`
  only, never `…--09-21/22/23/24.json`) and the exact total model-turn count
  (2: one per legitimate fire) — `getScheduleState`'s own `lastSlotId`/
  `lastAttemptAt` can't distinguish "ran once" from "ran five times", since
  `recordAttempt` overwrites both every call; the claim files are the one
  place that distinction is visible on disk.
- Bullet 4 ("reason logged"): item cap 1, two Saved jobs. Asserts one job
  reaches `"ready"` and the other stays `"saved"` (not refused, not
  skipped), and that the cap's reason is present in *both* a captured
  `ctx.log.info` line and the schedule state's `lastSummary` (two independent
  surfaces, so dropping either one alone still fails the test).

Proved against the reviewer's own three mutations (M1b, M6, M3b), applied
one at a time to a clean `scheduler/dispatch.ts` via `cp`/`python3` (never
git stash, matching the reviewer's own restore method), each run against
only its targeted new test, then restored via `cp` back to the committed
original — `git diff` was empty after every restore:
- **M6** (daily-prepare also re-prepares `"ready"` jobs, with a cover
  letter): bullet 1's test fails — the first job never reaches `"ready"`
  (the mutated `coverLetter: true` doesn't match the scripted turn's plan,
  which is itself already evidence the mutation changed real behaviour).
- **M1b** (`runDueSchedules` loops every missed slot back to the last
  attempt, not just the latest): bullet 2's test fails on the second fire's
  own `ran`/`isCatchUp` shape once multiple slots are dispatched in one
  call.
- **M3b** (drop both the cap log line and the summary's cap sentence):
  bullet 4's test fails on the captured-log assertion.

Full chain: 65 test files, 1469 tests, all green (runner alone: was 64/1466
after B1's `scheduler-config.test.ts`, now 65/1469 with B2's three new
tests). Typecheck and lint clean on every touched/new file.

### 2026-09-25 — Part B design (manual session, Sonnet)

**What fires a schedule.** Not eve's own cron. `withRun`/`runTurn`/the
budget and run stores live in the bridge process; eve's own `agent/
schedules/*.ts` `run` handlers execute inside eve's process instead, with no
access to the bridge's `RunnerContext`, so they can't call `withRun` or
`startPreparation` directly. eve also documents no catch-up for a missed
fire and, per the P02 spike's own risk note, gives no HTTP signal that a
fire happened at all (`docs/spec/research/eve-spike.md`: "I found no HTTP
route that reports a cron fire... P08 needs a hook or the dispatcher
pattern"). So the trigger is the bridge's own clock: `routes/runs.ts`'s
`start()` hook runs a due-schedule check once immediately on startup
(catch-up), then on a five-minute `setInterval` (the fallback trigger,
`scheduler/index.ts`). Both call the same `runDueSchedules` — one trigger
mechanism, not two that could race each other. **No fire can run twice**
because, before any work starts, `dispatchOne` (`scheduler/dispatch.ts`)
atomically claims the current slot via `Workspace#createJson`'s exclusive
create (`scheduler/store.ts`'s `claimSlot`, `scheduler/claims/<id>--
<slot>.json`); a second attempt at the same slot — the fallback trigger and
a startup catch-up landing close together, or two fallback ticks either
side of a restart — sees the file already exists and does nothing.

**Each schedule's time zone.** Fixed, per schedule, in `scheduler/
config.ts`: both ship at `UTC` for the MVP (no per-person configuration
yet — F10 asks for a timezone per schedule, not a person-editable one).
eve documents no timezone for a self-hosted croner at all
(`docs/spec/research/eve-runtime.md` §4: "not documented"), which is moot
here since eve's cron isn't the trigger; `scheduler/time.ts`'s `nextFireAt`/
`mostRecentFireAt` compute the next/most-recent wall-clock fire in the
schedule's own zone via `Intl.DateTimeFormat` (no new dependency), correct
across DST. Proved with an injected `ManualClock` in
`test/scheduler-time.test.ts`: fixed UTC cases, plus `Asia/Kolkata`
(a real, no-DST +05:30 zone) to prove the mechanism actually consults the
zone rather than assuming UTC.

**How catch-up finds an overdue schedule, and why exactly one.**
`mostRecentFireAt(cadence, now)` always resolves to the single latest slot
at or before `now` — never every missed slot — so a runner that stayed down
across several fires (or several fallback ticks) claims and runs only that
one; the older, now-unclaimed slots are simply never looked at again.
Proved in `test/scheduler-dispatch.test.ts` ("the runner missing several
scheduled fires still runs exactly one catch-up") and directly in
`test/scheduler-time.test.ts`.

**What the daily and weekly runs do.**
- **daily-prepare** (`prepare_newly_saved_jobs`): reads the budget's
  `itemCap`, lists every application at stage `saved`
  (`store/applications.ts`'s `ApplicationsStore#list`, read-only), caps to
  `itemCap`, and calls P05's own `startPreparation` once per capped job
  with this schedule's `kind` and `isCatchUp` — no second preparation path,
  no second turn classifier (the "decisions already made" section). The
  remainder stay Saved and are logged (`ctx.log.info`) and summarized on
  the schedule's own state for Settings. `agent/schedules/daily-prepare.md`
  documents the schedule for a person reading the repo; it is not sent to a
  model — `startPreparation`'s own `buildPreparationPrompt` already builds
  each job's turn, so a second prompt here would be the second preparation
  path the packet rules out.
- **weekly-review** (`review_open_applications`): no existing pipeline to
  delegate to, so it calls `withRun`/`runTurn` directly (kind
  `review_open_applications`, idempotency key `weekly-review:<slot>`,
  checked against `hasSucceededWithIdempotencyKey` first). Its prompt,
  `agent/schedules/weekly-review.md`, is data-free; the open applications'
  stage and ids (never job/company content) are appended as the turn's own
  user-turn message, the same pattern `buildPreparationPrompt` uses for
  confirmed claims.

**Eve facts relied on**, each with its docs path (never memory):
- No catch-up, no fire signal, self-hosted timezone undocumented:
  `docs/spec/research/eve-runtime.md` §4 ("Missed schedules when the
  process is stopped", "Time zone"); `docs/spec/research/eve-spike.md`'s
  risk note.
- `agent/schedules/*.ts`/`.md`, root-agent-only, `run`/`markdown` handlers:
  `node_modules/eve/docs/schedules.mdx`.
- `dispatchSchedule` is a dev-only eval/test helper wrapping
  `POST /eve/v1/dev/schedules/:id`, unusable by a production `eve start`
  build: `node_modules/eve/docs/schedules.mdx`,
  `node_modules/eve/docs/evals/targets.mdx`. Not used here — P08-B has no
  eve-mediated eval of its own schedules, since they never go through eve.
- The dynamic-scheduling pattern (`node_modules/eve/docs/patterns/
  dynamic-scheduling.md`): its atomic-claim/at-least-once/idempotency
  discipline is what `claimSlot` mirrors, even though P08-B's own trigger
  is the bridge's clock, not eve's dispatcher schedule.
- `session.completed` (task mode) is already a recognized "ok" boundary in
  `runTurn`/`classifyTurn` (`docs/spec/research/eve-runtime.md` §8 item 15;
  `server/run-harness.ts`), which weekly-review's turn relies on.
- `authorization.required`/`authorization.completed` shapes (`webhookUrl`,
  `attemptId`): `node_modules/eve/dist/src/protocol/message.d.ts`, and
  `eve-runtime.md` §8 item 15's "Authorizations" note (carried item, below).

**Extraction turns and the budget (carried decision).** P03's onboarding
extraction and P04's capture extraction stay outside `withRun` and do not
count toward the daily run limit in this packet. Reasoning: (1) both
already refuse to start while the budget is paused, so some quota
protection exists; (2) making them count would mean adding budget-lock-
aware accounting inside `runTurn` for every existing caller
(`eve-gateway.ts`'s `checkModel`, onboarding's extraction, capture's
extraction) — wide-reaching changes to code this packet does not own and
cannot fully re-verify; (3) hard-problems #7's actual concern — a run
loops and burns quota silently — is about *unattended, scheduled* work,
which the daily run limit and per-run item cap already bound tightly; an
interactive, person-triggered extraction is visible in the moment it runs.
Not implemented; recorded here as the decision, per the packet's own
"record the choice."

**A parked preparation is not a failure for schedules (carried item).**
`run-harness.ts`'s `withRun` still maps any non-`"ok"` `TurnResult` status
(including `"parked"`) to a `RunRecord` `outcome: "failure"` — unchanged,
since that mapping is P08-A's and changing it risks P05's own, already-
merged behavior for a manual Prepare click. Instead, "not a failure for
schedules" is implemented at the scheduler's own level: `runDailyPrepare`
never retries a job within a run, applies no failure count and no backoff
(there is none anywhere in `scheduler/`), and the schedule's own
`recordAttempt` marks the *fire* as succeeded once it completes without
throwing, regardless of how many individual jobs parked or were refused —
that per-job detail lives in the fire's summary text, not in any retry
state. The next fire re-asks `startPreparation` for the same job exactly as
before; P05's own dedup (a previous attempt parked on the same key) refuses
a second attempt on its own, so nothing here has to know about "parked"
specifically. Tested in `test/scheduler-dispatch.test.ts`.

**An authorization request with no webhook counts as ok — fixed.**
`classifyTurn` (`run-harness.ts`) now tracks `authorization.required`/
`authorization.completed` events; a pending authorization with no
`webhookUrl` parks the turn the same way a non-empty `input.requested` does
(eve-runtime.md §8 item 15's "Authorizations" note). Tested with a real
`Client` against a stubbed `fetch`-free fake, in `test/run-harness.test.ts`.

### 2026-09-25 — Part B acceptance map, screenshots, and final chain (manual session, Sonnet)

**Acceptance → test map**
1. Two consecutive daily runs over the same inputs create zero new documents.
   → `test/scheduler-dispatch.test.ts` › `runDailyPrepare` › "delegates every
   job's own idempotency to startPreparation — no second preparation path"
   (second run against the same job records `alreadyPrepared: 1, started: 0`).
2. Stop the runner across a scheduled time, start it: exactly one catch-up
   run. → `test/scheduler-dispatch.test.ts` › `runDueSchedules — catch-up and
   no-double-fire` › "Acceptance: the runner missing several scheduled fires
   still runs exactly one catch-up"; the real `start()` hook wiring is
   covered by `test/routes-runs-schedules.test.ts` › "returns a stop
   function, and the catch-up check runs".
3. Simulated 429 storm: schedule paused, reason recorded, no retry loop. →
   `test/scheduler-dispatch.test.ts` › `runWeeklyReview` › "Acceptance:
   simulated 429 storm — pauses the budget, records the reason, and never
   retries (assert call count)".
4. Cap exceeded: run stops at the cap, remaining items stay Saved, reason
   logged. → `test/scheduler-dispatch.test.ts` › `runDailyPrepare` ›
   "Acceptance: cap exceeded — stops at the per-run cap, remaining jobs stay
   Saved, and it's logged".
5. Pause state survives restart. → `test/scheduler-store.test.ts` ›
   "Acceptance: pause state survives a restart — a fresh Workspace handle
   over the same directory still reads it"; also
   `test/routes-runs-schedules.test.ts` › "survives a restart: the state
   lives on disk, so a fresh state read after pause still shows it".

**Carried item → test map**
- Nit 1 (empty-turns body / `n/a` metaLine) → `test/run-harness.test.ts` ›
  "carried nit 1 — a body with no turns".
- Nit 2 (no turn reached eve → model `n/a`, not `unknown`) →
  `test/run-harness.test.ts` › "carried nit 2 — eve not running must stay
  n/a, not unknown" (+ its contrast case).
- Nit 3 (`hasSucceededWithIdempotencyKey` rejection means "unknown", never
  "not done"; fail closed) → `test/scheduler-dispatch.test.ts` › "carried
  nit 3: a hasSucceededWithIdempotencyKey rejection is 'unknown', not 'not
  done' — dispatchOne must not run"; doc comment added at the function.
- Nit 4 (`GET /api/runs/:runId` a clean 200/404, never 500, when `runs/` is
  unreadable) → `test/runs.test.ts` › "P08-B carried nit 4: getRun over an
  unreadable runs/ resolves undefined, never throws", composing with the
  route's existing 404-on-undefined contract
  (`test/routes-runs.test.ts` › "404 for a well-formed uuid with no run").
  No separate route-level unreadable test: only the store-level fail-closed
  behavior changed.
- Nit 6 (`pauseBudget` rejection kept contained outside `withRun`) — not
  touched: nothing in `scheduler/` calls `pauseBudget` directly; the 429
  path goes through `withRun`/`runTurn` exactly as before this packet, so
  there is no new call site to contain.
- eve authorization with no webhook (P05 round-1) →
  `test/run-harness.test.ts`, the four tests under "eve-runtime.md §8 item
  15 — an authorization pending with no webhookUrl parks, not ok".
- A parked preparation is not a failure for schedules (P05 round-1) →
  `test/scheduler-dispatch.test.ts` › "carried item: a parked preparation
  (refused, gap questions open) is not a failure — no retry within the run,
  no throw".
- Stale comment at `run-harness.ts:12` → fixed with the run-harness grant;
  a comment, no test.
- Extraction turns and the budget → decision recorded above (not counted;
  three reasons given); no code change, so no test.
- UI critic's P-a/P-b/P-c:
  - **P-b** (folders reported before files; a lone folder reads as a
    folder) → store level: `test/runs.test.ts` › describe "P08-B carried
    P-b: folder skips are reported before file skips" › "a folder skip from
    an older date is never pushed out of the top 10 by newer file skips".
    The matching UI wording in `ui/assets/runs.js`'s `renderSkippedNote` has
    no automated UI test (no JS unit-test harness exists for this file in
    the repo) — reviewed by hand against the fixed ordering, not separately
    screenshotted. Flagged as open below.
  - **P-a** (no "No runs yet." once something was skipped) → same
    `loadRuns()` change (`empty.hidden = invalidCount > 0`), same caveat.
  - **P-c** (the run-log pause note says what to do) → already shipped by
    Part A in `ui/assets/settings-budget.js` ("Runs stay paused until the
    runner can read this folder again. Resume can't clear this pause.");
    Part B didn't touch it, confirmed still present.

**Screenshots** (`docs/screenshots/P08-B-*.png`, full page, 390 and 1280,
light and dark — 16 files):
- Settings: `settings-schedules-normal-*` (budget resumed) and
  `settings-schedules-budget-paused-*` (budget paused) — 8 files. Both sets
  show weekly-review paused throughout (seeded that way and never toggled),
  which is deliberate: it demonstrates the "one schedule paused" state at
  the same time as each budget state, since the design point being shown is
  that a schedule's own pause is independent of the budget's — every shot
  proves that independence rather than needing a third, separate "only one
  schedule paused, budget untouched" screenshot set.
- Runs: `runs-catchup-capped-*` — a pure catch-up `daily-prepare` success
  run next to a pure capped one ("Stopped at the per-run cap (3); 1 job stay
  Saved.") — 4 files.

**Final chain** (this branch merged with `origin/overnight/integration`,
merge commit `85d1a2e`, no conflicts): `pnpm install --frozen-lockfile`,
`pnpm typecheck` (6 workspaces, clean), `pnpm test` (contracts 235,
job-assistant 153, catalog 168, runner 1462 across 63 files + the eve eval
7/7 · 161 gates, extension 329 + 5 skipped, fixtures-policy self-test 2/2 —
all green), `pnpm -r lint` (clean), `pnpm check:fixtures` (clean).
`git status --porcelain` empty on the final head.

**Open gap:** `ui/assets/runs.js`'s P-a/P-b wording changes have no
automated test and weren't screenshotted in a skipped/unreadable state
(only the store-level fix that backs them is tested — see nit 4/P-b above).

### 2026-09-23 — Revision 2 (iter-005 Opus escalation)

Round 2 returned REVISE (reviewer 2 issues, one high; UI critic 3), after the Sonnet implementer's one revision round. I took over `packet/P08-A` at `371cd63` and merged `origin/overnight/integration` normally (`5059f69`; no rebase, amend or force-push). The work list is `logs/handoff/P08-A-round-2-review.md`, decisions I1–I4. No message claiming to be the orchestrator arrived during this round, with or without the code word.

Commits:
- `78386b2`: I1, I2 and the backend part of I3.
- `cf6cd48`: I4, the nit-8 UI change, and the screenshots.
- `e17d01d`: the README.
- This report.

**I1: turn classification (reviewer issue 1, high).** `runTurn` follows `eve-runtime.md` §8 item 15. It reads the stream with `for await` and tracks the model, usage, the number of `input.requested` requests, `turn.cancelled`, the first failure event and the latest boundary. It then classifies the turn in this order:

1. **timeout**: the signal fired. The session is cancelled.
2. **failed**: any failure event (`step.failed`, `turn.failed`, `session.failed`). A provider limit still pauses the budget.
3. **cancelled**: a new `TurnStatus`, for `turn.cancelled`. We send no cancel of our own.
4. **failed**: no boundary event arrived.
5. **parked**: only when the `input.requested` list is non-empty. The session is cancelled.
6. **ok**: a `session.waiting` or `session.completed` boundary with none of the above.

Partial tokens and the model are kept on every path.

Tests:
- A real `Client` against a stubbed `fetch` replays the spike's exact normal conversation sequence (`turn.completed → session.waiting`, 11/2 tokens, `probe-model`). It gives `ok` with 0 cancels.
- Through `withRun`, the same sequence records `success`, and `hasSucceededWithIdempotencyKey` then says done.
- The spike's task sequence (`session.completed`) is also ok.
- The fakes' ok paths now end `turn.completed → session.waiting`. One `session.completed` case is kept, and the 429-storm fakes were updated the same way.
- The park tests include a real `InputRequest`-shaped `input.requested`, and give 1 cancel. An empty `input.requested` list is not a park.
- `turn.cancelled → session.waiting` gives `cancelled` with no cancel, and through `withRun` it records a failure that is not done.
- A `session.failed` boundary gives `failed`.

**I2: nothing before the body can reject (reviewer issue 2).**
- `getBudgetState` never throws. It catches the failure of `countCountableRuns` for today and returns a synthetic pause:
  - the reason is `run log unreadable (runs/<date>/)`;
  - `pauseKind` is `run_log_unreadable` and `runLogUnreadable` is true;
  - it is derived on every read and never stored, so it clears once the folder is readable.
- `pauseKind` is set exactly when paused. When more than one pause applies, the first match wins: `budget_unreadable`, then `budget_repaired`, then `stored`, then `run_log_unreadable`.
- `listRuns` reports an unlistable `runs/` as one skipped entry, `runs/`.
- `/status` stays 200. `status()` catches anything `getBudgetStatus` throws, logs it, and reports `{ dailyRunLimit: 10, runsUsedToday: 0, paused: true, pausedReason: "budget status unavailable" }`.
- `withRun`:
  - An empty or whitespace-only `idempotencyKey` is logged and resolves with an in-memory failure record, `The run did not start: it had no idempotency key.`. Nothing is written and the body is never called.
  - The refusal check and `startRun` sit in a try/catch, inside the budget lock as before. Any error there is logged and resolves with an in-memory failure record, `The run did not start: its run record could not be written.`.
  - Where a record can be written, the run is refused with a `paused` record carrying the run-log reason.
- Tests:
  - chmod 000 on today's folder:
    - `withRun` resolves with an in-memory failure, logged, and the body runs 0 times;
    - the store gives the synthetic pause, Resume can't clear it, and it clears once readable;
    - the routes give `/status` 200 with the pause, and `/api/runs/budget` and `/api/runs` 200.
  - chmod 300 on today's folder: a `paused` record with the run-log reason is written.
  - chmod 500 on `runs/`: an in-memory failure.
  - chmod 000 on `runs/`: `listRuns` gives `{ records: [], invalidCount: 1, skippedFiles: ["runs/"] }`; `/status` and the list stay 200.
  - An empty key and a whitespace-only key.
  - A mocked `getBudgetStatus` that rejects: `status()` returns the fail-closed budget, and `GET /status` is 200 and valid.
  - The chmod tests skip on Windows and as root.

**I3: nits 1–8.**
1. **`withTz("Pacific/Kiritimati")`.** New cases:
   - `2026-09-22T12:00Z` is `2026-09-23` in Kiritimati;
   - `2026-09-22T05:00Z` is `2026-09-21` in Pago Pago;
   - a run under Kiritimati files under `runs/2026-09-23/`, and today's count finds it.
2. **Partial tokens and model on the quiet-end abort paths.**
   - Abort point 2, through `withRun`, records 7/3 tokens, `probe-model` and `No answer within 0.3 s.`.
   - The idle-stall case keeps the model, and the control case asserts both.
   - A new case covers an abort during the 503 open-retry backoff.
3. **The G2 fallbacks are tested.**
   - Fallback 1: tokens of 1.5 and −1 fail validation, so the minimal record is written, and this is logged.
   - Fallback 2: `runs/<date>/` is set to chmod 500 during the body. The run resolves with an in-memory record, and the honest placeholder stays on disk.
   - `throw undefined`, a message-less stream error and a whitespace-only detail all get the fixed sentence. `errorMessage` returns "" for anything without a message, and `nonEmptyOrFallback` trims.
4. **`session.cancel()` is bounded.** It now runs with `{ signal: AbortSignal.timeout(5000) }`. The test runs an eve that never answers the cancel POST: the turn resolves `timeout` between 5.2 s and 8.3 s, and the request carried an aborted signal.
5. **The G4 race test asserts both writes.** Over 40 trials it counts `pausesLost` and `limitsLost`, and both must be 0.
6. **The README duplicate is removed**, and the P08 lines are updated.
7. **Report corrections**: see below.
8. **A timed-out turn keeps its duration and tokens.** `withRun` sets the model to the new `UNKNOWN_MODEL` ("unknown") when a turn was sent but no `step.started` arrived. The Runs page then shows duration and tokens and hides only the model. `NO_MODEL` ("n/a") still means the model was never called, and still hides the whole line (G8).

Nit 9 (a cancel on a parked session is a no-op on the server) is documented in the `run-harness.ts` header.

**I4: UI critic issues 1–3 and polish.**
1. **Skipped-file note.**
   - Each file shows as `shortRunPath()` in `<code>`, with the full path in `title`, one per line in a `<ul>`, followed by "and N more.".
   - The note became a `<div>`.
   - New this round: a folder entry (`runs/<date>/` or `runs/`) makes the count read "run records or folders".
2. **Budget messages come from the returned state.**
   - Resume returns `restoredDefaults`: true only when the file was unreadable at that moment. The message is:
     - "Runs resumed with the default limits: 10 runs a day, 5 jobs per run." when defaults were restored;
     - otherwise "Runs resumed.";
     - "Resumed, but runs stay paused: today's run log can't be read." or "Runs are still paused." if still paused.
   - A repairing Save stores the reason `budget settings were unreadable (runs/budget.json)`, and the note reads "Your limits are saved now. Press Resume to restart runs; until then, Save keeps runs paused.".
   - The Save message follows the returned state:
     - "Budget saved.";
     - "Budget saved. Runs stay paused until you press Resume.";
     - "Budget saved. Runs stay paused until the run log can be read.".
   - The run-log pause shows its path in `<code>`, hides Resume, and shows usage "unknown".
   - `wasCorrupt` and `lastState` are gone. Notes are keyed on `pauseKind`.
3. **Copy path.**
   - "Copied" or "Couldn't copy" appears in an `aria-hidden` span right after the pressed button, and the span's width is always reserved. It clears after 4 s, or when another button is pressed.
   - The live region still makes the one announcement.
4. **Polish.**
   - **P2:** the lede reads "How this runner behaves, one section per concern. Today that is the run budget; pairing is on the Status page."
   - **P4:** the reason sits beside the pill in a flex row, and wraps beside it rather than under it.
   - **P9:**
     - Settings' status line reserves one line at desktop widths and two at ≤40rem (every Budget message fits); the Runs page's reserves one line;
     - "Runs used today" and the daily-limit note moved below Save;
     - `aria-invalid` uses an inset box-shadow, so the input doesn't change size.
   - **Names:** each Copy path has the aria-label `Copy path — <kind>, <time>`, and each View JSON summary has the same pattern.
   - **Focus:** `#budget-title:focus-visible` uses a 2px `var(--ring)` outline.
   - **JSON view:** it shows the record as it is on disk, with no `path` or `absolutePath`. Both paths are listed above it in a `<dl>`: "In the workspace" and "On this computer".
   - New this round: the pause reason's `<code>` is `white-space: nowrap`. At 390 it had broken inside the date (`runs/2026-09-` / `23/`).

**Screenshots.** I retook all 24 and added 16 new ones:
- `runs-skipped`;
- `runs-copy-path` ("Copied" beside the 7th card);
- `settings-budget-repaired` (right after the repairing Save, with its message);
- `settings-budget-run-log-unreadable`.

All are full page, light and dark, at 1280×800 and 390×844.

The harness was an in-process bridge on 127.0.0.1:4330 with /tmp workspaces under `/tmp/p08a-esc-ui/ws/`. The data is fictional (Ada Quill, Northwind Labs). One record's failure text is a hostile HTML and prompt-injection string, and it renders as inert text.

**Browser verification (Playwright + axe-core, scripts in `/tmp/p08a-esc-ui/`, results in `log.json` there).**
- **Coverage:** every state was checked in both themes at 390 and 1280. The states were Runs (records, skipped, empty, run log unreadable, after a copy) and Settings (normal, paused, corrupt, repaired, at the limit, run log unreadable).
- **Audit results:**
  - 0 serious or critical axe findings, and no other findings;
  - no horizontal scroll at 390;
  - every probed text measured ≥ 4.5:1;
  - no console errors;
  - no full UUID in visible text;
  - no UI-authored path outside `<code>`.
- **P9:** Save moved 0 px at both widths, and the pointer was still on Save afterwards, in six cases:
  - an out-of-range limit;
  - an out-of-range cap;
  - a Save that reaches the daily limit;
  - a repairing Save;
  - a second Save while paused;
  - a Save with the run log unreadable.
- **Copy path:**
  - the button moved 0/0 px;
  - the clipboard held the absolute path;
  - "Copied" appeared beside the button, in the viewport;
  - the live region had exactly one write, "Path copied.";
  - pressing another card cleared the note, and it also cleared after 4 s;
  - a refused copy showed "Couldn't copy" and wrote once, "Error: Couldn't copy the path.";
  - 14 cards gave 14 unique Copy path names and 14 unique View JSON names.
- **Focus:** a keyboard Resume leaves focus on `#budget-title` with `:focus-visible` and `solid 2px` in the `--ring` colour. A pointer Resume focuses it with no ring. The summary's ring is `--ring` as well.
- **JSON view:** the `<pre>` parses to exactly the file on disk.

**Report corrections (nit 7), for Revision 1 below.**
- **G1:** it said a turn is ok once any boundary (`session.completed`, `session.failed` or `session.waiting`) is seen. At `371cd63` that was not what the code did:
  - `session.failed` was a failure, since `isTurnFailureEvent` covers it;
  - `session.waiting` was parked;
  - only `session.completed` was ok.

  That is reviewer issue 1: every real conversation turn recorded a failure.
- **"Mutation proofs" 1–3** were regression tests, not mutations; no source was changed for them.
- **G4, "keeps both":** the race test asserted only that the pause survived. Mutation N5 below loses 40 of 40 limit writes, and that old assertion would still have passed.
- **G3:** one description conflated two tests:
  - The >200 test had 4×50 = 200 newer records, with the success 5 days back. It now has 4×51 = 204, and also asserts that `listRuns`' 200-record page excludes the success.
  - The early-exit test has 300 records over 10 days, with the match alone in the newest (11th) day, and a `readJson` spy under 60 calls.
- **G4 part 2's failure text** is `expected [ 'success', 'success' ] to deeply equal [ 'paused', 'success' ]`, not `expected +0 to be 2`.

**Tests, real output.**
- **P08-A files:**

  | File | Tests |
  |---|---|
  | `run-harness.test.ts` | 46 (was 28) |
  | `run-harness-eve-client.test.ts` | 12 (was 5) |
  | `budget.test.ts` | 22 (was 17) |
  | `runs.test.ts` | 28 (was 24) |
  | `routes-runs.test.ts` | 19 (was 16) |
  | `routes-runs-status-fallback.test.ts` (new) | 2 |
  | **Total** | **129** |

- **The six files under three zones:** `TZ=Pacific/Kiritimati`, `TZ=Pacific/Pago_Pago` and `TZ=UTC` each gave `Test Files 6 passed (6)`, `Tests 129 passed (129)`.
- **Full chain from the repo root at `e17d01d`.** The code is identical to this commit; only this report differs.
  - `pnpm install --frozen-lockfile`: "Already up to date".
  - `pnpm typecheck`: 6/6 Done.
  - `pnpm test`: all green.

    | Workspace | Test files | Tests |
    |---|---|---|
    | contracts | 16 | 235 passed |
    | job-assistant | 6 | 151 passed |
    | extension | 16 | 130 passed, 2 skipped |
    | runner | 20 | 284 passed, plus `EVALS 4`, `Results: 4 passed`, `Gates: 20 passed` |
    | catalog | 26 | 168 passed |
    | `scripts/*.test.mjs` | – | 2 passed |

  - `pnpm -r lint`: 6/6 Done, zero warnings.
  - `pnpm check:fixtures`: exit 0.
  - `git status --porcelain`: empty.

**Mutation proofs.** Each mutation was an exact-string replacement in the real source (`/tmp/p08a-esc/mut.sh` and `mutations/spec/*.json`). I ran the named tests, restored the file from a `/tmp/p08a-esc/backup/` copy, and confirmed it clean with `git diff --quiet`. All 22 were killed:

| Mutation | Tests failed |
|---|---|
| **I1a:** `session.waiting` also parks | 6 |
| **I1b:** `turn.cancelled` treated as ok | 3 |
| **I1c:** an empty `input.requested` list parks | 1 |
| **I1d:** no cancel on park | 2 |
| **I2a:** `getBudgetState` rethrows | 6 |
| **I2b:** `withRun` rethrows before the body | 2 |
| **I2c:** empty key not refused | 2 |
| **I2d:** `status()` rethrows | 2 |
| **I2e:** `listRuns` rethrows on `runs/` | 2 |
| **I2f:** run-log pause dropped | 4 |
| **M05:** timeout drops the model | 3 |
| **M04:** timeout drops the usage | 2 |
| **N4:** unbounded cancel | 1 (hit the 15 s test timeout) |
| **G2a:** whitespace passes | 2 |
| **G2u:** `throw undefined` becomes "undefined" | 1 |
| **G2b:** no minimal record | 2 |
| **G2c:** no in-memory last resort | 1 |
| **TZa:** UTC getters in `localDateString`, run under ambient `TZ=UTC` | 3 (Kiritimati, Pago Pago, the filing case) |
| **N5:** `pauseBudget` reads outside the lock | 1: `expected { pausesLost: +0, limitsLost: 40 } to deeply equal { pausesLost: +0, limitsLost: +0 }` |
| **N8:** no unknown-model placeholder | 1 |
| **M03:** no timeout cancel | 6 |
| **M06:** a thrown abort treated as failed | 2 |

M05, G2b, G2c and TZa are the reviewer's survivors.

**What was skipped, and why.** Nothing in I1–I4 was skipped. Schedules are still P08-B. No route calls `withRun` or `runTurn` yet; that is P05's and P08-B's job. I left the `Status:`/`Assignee:` lines alone because this round's Owns covers the report only.

**Assumptions and observations.**
1. **The two in-memory "did not start" records are never written.**
   - The empty-key record keeps the key as given (""), so it would not validate against `runRecordSchema`. Nothing persists it.
   - A whitespace-only key is refused like an empty one, which is stricter than the schema's `min(1)`.
   - The in-memory last-resort record now computes `durationMs` from `startedAt`.
2. **`pauseKind` precedence** is my reading of I2 plus decision 2. A stored pause outranks the run-log pause, and `runLogUnreadable` is still flagged alongside it.
   - After a repairing Save, `/status` reports the new, truthful reason.
   - A legacy stored `budget settings unreadable (runs/budget.json)` also reads as `budget_repaired`.
   - `corruptOrigin` is still returned; it is true for `budget_unreadable` or `budget_repaired`. The UI now keys on `pauseKind`.
3. **The `/status` fallback reason** is a fixed "budget status unavailable". It keeps `runsUsedToday` at 0 and the default limit, so the shape still matches the contract.
4. **Flagged, not acted on (outside I1's definition):** eve's `session.js` keeps a response attached across an interim `session.waiting` only while an `authorization.required` with a `webhookUrl` is pending. An authorization with no `webhookUrl`, followed by `session.waiting`, would read as ok. P05 should decide whether that is possible for our agent.
5. **Flagged:** `hasSucceededWithIdempotencyKey` still rejects when a date folder can't be listed. P05 and P08-B must treat a rejection as "unknown", not "not done".
6. **`AbortSignal.timeout` uses an unref'd timer in Node.** A standalone CLI whose only pending work is a turn can exit before the turn finishes; my /tmp seed script did. The bridge is kept alive by its server, so nothing changed here.

### 2026-09-22 — Revision 1 (iter-005 implementer, Sonnet successor)

> Revision 2 above corrects parts of this entry: the G1 text, "mutation proofs" 1–3, the G3 and G4 descriptions, and G4 part 2's failure text.

The orchestrator assigned "P08-A (#13) revision 1" after both reviewers (the Class-A Reviewer and the UI critic) returned REVISE on head `0af2945`, carrying code word `f0b39a` (confirmed genuine against the branch/PR state). This is the one revision round the packet gets. Work list authority: `logs/handoff/P08-A-round-1-review.md` (critic's issues 1–9 + polish P1–P11, reviewer's issues 1–5 + nits, orchestrator decisions G1–G10). No other message claiming to be the orchestrator arrived during this round.

**Correctness, per item.**

- **G1 (reviewer issues 1 and 3; root cause per `docs/spec/research/eve-runtime.md` §8 item 15 — eve@0.63.0's client can end an aborted turn quietly, `result()` reporting `"completed"`).** `runTurn` no longer trusts `response.result()`. It reads `created.response` event by event with `for await`, summing `step.completed` usage and taking the model id from `step.started`. A turn is `"ok"` only when a terminal boundary event (`isCurrentTurnBoundaryEvent`: `session.completed`/`session.failed`/`session.waiting`) was actually seen *and* `signal.aborted` is false after the loop exits. A thrown abort and a quietly-ending abort both funnel into one `if (signal.aborted)` check after the `try/for-await/catch` — the catch deliberately does not rethrow when `signal.aborted` is true, so both mechanics land in the same branch and both give `"timeout"` with whatever partial usage/model were read before the abort. Cancellation goes through `created.session.cancel()` (a `ClientSession`), never `MessageResponse.cancel()`, which eve-runtime.md documents as sending nothing before a turn has started or once it's parked. New file `test/run-harness-eve-client.test.ts` drives a real eve `Client` against a scripted, stubbed `fetch` (`vi.stubGlobal("fetch", ...)`, adapted from the reviewer's `/tmp/p08a-review/in-tree-probes/*.test.ts` templates) for all three named abort points plus a control case and a parked case (5 tests, listed under Tests below).
- **G2 (issue 2).** `withRun`'s `finally` never rejects. `nonEmptyOrFallback()` turns an empty thrown-error message or empty turn detail into the fixed sentence `EMPTY_ERROR_FALLBACK = "The run failed without an error message."`. If the real `finishRun` call fails schema validation, `withRun` catches it, logs, and writes a minimal fixed-text failure record (`MINIMAL_FINISH_ERROR`) instead; if *that* also fails, it resolves with an in-memory `RunRecord` built by hand rather than throwing. Tested with an empty thrown `Error("")` and an empty turn `detail`.
- **G3 (issue 4).** `hasSucceededWithIdempotencyKey` rewritten as a bespoke newest-first scan: date directories sorted descending, each day's records read and sorted by `startedAt` descending, returning on the first match — no 200-record cap, covering the full 14-day window. Tested with >200 newer non-matching records seeded across 10 prior days and the actual match alone in an 11th (empty) day; a `readJson` spy asserts under 60 calls total, proving early exit rather than a full-window read. A separate test confirms a `paused` record is never counted as a success.
- **G4 (issue 5).** One in-process promise chain per workspace (`withBudgetLock`, a `WeakMap<Workspace, Promise<void>>` in `store/budget.ts`, `tail.then(fn, fn)` so a rejecting link never poisons the chain for the next caller). `pauseBudget`, `resumeBudget`, and `setBudgetLimits` each wrap their whole read-modify-write in it. `withRun` holds the same lock across its refusal check (paused / at-limit) *and* `startRun`, by restructuring the check-then-write into an explicit `RunDecision` returned from inside the lock's callback — nothing outside that decision (the turn itself, `finishRun`) holds the lock. Tests: a Save racing a provider-limit pause keeps both, every time, across 40 trials (mutation target: un-serialize the writes); `withBudgetLock` itself serializes strictly one caller at a time; two concurrent `withRun` calls at one below the limit let exactly one run (the other gets a paused record).
- **G5.** `isProviderLimitFailure` extended: when `details.semanticErrorId` is absent, `details.statusCode === 429` or `details.upstreamStatusCode === 429` now also counts as a provider limit, alongside the existing `/429|rate.?limit/i` regex against `code`/`message`. Precedence preserved and tested: *any* `semanticErrorId`, even one unrelated to rate limiting, is still the whole answer — the statusCode/regex fallbacks are never consulted once a semantic id is present, so a message merely mentioning "429" alongside an unrelated id is not a provider limit.
- **G6.** `/status`'s `budget.paused` stays exactly the manual/provider pause needing Resume; "daily limit reached" is documented in `runner/README.md` as a state a consumer derives itself from `runsUsedToday >= dailyRunLimit`, never a second stored or wire-level paused-like flag. Settings' own UI applies the same rule (see P1 below).
- **Nits.** The restart-survival test in `budget.test.ts` now asserts the on-disk bytes of `runs/budget.json` via `readFile` + `JSON.parse`, not just the re-read state. Date-sensitive tests in `runs.test.ts` explicitly set/restore `process.env.TZ` around themselves (a `withTz()` helper) rather than relying on the ambient shell, plus a new local-midnight-crossing case. The test previously misnamed at `budget.test.ts`'s corrupt-file section now correctly names the e2e test it references (`run-harness.test.ts`'s "a corrupt runs/budget.json refuses withRun..."). `getRun` now checks the file's own `record.runId === runId` before returning it, defending a hand-edited or corrupted file. `listRuns` wraps each `workspace.list(RUNS_SEGMENT, date)` call in try/catch; a directory-level failure pushes `runs/<date>/` to a new `skippedFiles` list and increments `invalidCount`, never throwing a 500.

**UI, per item.**

1. **Failure pill (G7 — exactly two `runner.css` edits, both outside Owns, both listed below).**
2. **Error text ≥4.5:1.** `.status-message.error` in both `settings.css` and `runs.css` switched from color-only signaling to foreground text plus a `3px solid var(--destructive)` left border; `announce()` in both `runs.js` and `settings-budget.js` prefixes error messages with a literal `"Error: "` text marker so the signal survives for assistive tech and color-blind users alike.
3. **Resume focus.** The Resume handler in `settings-budget.js` captures `wasCorrupt` first, then calls `$("budget-title").focus()` *before* `renderBudget()` runs (which hides the pause notice, and the Resume button inside it) — so focus never falls back to `<body>`. `#budget-title` in `settings.html` is now `tabindex="-1"`.
4. **Client-side bounds checking.** `validateField()` in `settings-budget.js` checks both inputs against `BOUNDS` (1–50 / 1–20) before any `POST`; each input in `settings.html` has a sibling `<p class="hint small muted">` hint tied via `aria-describedby`; the form is `novalidate` so the browser's own bubble never preempts it. An invalid submit announces one plain sentence, sets `aria-invalid="true"`, and keeps focus on the offending input; a genuine server 400 (client validation passed but the server still rejects) shows one fixed friendly sentence, never the raw body.
5. **Overflow at 390.** `.run-meta { overflow-wrap: anywhere; }` plus `.run-meta > span { min-width: 0; overflow-wrap: anywhere; }` in `runs.css`.
6. **Empty state.** `#empty-state` reads "No runs yet." (was "No runs yet…"); `loadRuns()` no longer announces anything on the empty-list path, it just shows the empty state and hides the `<ul>` — nothing is echoed into the live region on load.
7. **Paths/ids (G8).** `shortRunPath()` renders `runs/<date>/<8 chars>….json` with the full relative path in `title`; a "Copy path" button writes the new `absolutePath` field (added to the local runs list/detail API only, `runRecordWithPath`, never to `/status`) to the clipboard. A record whose `model === NO_MODEL` (never called the model) shows no model/token/duration line at all. Error codes (`run.error`'s leading `CODE:` prefix) are stripped from the visible text by `humanizeReason()` and appear only in the "View JSON" disclosure.
8. **Amber (G9).** `OUTCOME_BADGE` maps `paused` to the neutral badge class, not amber, so both catch-up and past-paused records render neutrally; `renderSkippedNote()` is a neutral note naming up to `MAX_SKIPPED_FILES_REPORTED = 10` skipped files in `<code>`, with an "and N more." tail past the cap; amber is reserved for the *current* pause notice on Settings.
9. **Corrupt budget.** `renderPauseReason()` regex-splits `CORRUPT_BUDGET_REASON`'s trailing `(runs/budget.json)` into a text node plus a `<code>` element when `state.corruptOrigin` is true. `#budget-corrupt-note` (shown only while `corrupt`) reads "The limits shown are the defaults. Resume saves them and restarts runs; Save keeps runs paused." Save while still paused announces "Saved. Runs stay paused until you press Resume."; Resume specifically from a corrupt file announces "Resumed. The default limits (10 runs a day, 5 jobs per run) were saved." (a plain "Runs resumed." otherwise).

**Polish.** P1: the old zero-runs-left phrasing is replaced by `#budget-limit-note`, "Daily limit reached. New runs wait until tomorrow." — hidden whenever `paused` is true (G6: don't stack it with the pause notice) or `runsUsedToday < dailyRunLimit`. P3: a record with no `finishedAt` (the crash-safe placeholder) renders a neutral "Did not finish (or still running)" badge with no meta row at all, instead of a zero-duration/zero-token line. Both `runs.js`'s and `settings-budget.js`'s `announce()` clear the live region then re-set its text on the next animation frame, so a repeated identical message (e.g. "Saved." twice) is still re-announced rather than silently skipped as unchanged.

**The two `runner.css` edits (G7 — nothing else in that file was touched, confirmed by `git diff`):**
1. `.badge.fail`'s `color` changed from `oklch(1 0 0)` (white) to `oklch(0.2 0 0)`, matching `.badge.warn`'s existing pattern — white-on-`--destructive` measured 3.85:1 light / 3.04:1 dark (an axe "serious" violation, below 4.5:1); the new value is about 4.7:1 light / 5.9:1 dark.
2. A new shared rule, `input, select, textarea { border-color: var(--muted-foreground); }` — `--border` is a hairline divider token measured at 1.27:1 against the card, not built to serve as a form-control border (WCAG 1.4.11 needs ≥3:1); `--muted-foreground` already clears normal-text contrast, well above 3:1. A page's own more specific input rule (e.g. `settings.css`'s `.field input`) still opts in on top of this shared default.

**Tests, with real output.** Every touched/new file, run standalone: `test/budget.test.ts` 17 passed, `test/runs.test.ts` 24 passed, `test/routes-runs.test.ts` 16 passed, `test/run-harness.test.ts` 28 passed, `test/run-harness-eve-client.test.ts` (new) 5 passed — 90 passed total across these five files (62 carried over from part A plus 28 new this round: +3 budget, +9 runs, +3 routes-runs, +8 run-harness, +5 the new eve-client file). Full runner suite: `Test Files 19 passed (19)`, `Tests 245 passed (245)`, plus the existing eval harness (`EVALS 4`, `Gates: 20 passed`) unaffected. Full monorepo chain from the repo root: `pnpm install --frozen-lockfile` (up to date), `pnpm typecheck` (6/6 workspaces "Done"), `pnpm test` (contracts 235, job-assistant 151, extension 130 passed/2 skipped, runner 245 + eval gates 20/20, catalog 168, `scripts/*.test.mjs` 2 — all passed), `pnpm -r lint` (6/6 workspaces "Done", zero warnings), `pnpm check:fixtures` (exit 0). Reran the full `pnpm test` chain twice more, under `TZ=Pacific/Kiritimati` (UTC+14) and `TZ=Pacific/Pago_Pago` (UTC−11) — the two non-DST extremes — both fully green with identical counts (`runner: Test Files 19 passed (19)`, `Tests 245 passed (245)`; every other workspace unchanged). `git status --porcelain` was empty after the merge with `overnight/integration` and again confirmed clean of stray mutation leftovers immediately before staging.

**Mutation proofs.** Each was applied directly to the real source file, its target test run to confirm red, then restored via `cp` from a pristine `/tmp/p08a-rev1-mutation-backups/` copy (not `git checkout`) and confirmed byte-identical with `diff`, then the suite re-run green:
1. *G1, abort point 1 of 3 (before the stream opens).* Verified via the dedicated eve-client regression test against a fetch stub that never resolves the initial request before the timeout; confirms `"timeout"` with a real cancel.
2. *G1, abort point 2 of 3 (the routine lease-end reconnect).* Same pattern, scripted so the abort lands mid-reconnect.
3. *G1, abort point 3 of 3 (an idle reconnect; eve's 15s idle timeout firing before our deadline).* Same pattern (`{ timeout: 40_000 }` on the test itself).
4. *G1, deleting the cancel.* Removed the `session?.cancel()` call sites; the eve-client regression tests' real-cancel-count assertions failed (a scripted server endpoint recorded zero cancel requests instead of one). Restored.
5. *G2.* Changed `nonEmptyOrFallback` to return the empty string unchanged; the "empty thrown error" and "empty turn detail" tests failed schema validation instead of getting the fixed sentence. Restored.
6. *G3.* Reintroduced a 200-record cap inside the scan; the ">200 newer non-matching records" test failed (the true match, older than the 200th record, was never reached). Restored.
7. *G4, part 1 (`budget.ts` writes).* Un-wrapped `pauseBudget`/`resumeBudget`/`setBudgetLimits` from `withBudgetLock`; the "a Save racing a provider-limit pause keeps both" test lost writes across its 40 trials. Restored.
8. *G4, part 2 (`withRun`'s own lock-holding).* Un-wrapped the decision block inside `withRun` from `withBudgetLock` (a direct IIFE call in place of the locked one). The "two concurrent runs at one below the limit let exactly one run" test failed: `expected +0 to be 2` on `runsUsedToday` (both calls raced past the check-then-write). Restored; `diff` confirmed byte-identical; full `run-harness.test.ts` + `run-harness-eve-client.test.ts` re-ran green (33 passed).
9. *G5, precedence.* The fixed code short-circuits on any `semanticErrorId`: `if (typeof semanticErrorId === "string") return RATE_LIMIT_SEMANTIC_IDS.has(semanticErrorId);` — an unrelated id returns `false` immediately, without ever reaching the `statusCode`/regex fallbacks below. The mutation weakened that line to `if (typeof semanticErrorId === "string" && RATE_LIMIT_SEMANTIC_IDS.has(semanticErrorId)) return true;`, which drops the short-circuit: an unrelated id now falls through instead of returning early. The "G5 precedence" test failed: `expected true to be falsy` (`providerLimit` flipped from `false` to `true` once the unrelated id fell through to a matching `statusCode`/regex). Restored; `diff` confirmed byte-identical; full suite re-ran green (33 passed).

**What was skipped, and why.** Nothing in scope for this revision round was skipped. Schedules (`agent/schedules/`, `scheduler/`, the schedules section of `settings.html`) remain P08-B, still outside this packet's `Owns` and untouched. No route calls `withRun`/`runTurn` yet, unchanged from part A — still P05/P08-B's job.

**Assumptions.**
1. The FINISH instruction's "both TZ runs" was read as reruns of the *full* `pnpm test` chain (not just the runs/budget-scoped subset part A's report used), since this round's correctness changes touch `run-harness.ts` and `routes/runs.ts` as well, not only `store/runs.ts`/`store/budget.ts`.
2. G4's "holds it across the limit check and `startRun`" was read as: the lock's critical section is exactly read-state → decide → write-the-decision (either a paused refusal or `startRun`'s placeholder), and releases before the turn body or `finishRun` run — a long-running turn never holds the budget lock, only the accounting around it does.
3. The Report's newest entry is inserted directly under `## Report`, above the existing part-A entries, keeping the file's established newest-first order (confirmed against the existing part-A/part-A-paused ordering already in this file) rather than appended at the very end.

**Head SHA:** `a32ce5a4679dc6849db453a2ef20e610c8d95c25`, pushed to `origin/packet/P08-A` (fast-forward from `0af2945`). CI run `35782168795` on that head: `conclusion: success` (Typecheck, Lint, Test, Check fixtures policy, Build catalog all green).

### 2026-09-22 — Part A (iter-005 implementer, Sonnet successor)

**A message claiming to be the orchestrator arrived mid-task, attached to a tool result, carrying the code word `f0b39a`.** Per my instructions that makes it genuine, and its content (branch/commit state, port 4330) matched reality exactly. I followed it: kept working, and committed + pushed at the next green checkpoint (the store/harness/route/UI files, right after typecheck+lint+the full existing suite passed). No other message claiming to be the orchestrator arrived, genuine or otherwise, so there is nothing to flag as spoofed.

**What was done.** The predecessor's design (paused note below) was implemented essentially as planned, with the five orchestrator decisions applied on top of it:

- `store/runs.ts`: `runs/<date>/<runId>.json`, `<date>` = OS-local calendar date of `startedAt` (`localDateString`, local `Date` getters, never UTC). `startRun` writes the crash-safe placeholder (`outcome:"failure"`, the fixed "interrupted" message, no `finishedAt`); `finishRun` overwrites the same file; `writePausedRun` is one-shot. Every write goes through an `orderedRecord()` helper so the JSON key order is stable regardless of build order. `listRuns` (newest-first, bounded 200/14 days), `getRun` (uuid-checked before any fs call), `countCountableRuns` (excludes `paused`), `hasSucceededWithIdempotencyKey`. An invalid or unreadable file is skipped and counted, never thrown.
- `store/budget.ts`: `runs/budget.json`, bounds 1–50 / 1–20, defaults 10/5. `runsUsedToday` is always derived via `countCountableRuns`, never persisted. Decision 2 implemented as: a missing file → defaults; a present-but-invalid file (bad JSON or schema-invalid) → `getBudgetState`/`getBudgetStatus` report `paused: true` with reason `CORRUPT_BUDGET_REASON` synthetically, at read time, without ever throwing and without rewriting the bad file. `pauseBudget`/`resumeBudget`/`setBudgetLimits` all write a fresh, valid file. See "Assumptions" below for exactly how Resume vs. Save treat an existing pause.
- `server/run-harness.ts`: `withRun` (refuses before any work when paused or at the daily limit, writing a one-shot paused record; otherwise crash-safe start → body → accumulate tokens/model → finalize in a `finally`, so it always resolves with the record and never rethrows) and `runTurn` (one `client.sessions.create` call, sums `step.completed` usage, takes the model id from the last `step.started`, classifies ok/failed/parked/timeout, detects a provider limit per decision 1 and pauses the budget itself, never retries). Free functions over `ctx`, no new context fields, not called from any real route yet.
- `server/routes/runs.ts`: `GET /` (list), `GET /:runId`, `GET /budget`, `POST /budget`, `POST /budget/resume`, `status()` contributing `budget`. The `/budget*` routes are registered before `/:runId` so "budget" can never be mistaken for a run id.
- `ui/runs.html` + `assets/{runs.js,runs.css}`: newest-first list, outcome pill + reason, duration/tokens/model, catch-up badge, item-cap note, file path (`<code>`, full uuid — see assumption 4) with a "View JSON" disclosure, empty state, one persistent live region.
- `ui/settings.html` (new file — budget is the first section) + `assets/{settings-budget.js,settings.css}`: bounded number inputs, runs-used-today, pause + reason + Resume, Save. `aria-disabled` (not `disabled`) while busy, kept focusable throughout.
- `runner/README.md`: the Runs page, the Settings Budget section, `runs/<date>/<runId>.json` and `runs/budget.json` in the workspace layout, and the P08 row of "Extending the runner" split into P08-A (this) and P08-B (schedules, still to come).
- `test/route-modules.test.ts`: `"runs"` added to the pinned list (`["devices","model","pairing","runs","status"]`). Re-checked with `git fetch origin` immediately before opening the PR: P03 is still in round-2 revision on `origin/overnight/integration`, not merged, so the pinned-list form (not P03's readdir-based replacement) is correct as landed.

**Tests, with real output.**

- New files: `test/runs.test.ts` (15), `test/budget.test.ts` (14), `test/run-harness.test.ts` (20), `test/routes-runs.test.ts` (13) — 62 new tests.
- Full runner suite after the merge with `overnight/integration`: `Test Files 18 passed (18)`, `Tests 217 passed (217)`.
- TZ runs (`runs.test.ts` + `budget.test.ts`, then `run-harness.test.ts` + `routes-runs.test.ts`), each set run twice:
  - `TZ=Pacific/Kiritimati` (UTC+14: the same instant as UTC+0 lands one calendar day *later* locally): `Test Files 2 passed (2)`, `Tests 29 passed (29)`; then `Test Files 2 passed (2)`, `Tests 33 passed (33)`.
  - `TZ=Pacific/Pago_Pago` (UTC−11: the same instant lands one calendar day *earlier* locally): `Test Files 2 passed (2)`, `Tests 29 passed (29)`; then `Test Files 2 passed (2)`, `Tests 33 passed (33)`.
  - These two zones were chosen because they're the extremes (+14/−11) and neither observes DST, so a plain `ManualClock` default start (`2026-09-22T09:00:00.000Z`) genuinely lands on different local calendar dates under each — Kiritimati stays Sep 22 local, Pago Pago is Sep 21 local. `localDateString`'s own unit test additionally uses the local-time `Date(year, month, day, h, m, s)` constructor either side of local midnight, which is TZ-independent by construction (see the test file).
- Full chain from the repo root, after merging the latest `origin/overnight/integration` (log-only changes; no conflicts): `pnpm install --frozen-lockfile` (up to date), `pnpm typecheck` (6/6 workspaces, all "Done"), `pnpm test` (contracts 235, job-assistant 151, extension 130 passed/2 skipped, runner 217 + eval gates 20/20, catalog 168, `scripts/*.test.mjs` 2 — all passed, zero failures), `pnpm -r lint` (6/6 workspaces, all "Done", zero warnings), `pnpm check:fixtures` (exit 0). `git status --porcelain` empty afterward.

**Mutation proofs.** Each was applied to the real source file, its target test run to confirm red, then `git checkout -- <file>` and `git diff`/`git status --porcelain` confirmed to restore the exact prior state:
1. *Drop the finally* (`run-harness.ts`, `withRun`): moved the `finishRun` call out of `finally` so it only runs on the happy path. `test/run-harness.test.ts`'s "a body that throws..." test failed with `TypeError: Cannot read properties of undefined (reading 'outcome')` (the returned record was `undefined`). Restored; suite green again.
2. *Retry on the provider limit* (`run-harness.ts`, `runTurn`): added a second `eve.client.sessions.create` call when `interpretTurn` reports `providerLimit`. The "simulated 429 storm" end-to-end test failed: `expected 2 to be 1` on the fake client's call count. Restored.
3. *Forget to persist the pause* (`budget.ts`, `pauseBudget`): made the function a no-op (read the file, then do nothing). `budget.test.ts`'s restart-survival test failed (`paused: false` instead of `true`), and `run-harness.test.ts`'s storm test failed the same way (`state.paused` false). Restored.
4. *Count `paused` records toward the daily limit* (`runs.ts`, `countCountableRuns`): dropped the `outcome !== "paused"` filter. `runs.test.ts`'s count test failed (`expected 3 to be 2`) and `budget.test.ts`'s "never counts paused records" test failed the same way (`expected 3 to be 1`). Restored.

**Eve facts relied on, each independently re-opened at the installed `eve@0.63.0` before coding against it (never memory):**
1. `runner/node_modules/eve/dist/src/protocol/message.d.ts` — `StepCompletedStreamEvent.data.usage?: {inputTokens?, outputTokens?, ...}` (all optional numbers); `StepStartedStreamEvent.data.modelId` (present; `step.completed` has no model id); `StepFailedStreamEvent`/`TurnFailedStreamEvent`/`SessionFailedStreamEvent` all carry `{code, message, details?: JsonObject}`; `TurnFailureStreamEvent = SessionFailedStreamEvent | StepFailedStreamEvent | TurnFailedStreamEvent`; `isTurnFailureEvent` type guard.
2. `runner/node_modules/eve/dist/src/client/index.d.ts` — `eve/client` publicly re-exports `isTurnFailureEvent`, `TurnFailureStreamEvent`, `StepStartedStreamEvent`, `StepCompletedStreamEvent`, `MessageResult`, `MessageResponse`. Used these public types directly in `run-harness.ts` rather than hand-rolling the equivalent `.find(e => e.type === ...)` check `eve-gateway.ts` uses (read-only reference; out of Owns).
3. `runner/node_modules/eve/dist/src/client/types.d.ts` — `MessageResult<TOutput> = {data, message, events, inputRequests, sessionId, status: "completed"|"failed"|"waiting"}`; `SendTurnInput`/`SendTurnOptions` confirm `client.sessions.create({message, signal, ...})`.
4. `runner/node_modules/eve/dist/src/client/sessions.d.ts` — `ClientSessions.create(input): Promise<{response, session}>` (the overload with a `message` starts the first turn).
5. `runner/node_modules/eve/dist/src/client/message-response.d.ts` — `MessageResponse.cancel(): Promise<CancelSessionResult>`, `.result(): Promise<MessageResult>`.
6. **Provider-limit signal** — `runner/node_modules/eve/dist/src/harness/semantic-errors/rules/gateway.js`: `GATEWAY_RULES` includes `{id:"gateway-rate-limited", when: anyOf(nameIs("GatewayRateLimitError"), typeIs("rate_limit_exceeded")), tags:["gateway","transient"], hint:"Retries are automatic; ..."}` and `{id:"gateway-free-tier-rate-limited", when: messageMatches(/Free tier requests on this model are rate-limited/), tags:["gateway","recoverable"]}`. `runner/node_modules/eve/dist/src/harness/semantic-errors/rules/model-provider.js`: no rate-limit/429 rule exists outside the gateway rules. `runner/node_modules/eve/dist/src/harness/tool-loop.js` (minified; grepped for `semanticErrorId`): `buildModelCallFailureDetails` builds `{errorId, message: t.message, name: t.name, semanticErrorId: t.id, ...}` (`t` = the matched catalog rule) and that object is passed as `details` into `emitFailedStep`/`emitRecoverableFailedTurn` under `code: "MODEL_CALL_FAILED"` — confirming `details.semanticErrorId` is exactly the matched rule's `id`. The gateway rule's own hint ("Retries are automatic") is about the AI Gateway/AI-SDK's *own* internal retry before a failure ever reaches us (also matches the original packet text, "429 after eve's three attempts") — orthogonal to, and not an argument for, `runTurn` retrying again on top of that.
7. `runner/node_modules/eve/docs/concepts/sessions-runs-and-streaming.md`, "Cancel the in-flight turn" — both `"accepted"` and `"no_active_turn"` are success outcomes, safe to fire-and-forget, matching `runTurn`'s `.catch(() => undefined)` on every `cancel()` call.

**What was skipped, and why.** Everything schedules-related (`agent/schedules/`, `scheduler/`, the schedules section of `settings.html`, `start()` catch-up, `status()` schedules) is P08-B, outside this packet's Owns and explicitly out of scope per the task ("without schedules"). No route calls `withRun`/`runTurn` yet — the packet says P05 and P08-B do that; part A ships the harness only. No "run now" UI trigger exists on the Runs page for the same reason: nothing in part A is meant to start a real run.

**Assumptions** (each confirmed by a test, and called out again here for review):
1. Decision 2's "Resume rewrites a valid file with the default limits, unpaused" is specific to recovering from a *corrupt* file (nothing valid to preserve). A normal (non-corrupt) Resume keeps the existing `dailyRunLimit`/`itemCap` and only clears the pause — resetting a person's custom limits on every ordinary provider-limit Resume seemed like a surprising, unrequested side effect. Tested both paths separately in `budget.test.ts`.
2. Decision 2's "Save ... keeps the pause until Resume" applies uniformly, including to the *synthetic* corrupt-file pause: `setBudgetLimits` on a corrupt file writes a valid file with the submitted limits but stays paused with `CORRUPT_BUDGET_REASON` until an explicit Resume, rather than silently curing the corruption's pause as a side effect of an unrelated Save. Tested in `budget.test.ts`.
3. `model` is a required non-empty string in the contract, so a record where no model was ever contacted (the crash-safe placeholder, a paused refusal) needs a placeholder value. Used the literal `"n/a"` (exported as `NO_MODEL` from `store/runs.ts`).
4. The Runs page's file-path display necessarily shows the run's full uuid, as part of the filename (`runs/<date>/<runId>.json`) — the packet asks for this exact path "so the person can open it," and shortening it would make it unopenable. Read this as a deliberate, narrow exception to "no full UUIDs in visible text," which I otherwise followed (the run id is never shown as its own label; only the path, its `title` attribute, and the opt-in "View JSON" disclosure carry it).
5. `listRuns`'s 14-day window is a rolling `now − 14×24h` cutoff on the local calendar date, not a snap to local midnight N days ago. The spec only says "bounded... 14 days," not more precisely.
6. Decision 1's fallback regex checks both the failure's `code` and `message` (as written: "on the failure's `code` or `message`"), tested separately for each field.

**One thing to sharpen next time.** `ui/settings.html` is now a single shared file that P08-B (schedules) and P10 (upgrade) will both add a `<section>` to. Nothing enforces at review time that a later packet actually confines itself to appending its own section rather than editing this one's budget markup — a cheap guard (a test asserting the budget `<section>`'s heading id, form field ids, and script `src` are unchanged) would catch an accidental cross-packet edit immediately instead of at UI-critic review time.

**Head SHA:** see the PR; every step above was committed and pushed incrementally (claim → stores/harness/route/UI → tests → README → screenshots → the merge with `overnight/integration`), never batched into one commit.

### 2026-09-22 — Part A paused (iter-005 implementer, Sonnet)

**Why paused:** the owner paused the overnight loop to switch the orchestrator model. This lands mid-research, before any implementation code was written. Worktree is clean (`git status --porcelain` empty) other than this report edit; nothing else to commit.

**Setup (packet preamble) — done:**
- Branch `packet/P08-A` created from `origin/overnight/integration` at `f9e421f` (confirmed via `git log --oneline -1`).
- `pnpm install --frozen-lockfile` from the repo root: succeeded.
- All required reading done: `CLAUDE.md` (root), `docs/spec/implementation/README.md`, this packet, `docs/spec/mvp-spec.md` (F10/F11/§5/§6/§7), `docs/spec/hard-problems.md` #4/#7, `docs/spec/research/eve-runtime.md` §4/§8, `packages/contracts/src/run.ts` and `bridge-http.ts`, `runner/server/route-modules.ts`, `context.ts`, `eve-gateway.ts`, `local-ui.ts`, `store/atomic.ts`, `lib/clock.ts`, `runner/README.md`, plus `runner/server/app.ts`, `store/workspace.ts`, `store/devices.ts`, `store/journal.ts`, `store/model-check.ts`, `lib/crypto.ts`, `routes/status.ts`/`model.ts`/`pairing.ts`, `server/http.ts`, `server/events.ts`, `server/extension-api.ts`, `test/helpers.ts`, `test/route-modules.test.ts`, `test/eve-gateway.test.ts`, `runner/ui/status.html` + `assets/{runner,status}.js` + `assets/runner.css`, `docs/spec/visuals/theme.css`, `packages/contracts/src/primitives.ts`, `runner/package.json`, root `package.json`, `runner/vitest.config.ts`, `runner/tsconfig.json`, `docs/spec/implementation/fixtures-policy.md`, `scripts/check-fixtures.mjs`.
- Claim recorded just now (this commit): `Status: claimed (paused) (part A, iter 005)`.

**Deliverables — not started (no code written yet):**
- `runner/store/runs.ts` — not started.
- `runner/store/budget.ts` — not started.
- `runner/server/run-harness.ts` — not started.
- `runner/server/routes/runs.ts` — not started.
- `runner/ui/runs.html`, `runner/ui/settings.html` (budget section), `runner/ui/assets/runs.js`, `runner/ui/assets/settings-budget.js` — not started.
- Test files — not started.
- `runner/test/route-modules.test.ts` (add `"runs"` to the pinned list) — not started.
- `runner/README.md` updates (Runs page, budget settings, P08 row) — not started.
- Screenshots — not started.
- PR — not opened.

**What is done: a full design, worked out against primary sources, so the next session can implement directly instead of re-deriving it.**

*Eve facts relied on, each verified against the installed eve@0.63.0, never memory:*
1. `step.completed` usage shape — `runner/node_modules/eve/dist/src/protocol/message.d.ts` (`StepCompletedStreamEvent`): `data.usage?: { costUsd?, inputTokens?, outputTokens?, cacheReadTokens?, cacheWriteTokens? }`, all optional numbers; sum `inputTokens`/`outputTokens` per run, defaulting missing values to 0.
2. `step.failed`/`turn.failed`/`session.failed` all carry `data: {code, message, details?}` (same file); confirmed in prose at `runner/node_modules/eve/docs/concepts/sessions-runs-and-streaming.md`.
3. `eve/client`'s public `index.d.ts` (`runner/node_modules/eve/dist/src/client/index.d.ts` lines 17–18) re-exports `MessageStreamEvent`, `StepCompletedStreamEvent`, `StepFailedStreamEvent`, `TurnFailedStreamEvent`, `SessionFailedStreamEvent`, `StepStartedStreamEvent`, `TurnFailureStreamEvent`, and the type guard `isTurnFailureEvent` — use these public types/guard in `run-harness.ts` rather than hand-rolling (existing `eve-gateway.ts` hand-rolls the equivalent `.find(e => e.type === ...)` check; both work, the guard is more precise and is what I planned to use).
4. **Provider-limit (429) signal**, the hardest fact to pin down: eve classifies a rate limit as semantic-error-catalog rule `id: "gateway-rate-limited"` (also `"gateway-free-tier-rate-limited"`), tags `["gateway","transient"]`, matched by `nameIs("GatewayRateLimitError")` or `typeIs("rate_limit_exceeded")` — found in the *compiled* `runner/node_modules/eve/dist/src/harness/semantic-errors/rules/gateway.js` (the sibling `.d.ts` only exposes the opaque `GATEWAY_RULES` array, not the ids — had to read the `.js`). The matched rule's `id` is copied into the failure event's `data.details.semanticErrorId` — confirmed by grepping `semanticErrorId: t.id` / `semanticErrorId: n.id` in `runner/node_modules/eve/dist/src/harness/tool-loop.js` and `runner/node_modules/eve/dist/src/execution/terminal-session-failure-step.js`. There is **no** direct-provider (non-gateway) statusCode-429 rule in `harness/semantic-errors/rules/model-provider.js` — only the gateway rules mention rate limiting by name. Planned detection (not yet coded): primary = `details.semanticErrorId` is one of the two ids above; fallback = `/rate.?limit/i.test(message)` for a 429 eve doesn't classify with a gateway semantic id. **The fallback is my own inference, not eve-documented — flag on review.**
5. Cancel: `MessageResponse.cancel()` (`runner/node_modules/eve/dist/src/client/message-response.d.ts`), "Requests cooperative cancellation of this exact turn"; also `ClientSession.cancel()`. Wire route and semantics: `runner/node_modules/eve/docs/concepts/sessions-runs-and-streaming.md` "Cancel the in-flight turn" — `POST .../session/:id/cancel` → `{sessionId, status:"accepted"}` or `{status:"no_active_turn"}`, both are success/fire-and-forget-safe.
6. `client.sessions.create({message, signal})` returns `{response, session}`; `response.result(): Promise<MessageResult>` drains the stream into `{data, message, events, inputRequests, sessionId, status}` — `runner/node_modules/eve/dist/src/client/types.d.ts`, same pattern `runner/server/eve-gateway.ts`'s existing `checkModel()` already uses (read-only reference; that file is out of Owns).
7. `step.started` carries `data.modelId` (`StepStartedStreamEvent`); `step.completed` does **not** carry a model id. Plan: capture the model id from `step.started` events (last one wins), not from `step.completed`.

*Design for each Owns file (ready to implement as-is next session):*
- **`store/runs.ts`**: `runs/<date>/<runId>.json`; `<date>` from a `localDateString(date: Date)` helper **local to this file** (not added to `lib/clock.ts`, which is outside Owns) using `Date#getFullYear/getMonth/getDate` — the runner process's own OS-local timezone, to be stated in the README per the packet's instruction. Deterministic pretty JSON: keep using `Workspace.writeJson` (already atomic via `store/atomic.ts`), but don't rely on zod `.parse()`'s output key order — build an explicit `orderedRecord()` helper that lists fields in `runRecordSchema`'s declared order every time; `JSON.stringify` already drops `undefined` optional fields, so the same helper handles ordering and omission together. Three write entry points: `startRun` (crash-safe placeholder: `outcome:"failure"`, `error:"interrupted: the runner stopped before this run finished"`, no `finishedAt`), `finishRun` (overwrites with the real outcome/tokens/model/durationMs/finishedAt), `writePausedRun` (one-shot record for a refused run, `startedAt === finishedAt`, `durationMs: 0`, no placeholder-then-overwrite since the body never ran). `listRuns(workspace, clock, {limit=200, sinceDays=14})`: scan `runs/<date>/` dirs in the window (string-compare `YYYY-MM-DD` names), validate every file, skip+count invalid ones (`invalidCount`), sort by `startedAt` descending (safe because every writer here uses `Date#toISOString()` — fixed-width UTC, so lexical sort is chronological), slice to `limit`. `getRun(workspace, runId)`: `z.uuid().safeParse` first, return `undefined` with **no filesystem touch** on a bad id; on a valid uuid, scan date dirs for `<runId>.json` (runId carries no date — unavoidable scan, fine at local/bounded scale). `countCountableRuns(workspace, date)`: reads only `runs/<date>/*.json`, counts valid, non-`"paused"` records — this is what `budget.ts` calls for `runsUsedToday`, and it's also *why* the daily counter needs no explicit "reset" logic: a new local day is a new, empty directory. `hasSucceededWithIdempotencyKey(workspace, clock, key)`: built on `listRuns`'s bounded window — the P05/P08-B idempotency lookup the packet asks for.
- **`store/budget.ts`**: persisted at `runs/budget.json` (top-level workspace dir, not `.runner/` — mvp-spec §5 / ARCHITECTURE §4, confirmed by this branch's own base commit `f9e421f`): `{dailyRunLimit, itemCap, paused, pausedReason?, pausedSince?}`; bounds `dailyRunLimit` 1–50 (default 10), `itemCap` 1–20 (default 5). `runsUsedToday` is **never persisted**, always derived via `runs.ts`'s `countCountableRuns` so it can't drift from the log. Missing file → in-memory defaults (first run before setup). **Assumption to confirm:** a present-but-corrupt file throws (fail-closed) rather than silently defaulting to unpaused — only a genuinely missing file gets defaults. `getBudgetStatus(workspace, clock): Promise<BudgetStatus>` is the only function whose output must validate against the wire `budgetStatusSchema` (`dailyRunLimit, runsUsedToday, paused, pausedReason?` — note the wire contract has no `itemCap`/`pausedSince`; those stay internal, exposed only via the uncontracted `GET /api/runs/budget` shape for Settings). `pauseBudget(workspace, clock, reason)`, `resumeBudget(workspace)` (clears pause fields, keeps limits), `setLimits(workspace, {dailyRunLimit, itemCap})` (re-validates bounds through the same zod schema).
- **`server/run-harness.ts`**: `withRun(ctx, {kind, inputs?, idempotencyKey, isCatchUp, items?}, body)` where `body: (ctx, items) => Promise<{turns: TurnResult[]}>`. Reads budget state once; if paused or `runsUsedToday >= dailyRunLimit`, writes a one-shot paused record and returns **without** calling `startRun`/`body` (`ranBody:false`). Otherwise slices `items` to `itemCap`, folds `{itemCap, processedItemIds, remainingItemIds}` into the persisted `inputs` (so the Runs page renders "stopped at the per-run cap (N); M jobs stay Saved" straight from the record), calls `startRun`, then `body(ctx, processedItemIds)` in `try/catch`, and **always** calls `finishRun` in `finally` (captured via an outer `let finalRecord!` so the function can return it after `finally` runs). A thrown body error is caught → `outcome:"failure"` + truncated message, **not rethrown** (assumption: `withRun` always resolves, callers read `record.outcome`). `runTurn(ctx, {message, timeoutMs=90_000})`: one `client.sessions.create({message, signal: AbortSignal.timeout(timeoutMs)})`, no internal retry (so a test's fake-client call count proves "no retry loop from us"); sums `step.completed` usage; takes model id from the last `step.started`; classifies via `isTurnFailureEvent` → `"failed"`, `inputRequests.length>0` → `"parked"` + `response.cancel()`, `signal.aborted` on rejection → `"timeout"` + `response.cancel()` when a `response` handle exists (a create-time abort before any `sessionId` comes back has nothing to cancel — same accepted gap as `eve-gateway.ts`'s existing `checkModel`). On `"failed"`, checks `details.semanticErrorId` (fact #4) and if it matches, calls `pauseBudget(ctx.workspace, ctx.clock, "provider limit")` itself and returns `providerLimit:true`; `withRun` then fails the run the same way it fails any other non-`"ok"` turn — no special case needed there.
- **`server/routes/runs.ts`**: `api`: `GET /` (list, newest-first, bounded, `invalidCount`, each record's `runs/<date>/<runId>.json` path), `GET /:runId` (full record + path, uuid-validated before any fs touch), `GET /budget` (full internal state + derived `runsUsedToday`), `POST /budget` (strict/bounded body, ~1024-byte cap, 400 out-of-range, 413 oversized), `POST /budget/resume`. `status(ctx)`: `{budget: await getBudgetStatus(ctx.workspace, ctx.clock)}` — `extension-api.ts`'s existing `/status` handler (P02, already complete) picks this up automatically. Must add `"runs"` to the pinned list in `runner/test/route-modules.test.ts` (→ `["devices","model","pairing","runs","status"]`, alphabetical) unless P03's readdir-based replacement has landed first, in which case take P03's version via a normal merge.
- **UI** (`ui/runs.html`, `ui/assets/runs.js`, the Budget `<section>` in `ui/settings.html` + `ui/assets/settings-budget.js`): mirror `ui/status.html` + `assets/status.js` + `assets/runner.css` exactly (plain HTML, `<!-- runner:nav -->`, `getJson`/`postJson`/`el` from `runner.js`, existing theme tokens). **Deliberate deviation from `status.js`:** use `aria-disabled="true"` (element stays focusable) instead of the native `disabled` property while busy — this packet's own UI-critic rules require it ("focus is never lost after an action"; native `disabled` on a focused button drops focus to `<body>`); `status.js` predates that rule and isn't a pattern to copy for these two pages. Live region: reuse the extension's existing pattern, one persistent `role="status" aria-live="polite"` element per page (seen in `extension/src/popup/render.ts` and `extension/src/options/main.ts`).

**Assumptions a reviewer should confirm** (numbered above inline, collected here): (1) provider-limit fallback regex beyond the documented semantic-error ids; (2) corrupt (not missing) `budget.json` throws rather than defaulting; (3) `withRun` swallows a thrown body error into a `"failure"` record instead of rethrowing; (4) `localDateString` lives in `store/runs.ts`, OS-local timezone, not UTC; (5) `GET /api/runs` and `GET /api/runs/:runId` both return the full record plus a computed `path` rather than a slimmer summary shape (records are small; a separate projection seemed like needless duplication).

**One thing to sharpen next time:** front-load the eve semantic-error-catalog dig (`harness/semantic-errors/rules/*.js`) before reading anything else next session — it's the one fact everything else in the harness depends on (how a 429 actually surfaces as `details.semanticErrorId`), and it took the longest to find because the public `.d.ts` files stop at `{code, message, details?}`; the real answer is only in the compiled `.js` internals, several hops past the public `eve/client` entrypoint.

**Head SHA at pause:** to be confirmed in this same commit (see PR/commit message); no other commits exist on this branch beyond it.
