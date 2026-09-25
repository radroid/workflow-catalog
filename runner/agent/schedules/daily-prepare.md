<!--
Schedule: daily-prepare
Kind: prepare_newly_saved_jobs
Cadence: daily, 09:00 UTC

This file documents the schedule for a person reading the repo; it is not
sent to a model. `runner/scheduler/dispatch.ts` runs this schedule's actual
work by calling `startPreparation` (P05's own preparation pipeline) once per
eligible Saved job, up to the day's per-run item cap — the same function and
the same model turn a person triggers by pressing Prepare on the board.
There is no second preparation path and no separate prompt: P05's own
`buildPreparationPrompt` already builds each job's turn.
-->

# Prepare newly saved jobs

Once a day, look at every application on the board at the Saved stage and
start a preparation for it, oldest first, stopping at the run budget's
per-run item cap. Anything past the cap stays Saved for the next run.

A job that already has documents matching its current inputs is left alone
(no new run, no new documents). A job whose last preparation parked on
gap questions is left alone too, until the person answers them on the
Applications page — this schedule never retries it and never counts that as
a failure.
