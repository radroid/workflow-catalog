# P04 · Job capture

Status: open
Assignee: none
Blocked by: P03
Owns: runner/server/routes/captures.ts, runner/store/jobs.ts, runner/lib/safe-fetch.ts, runner/lib/readable-text.ts, runner/agent/tools/ (the job-extraction tool only), the eval-agent re-export, fixture and tool-registry entries and eval for it, runner/ui/jobs.html and its script, runner/test/ (new tests for these files), packages/job-assistant/fixtures/jobs/
Spec: F6, hard-problems #3

## Goal
A job posting becomes a versioned snapshot from any of three paths, and the snapshot is data.

## Deliverables
- `POST /events` handling of `job_capture` from the extension: bounded text, extractor version, content hash, URL validation (https only, no privileged schemes), dedupe by URL into revisions.
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
  - `javascript:`, `file:` and `http:` URLs;
  - loopback, RFC 1918, link-local and `169.254.169.254` targets, including after a redirect or a DNS answer;
  - bodies over the cap, and text over 200 KB.
- `job_capture` gets its handler here: today the bridge journals it as `no_handler`. The route module declares the event, and `route-modules.test.ts` needs no edit after P03's revision (D2).

## Out of scope
Preparation, sessions, the extension itself (P07 sends the envelope; this packet accepts it).
