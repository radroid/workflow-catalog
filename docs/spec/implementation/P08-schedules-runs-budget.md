# P08 · Schedules, run log, and budget pause

Status: open
Assignee: none
Blocked by: P05
Owns: runner/agent/schedules/, runner/store/runs.ts, runner/scheduler/ (catch-up + fallback trigger), runner/ui/runs.html, runner/ui/settings.html (schedules and budget sections)
Spec: F10, F11, §8 schedules and run modes, hard-problems #4 and #7

## Goal
Daily preparation of newly saved jobs and a weekly review that survive laptops sleeping and never draft twice or burn quota silently.

## Deliverables
- `agent/schedules/daily-prepare.md` (cron, markdown prompt: prepare Saved jobs, cap N per run) and `agent/schedules/weekly-review.md`; per-schedule timezone, pause, run history in Settings.
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
