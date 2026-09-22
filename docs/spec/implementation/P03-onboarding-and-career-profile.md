# P03 · Onboarding and the career profile

Status: claimed
Assignee: iter-004 implementer (Sonnet)
Blocked by: P02
Owns: runner/agent/skills/ (onboarding set), runner/agent/tools/ (extract_claims, ask_follow_up), runner/store/profile.ts, runner/server/routes/onboarding.ts, runner/ui/onboarding.html, runner/ui/profile.html, packages/job-assistant/fixtures/onboarding/
Spec: F4, F5, hard-problems #1 and #2, visuals/index.html (the walkthrough is the behaviour spec)

## Goal
A friend accounts for seven sources, reviews every claim, and approves a profile they own, exactly as the walkthrough shows. Generation stays locked until ready.

## Deliverables
- Source accounting: each category provided (upload / paste / URL / GitHub token) or marked unavailable / not applicable, with the reason kept.
- Extraction (`defineWorkflowTool`, durable): per provided source, candidate claims with evidence pointers (`{kind: passage, ref, quote}`), typed `fact | metric | title | date | credential`; idempotent per source content hash.
- Questions: metrics, superlatives, titles, and dates always ask; answers recorded as `{kind: statement}` evidence, never as external fact. Unanswered questions park the session durably (eve HITL) and never guess.
- Readiness rule and approval; revisions after approval; approval withdrawn when a claim changes.
- `career-profile.md` rendering from JSON and round-trip of edits back into JSON (markdown section markers).
- Local UI pages (plain HTML + fetch, theme tokens): Onboarding, Profile.

## Acceptance
- The six walkthrough scenarios in `docs/spec/visuals/index.html` reproduced as fixture tests against the store and the reducer-equivalent in the runner (no model needed).
- Extraction eval (`eve eval`) on the fictional resume fixture yields the expected claims including the metric marked `candidate` with a question.
- Generation endpoint refused with the exact readiness reason in each unready state.
- Round-trip property test: render → edit one claim text → parse → render equals expected.
- Hostile source fixture (a "resume" containing instructions) produces claims only; no tool other than `extract_claims` is called (assert with `t.calledTool`).

## Out of scope
Job capture, preparation, board.
