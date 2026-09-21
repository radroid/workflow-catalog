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
