# P01 · Workflow package and shared contracts

Status: open
Assignee: none
Blocked by: P00
Owns: packages/job-assistant/, packages/contracts/
Spec: §5 data contracts, F12 (manifest only), execution-options.md package layout

## Goal
The portable, versioned workflow package and the zod contracts every other part imports. Provider-neutral; the eve adapter is a stub here (P02 fills it).

## Deliverables
- `packages/contracts/src/`: zod schemas + inferred types for Claim, CareerProfile, Source, JobSnapshot, Application, SessionManifest, RunRecord, and the four bridge envelopes (`open_application_group`, `browser_command_result`, `job_capture`, `application_status_changed`, `protocol: 1`). `pnpm --filter contracts build` also emits JSON Schema to `packages/job-assistant/schemas/`.
- `packages/job-assistant/workflow.json`: name, version `0.1.0`, description, required sources (seven categories), connections, browser permissions (the six), actions allowlist (`capture_job`, `open_application_group`, `report_status`), schemas list, adapters list (`eve`), changelog entry.
- `packages/job-assistant/skills/`: `SKILL.md` files (Agent Skills frontmatter: `name`, `description`) for `onboarding-accounting`, `claim-extraction`, `follow-up-questions`, `requirements-extraction`, `claim-matching`, `resume-drafting`, `cover-letter-drafting`, `revision-diff`. Each states inputs, outputs (by schema name), boundaries, and what it must never do. Prompts only; no code.
- `packages/job-assistant/templates/`: `career-profile.md.hbs`, `resume.md.hbs`, `cover-letter.md.hbs`.
- `packages/job-assistant/fixtures/`: fictional resume, cover letter, portfolio text, repo summary, LinkedIn-style export, three job postings (one hostile: contains "ignore previous instructions" and a fake action request), expected claims for the resume, expected excluded metric.
- `packages/job-assistant/adapters/eve/README.md`: how P02 will mount this as an eve extension.

## Acceptance
- Contract tests: every fixture validates against its schema; a hostile posting validates as a JobSnapshot (it is data) and contains no field that could be mistaken for an action.
- `workflow.json` validates against `schemas/workflow.schema.json`; version is semver.
- Every `SKILL.md` has frontmatter `description` (eve requires it) and a "Never" section.

## Out of scope
Any model call. Any runner code.
