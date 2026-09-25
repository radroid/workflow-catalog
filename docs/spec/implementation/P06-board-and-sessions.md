# P06 · Application board and application sessions

Status: claimed
Assignee: manual session (Opus)
Blocked by: P05
Owns: runner/store/sessions.ts, runner/server/routes/{applications,sessions,commands}.ts, runner/ui/board.html, runner/ui/sessions.html, runner/agent/tools/open_application_group.ts
Spec: F8, F9, §5 session manifest and bridge envelopes, browser-boundary.md (protocol contract)

## Goal
The board tracks intent; a session turns Ready applications into a manifest the extension can open; status moves only by explicit action.

## Deliverables
- Board with stages Saved → Preparing → Ready → Applied → Interviewing → Offer / Rejected / Withdrawn; processing state (last run outcome) shown separately and never moving the stage.
- Session creation: select Ready applications → `sessions/<id>.json` manifest → an `open_application_group` command queued for the paired device with expiry, workflow version, max group size, https-only URLs bound to stored job URLs.
- `GET /commands` device lease and per-item acknowledgement; `browser_command_result` and `application_status_changed` handling with expected-revision checks; stale revisions rejected; unknown or partial results flagged for review on the Sessions page.
- "Changes not yet synced" indicator and manual reconciliation view for the file-bridge fallback (`outbox/`, `inbox/`).

## Acceptance
- Replaying any command or event produces no duplicate side effect (idempotency tests).
- A `closed` tab result changes nothing; only `application_status_changed` with the user's explicit status moves the stage.
- Importing an older manifest never resets a newer status (property test over random event orders).
- Expired commands are refused; a command for another device's task is refused.
- Board renders the fixture set; a failed preparation shows in processing state while the stage stays Saved.

## Out of scope
The extension (P07), schedules (P08).

## Moved to P06.1 (iter 007)
P04's round-3 Jobs-page items and server nits, the Jobs page's pinned line and runner-down notice, the shared `.secondary` border and `.error` colour in `runner.css`, and the Status page's model check, eve line and screenshot retake now live in `P06.1-jobs-and-status-followups.md`. P06 edits none of those files.

## Carried in from P05's reviews (iter 007)
Findings are in `logs/handoff/P05-round-1-review.md` and `P05-round-2-review.md`. On top of P06's Owns, these are granted:
- `packages/contracts/src/application.ts`: the one value below, with its tests;
- `runner/server/routes/applications.ts` and `runner/ui/assets/application.js`: P05 created them, and P06 extends them;
- `runner/export/file-names.ts`: the download names only;
- `runner/server/local-ui.ts`: `NAV_PAGES` only.

The items:
- **A waiting state.** A preparation parked on gap questions is recorded as `processing: failed`, the only fit in today's contract. Add a waiting value to `application.ts`'s `processing`, use it for a parked preparation, and have the board show "Needs your answer" rather than a failure.
- **The nav order.** Applications joins the nav through its meta tag, after Status. Place it between Jobs and Board in `NAV_PAGES`.
- **Versions that share a profile version look identical.** Excluding a claim keeps P03's approval version, so versions 1 and 2 both say "career profile version 1". Name what separates them.
- **The Applications page** (P05's round-2 critic):
  - The page's requests have no timeout, so a runner that hangs rather than stops is never noticed. Reuse the Jobs page's timeout, and show the runner-down notice.
  - With focus on the runner line's Settings link, the runner going down replaces that line and drops focus to the body. Keep focus on a stable node.
  - Titles over 60 characters or 6 words are left out of download names, so two such jobs at one company collide. Cut at a word instead, and tell collisions apart.
- **From P05's round-3 critic** (`logs/handoff/P05-round-3-review.md`):
  - The combined outcome line cuts job names mid-word, even at 1280, and its counted form names none, not even the failure. Cut at a word, and name at least the failure.
  - A repeated identical refusal first announces the tag alone ("Refused"). Announce the whole line each time.
  - The same short-name loop as P06.1's round-1 issue 3 (`logs/handoff/P06.1-round-1-review.md`). `settledMessage` names no application when every name is under 16 characters. Name each one.

## Alongside P08-B and P03.1 (iter 008)
- **The budget pause on the board.** P08's deliverable shows a paused budget and its reason ("provider limit") on the board and in Settings. Settings already shows it (P08-A). The board is P06's: read the budget from `GET /status` or `GET /api/runs/budget`, and never edit `runs.ts`, `budget.ts` or `settings.html`.
- **P08-B imports** `startPreparation` and `waitForPreparationQueue` from `routes/applications.ts` to run daily preparations. Keep both signatures stable. If one must change, tell the orchestrator first.
- **P02's seams.** `GET /commands`, the lease, and `acknowledge()` live in `runner/server/extension-api.ts` and `runner/store/commands.ts`. Event types reach a route module through its `events` handlers (`server/route-modules.ts`). Use them as they are. If one must change, stop and ask.
- **Styles.** `runner.css` belongs to P06.1. The board's and sessions' styles go in their own CSS files.

## Report

### 2026-09-25 · manual session (Opus)

**What shipped.**
- **The board** (`ui/board.html`, `assets/board.{js,css}`; `GET /api/applications/board`, `POST /api/applications/:taskId/stage`).
  - Eight stage columns. Each card shows the last preparation's outcome on a line of its own, apart from the stage: "Preparing now…", a failure in the refused style, or the amber "Needs your answer" badge for a preparation parked on questions. That badge is the page's only amber.
  - Moving a card names the revision the board showed. A stale one is refused (409 `stale_revision`), and the card is then shown where it is now.
  - The budget line reads P08-A's `GET /api/runs/budget`. A pause shows its reason, with Settings to resume and Runs to see why.
  - Ready cards can be chosen and started as a session. A card already waiting to open says so, and can't be chosen again.
- **Sessions** (`store/sessions.ts`, `routes/sessions.ts`, `routes/commands.ts`, `ui/sessions.html`, `assets/sessions.{js,css}`).
  - Starting a session writes `sessions/<id>/state.json`, then the manifest `sessions/<id>.json`, then the `open_application_group` command. The command goes to the most recently paired device, with a 24 h expiry, `job-assistant@<major>` and at most `MAX_APPLICATION_GROUP_SIZE` items. With no paired browser, the manifest goes to `outbox/application-session.json` instead.
  - Each URL is the stored capture URL (`JobSnapshot.url`) of the revision the newest documents were made from. It must be https to a public host. It is never `structured.applyUrl`, or anything else a posting says.
  - `browser_command_result` records each tab and acknowledges the command. It never moves a stage.
    - It flags for review: a closed tab with no choice; a failed, skipped, missing or unknown tab; two answers for one tab; and a partial or failed command.
    - It refuses an unknown command (404), another device's command (403), and a first report on an expired command (410).
  - `application_status_changed` is the one event that moves a stage.
    - Applied, at the application's current revision, moves Saved, Preparing or Ready to Applied. Defer records the choice and moves nothing.
    - A stale revision is refused (409), never merged. A stage past Applied is never reset (409 `stage_moved_on`). Another device's task is refused (403).
    - The intent is recorded before the application is written, so a retry after a crash finishes it once.
  - Both handlers are idempotent on their own, by eventId in the session record, on top of `events.ts`'s journal.
  - The Sessions page shows each session's items, its delivery state, and each tab's report and choice. Flagged results each have "Mark as reviewed".
  - It also shows the file bridge: the outbox; each `inbox/` file, with what importing it would do and an Import button; and "Changes not yet synced". Importing dedupes by eventId and remembers refusals. A manifest in `inbox/` has nothing to import.
- **The tool** (`agent/tools/open_application_group.ts`). A plain `defineTool`, with no directives (eve item 14) and `approval: always()`. Its input is task IDs only. It opens the workspace from `RUNNER_WORKSPACE` and calls the same `SessionsStore.create` as the board.
- **The waiting state** (`packages/contracts/src/application.ts`). `processing.status` gains `waiting`, which P05's route now writes for a parked preparation. `pnpm --filter contracts build` regenerated `packages/job-assistant/schemas/application.schema.json`.
- **Fixes found while testing.**
  - A refused stale move now shows the card in its current column. The focused card had been held in place, so "the board shows it as it is now" was false.
  - The Sessions page says "The tab for “…”", not a possessive after a closing quote.

**Acceptance → tests.**
- **Replaying produces no duplicate side effect.** `runner/test/sessions.test.ts` › "sessions: replaying any command or event has no second effect (acceptance)", all four tests:
  - "a replayed status change or result, through the bridge, changes nothing a second time";
  - "each handler is idempotent on its own: a dispatch run twice (a retry after a failure) records one result and one flag";
  - "a status change the runner stopped halfway through (recorded, not yet written) finishes once when retried";
  - "an event imported from inbox/ that the bridge already delivered changes nothing, and a second import changes nothing either".
- **A closed tab changes nothing; only the explicit status moves the stage.** `sessions.test.ts` › "sessions: a closed tab changes nothing; only the person's explicit status moves the stage (acceptance)":
  - "records the browser's tabs, flags a closed one for review, and leaves the application byte-identical";
  - "moves Ready to Applied only on application_status_changed with applied at the current revision; deferred moves nothing";
  - "refuses a stale revision, never merging it";
  - "never resets a stage the person moved past Applied".
  - Also `sessions-page.test.ts` › "the Sessions page: a session and a flagged result" › "shows each tab's report and the person's choice; a closed tab is flagged for review and moved nothing; Mark as reviewed clears it".
- **An older manifest never resets a newer status.** `runner/test/sessions-property.test.ts` › "sessions: importing an older manifest never resets a newer status (property over random event orders)" › "holds for 48 seeded random orders of 14 steps". The generator is mulberry32 inside the test, no dependency. Each failure names its seed and step.
- **Expired commands, and another device's task, are refused.** `sessions.test.ts` › "sessions: expired commands and other devices' tasks are refused (acceptance)":
  - "never delivers an expired command, and refuses a first report on one";
  - "delivers a command only to its own device, and refuses another device's report on it or status for its task";
  - "accepts a later report (a tab closed) on a command reported before it expired".
- **The board renders the fixture set, with a failed preparation in its processing line and the stage still Saved.** `runner/test/board-page.test.ts` › "the board renders the fixture set (acceptance)":
  - "each application in its stage's column; a failed preparation shows in its processing line while the stage stays Saved; one waiting on answers says so in amber; no id in visible text". The preparations are real, through the scripted model: Harbor's turn fails, and Quill's parks.
  - "an empty board lists every stage with nothing in it, and says where a session goes with no browser paired".
- **Also tested.**
  - `sessions.test.ts` › "sessions: starting one from Ready applications": the manifest, the command, stored URLs, refusals, the outbox and the URL check.
  - `open-application-group-tool.test.ts`, in both roots: the same approval-gated tool; stored URLs, never the posting's apply address; the outbox; refusals.
  - `board-page.test.ts` › "the board shows the paused budget (P08's deliverable on this page)", "starting a session from the board", and "moving a card on the board" (two tests).
  - `sessions-page.test.ts` › "the Sessions page: the reconciliation view (file bridge)" (two tests).

**Carried items → tests.**
- **A waiting state.**
  - `applications-routes.test.ts` › "gap questions" › "park the preparation until the person answers, then it continues from their answers" (an edited assertion, below).
  - `packages/contracts/src/application.test.ts` › "accepts a waiting processing state (parked on gap questions) beside an unmoved stage" and "rejects a processing status outside idle, running, waiting and failed".
  - The board's fixture-set test above ("Needs your answer", in amber).
- **The nav order.** `local-ui.test.ts` › "local UI: pages" › "places Applications between Jobs and Board in the real pages' navigation (P06)", and the edited nav assertion.
- **Versions that share a profile version.** `application-page.test.ts` › "Applications page: carried into P06" › "two versions from one profile version say what separates them: the later names the earlier and why". Screenshot `P06-applications-versions-*`.
- **A request timeout, with the runner-down notice.** Same describe › "a runner that hangs rather than stops is noticed: a request unanswered past the timeout shows the runner-down notice, once".
  - The Jobs page has no request timeout to reuse, so the critic's premise was wrong. `application.js` has its own: 15 s through an `AbortController`, reading the body included.
- **Focus on the runner line's Settings link.** Same describe › "when the runner line's Settings link holds focus and the line is replaced, focus moves to the section's heading, never to the page".
- **Long titles cut at a word, and collisions told apart.**
  - `export.test.ts` › "download names (revision 1, V14)" › "cut a long title at a word, never mid-word or on a separator, and still carry nothing from one with an instruction anywhere in it (P06)".
  - Same describe › "tell apart two jobs whose downloads would share a name: the later-captured is numbered, and the number survives the length cut (P06)".
  - `applications-routes.test.ts` › "download names for two jobs that share one (P06, carried from P05's review)" › "the job captured second downloads as (2), in the page's names and the served header, and the first keeps its plain name".
- **The combined line cuts at a word, and its counted form names the failure.** `application-page.test.ts` › "Applications page: outcomes that settle in one refresh (revision 2, X6)" › "a version ready and questions to answer share one line that fits, each job named once" and "when the names can't fit one line, it counts the outcomes instead, still once". Both are edited assertions, below. Screenshot `P06-applications-settled-*`.
- **A repeated identical refusal announces the whole line.** "Applications page: carried into P06" › "a refusal repeated word for word is announced again whole: the live region never holds the tag alone". The board and Sessions pages also clear the tag and the text together.
- **settledMessage when every name is under 16 characters.** Same describe › "names each application when every name is shorter than 16 characters (carried from P06.1's review)".
- **Each fix fails its test without it.** I reverted four Applications-page fixes by hand, together: the timeout's `signal`, the focus move, the loop's floor and the tag clearing. Each made its test fail. `git restore`, then `git diff`, showed the file clean.

**Edited existing assertions.** None was weakened.
- `runner/test/application-page.test.ts:1425` (now 1426).
  - Old: `"“Backend Engineer · Qu…” needs your answers; prepared “Platform Lead · Fernw…”."`
  - New: `"“Backend Engineer…” needs your answers; prepared “Platform Lead…”."`
  - Why: the carried item. Names cut at a word, with no "·" left before the "…". The 80-character check beside it is unchanged.
- `runner/test/application-page.test.ts:1445` (now 1447).
  - Old: `["3 applications: 1 couldn't be prepared, 1 needs your answers, 1 is ready."]`
  - New: `["Couldn't prepare “Platform Engineer · Harbor”; 1 needs your answers, 1 is ready."]`
  - Why: the carried item. The counted form names the failure.
- `runner/test/applications-routes.test.ts:706` (now 707).
  - Old: `{ status: "failed", runId, error: "Waiting for your answer to 2 questions." }`
  - New: `{ status: "waiting", runId }`
  - Why: the carried item. A parked preparation is waiting, not failed.
- `runner/test/local-ui.test.ts:142` (now 143).
  - Change: the fixture nav gains `<a href="/ui/application">Applications</a>` after Jobs.
  - Why: the carried item. Applications is now a planned page, between Jobs and Board.

**Mutation proofs.** Each was made by hand, run, then restored, and `git diff` was empty after each.
1. **A closed tab moves the stage.** `#applyCommandResult` set Applied on each `closed` item.
   - "records the browser's tabs, flags a closed one for review, and leaves the application byte-identical" failed, and so did the Sessions page's flagged-result test.
   - The property test failed at seed 2, step 3: "ready became applied without the person's explicit status".
2. **A stale revision is accepted.** The check in `decideStatusChange` was removed.
   - "refuses a stale revision, never merging it" failed (200, not 409), and so did "never resets a stage the person moved past Applied".
   - The property test failed at seed 8, step 0.
3. **An expired command is delivered, or acted on.** Two mutations:
   - (a) The 410 check in `#planCommandResult` was removed. "never delivers an expired command, and refuses a first report on one" failed (200, not 410).
   - (b) The command's `expiresAt` was set past the session's. The same test failed at the lease, because the expired command was delivered. "writes the manifest and queues one command…" failed on the expiry.
   - `store/commands.ts`, which does the leasing, is P02's. I didn't touch it.
4. **The idempotency check is dropped in the result handler.** The eventId check in `#planCommandResult` was removed. "each handler is idempotent on its own…" failed (two results, not one), and so did "an event imported from inbox/ that the bridge already delivered…".
5. **A command URL that isn't the stored job URL.** The URL became `structured.applyUrl ?? snapshot.url`. These failed:
   - "writes the manifest and queues one command…";
   - in both of the tool's roots, "queues one command for the paired browser, with each task's stored job URL and never the posting's own apply address";
   - in both roots, "with no paired browser, writes the session to outbox/ instead".
6. **A parked preparation is recorded as failed.** `finish()` wrote `failed`. "park the preparation until the person answers…" failed, and so did the board's fixture-set test.

**Flakes found and fixed.**
- Under load, the device test failed about one run in two. The test clock stands still, so the two pairings tied on `pairedAt`, and the session went to whichever device file was listed last. The test now advances the clock between the two.
- A slow request shows a busy word ("Saving…") before its outcome. The page tests now skip the busy words.
- With both fixes, three runs of the session and board suites together passed.

**Screenshots.** 20 files, `docs/screenshots/P06-*.png`, each at 390 and 1280, in light and dark, full page:
- `board-empty`.
- `board-fixtures`: a failed preparation under Saved; one waiting with "Needs your answer"; one waiting to open in the browser; a Ready one chosen; one Applied; and the budget paused.
- `sessions`: a reported session with a closed tab flagged; a second session waiting for the browser and written to the outbox; and an unsynced inbox export.
- `applications-versions`: version 2 names version 1 and why.
- `applications-settled`: "Couldn't prepare “Platform Engineer · Harbor”; 1 needs your answers, 1 is ready."

How they were taken:
- **The harness.** A scratch script, `/tmp/wc-p06-screens/harness.ts`, never committed.
  - It ran the real `createBridgeApp` with the P06 modules, on 127.0.0.1:4320 only. I checked the port was free before each start, and stopped the harness after each.
  - Workspaces were fresh, under `/tmp/wc-p06-screens/`. The scripted model stood in for eve.
  - Sign-in went through a real `/ui/login?nonce=` link.
- **Width.** 390 is device-metrics emulation (`390x844x1`).
  - Before each capture, `clientWidth` and `innerWidth` were both 390, or both 1280, and `scrollWidth === clientWidth`.
  - At 390, no element extends past the viewport. The console was clean.
- **Contrast.** I measured every visible text node against its composited background, leaving out disabled controls and closed `<option>`s. The lowest was 7.17:1 in light and 6.76:1 in dark (the "Last action" tag). The amber badge is 9.74:1.
- **Files.** 10 are 1280 wide and 10 are 390. The 20 SHA-256 checksums are unique.

**The chain.** This ran on `0b41d0c`, which is this branch merged with `origin/overnight/integration` at `81e2fda` (P05.1 done). The only commit after it is this report. Results:
- `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm -r lint` and `pnpm check:fixtures` all exited 0.
- `pnpm test` exited 0:
  - contracts: 237 passed;
  - job-assistant: 153 passed;
  - catalog: 168 passed;
  - runner: 1964 passed, then the eval, with 7 of 7 results and 161 gates passed;
  - extension: 329 passed and 5 skipped;
  - `scripts/*.test.mjs`: 2 passed.
- `git status --porcelain` was empty afterwards.

**CI.** PR #21. Run 36169163122 on `b0348e9` (the report commit) passed, including the extension's Playwright e2e. The only commit after it adds this line.

**Open questions.**
- **The revision the extension names.** The manifest and the command carry no application revision.
  - Through the bridge, the extension learns it from the `result` of `browser_command_result` (`items[].revision`) and of `application_status_changed`.
  - A file-bridge session has no way to learn it, so an exported Applied names whatever revision the extension has. It is refused if that revision is stale.
  - A `revision` on each manifest item would close this. That is a contract change, outside P06's grant.
- **The adapter README.** `packages/job-assistant/adapters/eve/README.md` still shows P02's stub body of `open_application_group`. That file isn't in P06's Owns.
- **The disabled-button style.** P06.1 added `.button[aria-disabled="true"]` to `runner.css`. `board.css` and `sessions.css` still carry the same rule. The copies are identical and harmless.
