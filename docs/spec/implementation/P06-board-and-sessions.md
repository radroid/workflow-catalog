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

## Carried in from P04's round-3 reviews (iter 006)
Findings are in `logs/handoff/P04-round-3-review.md`. On top of P06's Owns, these small edits are granted: `runner/ui/assets/jobs.js` and `jobs.css`, `runner/server/routes/captures.ts` and `runner/store/jobs.ts` for the two server items, the secondary-button rule in `runner/ui/assets/runner.css`, and new tests. The UI critic checks them with the board.
- **P1.** If a job's only file becomes unreadable while focus is on its Re-extract button, the old "What the runner found" section stays under the new message, even after focus leaves. Move focus to the heading, then drop the section.
- **P2.** When two extractions the page started finish in the same refresh, the first message is replaced before it's shown. Combine them into one line.
- **P3.** The 80-character name cap cuts mid-word ("Staff Platform Engin…"). Cut at a word.
- **P4.** A job whose latest file is damaged is listed by its URL path, but its detail heading uses the title. The "(latest revision)" toggle label then shows revision 1. Use one name, and label the toggle with the revision actually shown.
- **The reviewer's nits:**
  - A Re-extract whose waiting-state write fails (for example, `extraction-1.json` is a directory) returns a generic 500. Refuse plainly instead.
  - A job directory that can't be read (for example, chmod 000) drops out of the list, and its detail says "No such job". List it as unreadable and name the folder, as T6 does for files.
- **The Jobs page's pinned line** (from P03.2's round-1 critic, iter 007): at 640 px and below, the tag runs into the message for assistive tech ("LAST ACTIONExtracting…"). Use the separator P03.2 settles (Q9 in `logs/handoff/P03.2-round-1-review.md`): the visible tag keeps its words, and a visually hidden ": " separates it. The grant covers `runner/ui/jobs.html`'s `#last-action` markup.
- **The shared secondary button's border** (`#detail-retry` and every `.secondary` button) is 1.27:1, from `runner.css`. Where the border is the button's only visible boundary, it needs 3:1 (WCAG 1.4.11). Use `--muted-foreground`, as G7 does for form controls, and check every runner page.
