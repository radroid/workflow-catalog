# P05 · Preparation with evidence, the validator, and export

Status: open
Assignee: none
Blocked by: P04
Owns: runner/agent/skills/ (preparation set), runner/agent/tools/prepare_application.ts, runner/validate/, runner/export/, runner/store/applications.ts, runner/ui/application.html, packages/job-assistant/fixtures/preparation/, and `runner/package.json` + `pnpm-lock.yaml` for the DOCX and PDF export dependencies only. Those libraries must be maintained, with no native build step, no install scripts and no network access; pin exact versions, and report the choice and the reason. While P05 runs, no other packet edits these two files (iter 006 decision).
Spec: F7, hard-problems #2 and #3

## Goal
Every sentence in a generated document cites a confirmed claim, and the person sees what changed and why.

## Deliverables
- `prepare_application` as a durable workflow tool: requirements → matching (confirmed claims only; excluded claims are removed from the context, not just discouraged) → gap questions (park, never guess) → resume draft → optional cover letter → revision pass → validator → diff → export (Markdown, DOCX, PDF) → attach to the application with `{ profileVersion, jobRevision, idempotencyKey }`.
- Validator (no model): every bullet or sentence carries `[C#]` citations that resolve to confirmed claim IDs; no excluded ID appears; boundaries hold (dates and titles equal the confirmed claim text; no numbers absent from confirmed claims). Output is stripped of citation markers only at export.
- Diff view: per bullet, the source claim and the presentation change.
- Idempotency: same job revision + profile version → no new document.

## Acceptance
- Excluded-metric fixture: the number never appears in any exported format (grep the DOCX and PDF text).
- Validator unit tests for each rule, including a deliberately bad draft.
- Hostile posting fixture through the full pipeline: profile unchanged; no action tools called; output contains no instruction text from the posting.
- Two consecutive preparations of the same inputs → one document.
- Documents record profile version and job revision; changing the profile and re-preparing yields a new version that names the old one.

## Out of scope
Board UI beyond the application page, sessions, schedules.
