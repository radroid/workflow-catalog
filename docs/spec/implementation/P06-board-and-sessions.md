# P06 · Application board and application sessions

Status: open
Assignee: none
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
