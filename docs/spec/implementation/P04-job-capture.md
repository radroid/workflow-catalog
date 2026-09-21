# P04 · Job capture

Status: open
Assignee: none
Blocked by: P03
Owns: runner/server/routes/captures.ts, runner/store/jobs.ts, runner/agent/tools/import_job_url.ts, runner/ui/jobs.html, packages/job-assistant/fixtures/jobs/
Spec: F6, hard-problems #3

## Goal
A job posting becomes a versioned snapshot from any of three paths, and the snapshot is data.

## Deliverables
- `POST /events` handling of `job_capture` from the extension: bounded text, extractor version, content hash, URL validation (https only, no privileged schemes), dedupe by URL into revisions.
- Paste path in the local UI; URL path via a runner tool that fetches a public page and extracts readable text (size cap, timeout, no redirects to non-https).
- Structured extraction of `{ title, company, location, requirements[], niceToHave[], deadline?, applyUrl }` from the snapshot text into typed fields; the raw text is never placed in a system prompt.
- Jobs page: list, revisions, "posting changed" diff.

## Acceptance
- Three paths produce identical snapshot records for the same fixture text.
- Same URL captured twice with changed text → revision 2; revision 1 retained.
- Hostile posting fixture: extraction returns fields only; no action tool called; profile unchanged (assert store hash before/after).
- Rejected inputs: `javascript:` and `file:` URLs, bodies over the cap, text over 200 KB.

## Out of scope
Preparation, sessions, the extension itself (P07 sends the envelope; this packet accepts it).
