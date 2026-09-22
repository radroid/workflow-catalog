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

## Report

### 2026-09-22 — iter-004 implementer (Sonnet)

**PR:** [#11](https://github.com/radroid/workflow-catalog/pull/11) `packet/P03` → `overnight/integration`, head `34edba5`. CI green.

**What was done.** All five deliverables: source accounting for the seven categories (`store/profile-types.ts`, `store/profile-reducer.ts`'s `accountSource`); durable claim extraction with evidence pointers (`agent/tools/extract_claims.ts`, a `defineWorkflowTool`); follow-up questions with durable HITL parking (`agent/tools/ask_follow_up.ts`, uses `ctx.ask`; the mechanical "always ask" rule lives in `store/profile-questions.ts`, kept in sync by hand with `follow-up-questions/SKILL.md`); readiness/approval with revisions (`store/profile-reducer.ts`'s `readiness`/`approve`/`editClaimText`/`acceptRevision`/`rejectRevision`); `career-profile.md` rendering and round-trip editing (`store/profile-markdown.ts`, wrapped with persistence and approval-aware revision semantics by `store/profile.ts`); and the two local UI pages (`ui/onboarding.html`, `ui/profile.html`, plus their `assets/*.{css,js}`). Also fixed `follow-up-questions/SKILL.md`'s summary lines to name "role, or scope" alongside "metric, superlative, title, date", matching its own Boundaries bullet.

**Tests run, real output.**
- `npx vitest run` in `runner/`: 17 files, 170 tests, all passed (includes the 6 walkthrough-scenario reducer tests, the markdown round-trip property tests, and 4 new `profile-store.test.ts` cases for the bug below).
- `eve eval` in `runner/` (`node --import ./lib/register-ts.mjs cli/eval.ts`): 5 evals, 41 gates, all passed — `approval 4/4`, `tool-surface 4/4` (exact list, including `extract_claims`/`ask_follow_up`), `skills 4/4`, `missing-tools 8/8`, `onboarding-extraction 21/21` (the fictional-resume extraction scenario, the metric left `candidate` with a question, and the hostile-fixture scenario asserting only `extract_claims` was called).
- Root verification chain: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm -r lint && pnpm check:fixtures` — all green. `pnpm typecheck`: 6/6 packages clean. `pnpm test`: contracts 235, job-assistant 151, extension 130 passed + 2 skipped, catalog 139, runner 170 + eve's 41 gates, root `scripts/*.test.mjs` 2 — all passed. `pnpm -r lint`: 6/6 clean. `pnpm check:fixtures`: 0 offenses, exit 0. `git status --porcelain` clean after.
- `npx vitest run` in `packages/job-assistant/` (after the SKILL.md wording fix): 6 files, 151 tests, all passed.

**A real bug found and fixed (not caught by any unit test).** Exercising the Profile page in a real browser (Approve → edit a confirmed claim's text → Save) showed no "Pending revisions" section and the approved text silently changed — `ProfileStore.applyMarkdownEdit` called the pure `applyMarkdownEdits()` helper directly, which has no notion of approval. Fixed in `cd56b8b` by routing a confirmed claim's edit through the reducer's `editClaimText` action instead (proposes a revision when approved, edits directly otherwise); boundaries/preferences/presentation and non-confirmed claims' text still apply directly, unchanged. `test/profile-markdown.test.ts` drives the pure functions directly and structurally cannot catch this class of bug — added `test/profile-store.test.ts` (4 cases) at the store layer. Re-verified after the fix with a second real click-through: the diff now appears correctly under "Pending revisions", `docs/screenshots/P03-profile-{light,dark}.png` show that state.

**New `runner/agent/lib/` files** (approved mid-run as an allowlist extension; that folder is otherwise P02's; no P02 file was edited): `onboarding-store.ts`, `extract-claims-schema.ts`, `ask-follow-up-schema.ts`.

**What was skipped/deferred, and why.**
- **The bridge route never drives `ask_follow_up`.** `/api/onboarding/claims/:id/answer` resolves a pending question deterministically via the reducer's `answerQuestion` action, matching the walkthrough (which never calls a model for this step either). `ask_follow_up` stays a real, eval-tested workflow tool for a genuine agent-driven session (`eve invoke`, or a future chat surface) where a *model* asks the question mid-turn via `ctx.ask`'s durable HITL parking — a different interaction shape than a REST endpoint. Wiring the route to invoke eve for something the reducer already resolves deterministically would add a model dependency for no behavioural gain.
- **`packages/job-assistant/fixtures/onboarding/` was never created**, despite being named in this packet's `Owns:` line. The extraction eval's fixture data lives instead in `runner/eval-agent/agent/lib/fixtures/onboarding.ts`, duplicated by value from P01's existing `packages/job-assistant/fixtures/resume.md`/`expected-claims.json` rather than a new file read at runtime — that module is part of the eval agent's *built* runtime (the scripted model `eve` calls mid-turn), and a cross-package file read from bundled agent code is not guaranteed to survive `eve build`. The `.eval.ts` file itself does read `resume.md` from disk (test/orchestration code, not bundled) to seed the temp workspace and cross-check the embedded constants stay real substrings. The hostile fixture (`HOSTILE_RESUME_TEXT`, "Sam Fernwood" / "Quill", both on the fixtures-policy allowed list) is new but lives in that same module rather than a standalone file, for the same reason.
- PDF/DOCX source upload extraction: out of scope, per `store/profile.ts`'s `sourceText()` doc comment — sources are read as plain text (fictional `.md`/`.txt` fixtures), matching `fixtures-policy.md`.
- Screenshots (both pages, light/dark, plus 390px for Onboarding) are not one of this packet's acceptance criteria — that is a separate "UI critic" pass in the wave plan (`OVERNIGHT-OPUS-PROMPT.md` iteration 4) — but were taken and visually verified anyway as evidence, via a throwaway local harness (`createBridgeApp`/`createRunnerContext` directly, an explicit `os.tmpdir()` workspace, `eve`/`model` left `undefined`, sign-in through the app's own `/ui/login?nonce=` flow — never `cli/{setup,doctor,runner}.ts`, so the real `$HOME`, OS keychain, and any live model were never touched; confirmed no `~/JobAssistant` exists under the real `$HOME` afterward). The harness script was scratch and was deleted, not committed. No separate 390px shot for Profile — the Onboarding one already demonstrates the responsive layout and the packet does not require per-page mobile coverage.

**Assumptions.** "Not applicable" and "unavailable" both count as a source being accounted for, with the reason kept as an optional note (matches the walkthrough). A claim's `question` is drafted mechanically (`profile-questions.ts`'s `draftQuestion`) when a decide/extract action needs one and none was supplied — a model may supply a better-drafted question via `ask_follow_up`'s own input instead; the mechanical version is the floor, not the ceiling (documented in `profile-questions.ts`). Approval is withdrawn automatically when a claim is newly confirmed on an approved profile (existing `decideClaim` behaviour — excluding or disputing a claim does not withdraw approval, only confirming does), but *not* when a brand-new candidate is extracted from a re-provided source post-approval — that claim just sits alongside the approved profile until decided; `test/profile-store.test.ts`'s third case exercises this directly.

**One thing to sharpen next time.** `defineWorkflowTool`'s executor must be a literal, inline function in the same file eve's bundler scans (an imported identifier is not recognized — confirmed against eve's own compiled `authored-workflow-directives.js`), and a `"use step"` function reached only via a cross-eve-app-root import (`runner/agent/` vs `runner/eval-agent/`) builds cleanly but fails at *runtime* with "Step function not registered" (each app root has its own step registry). Both cost real time to isolate here and will hit every future packet that adds a `defineWorkflowTool` with any shared step logic (P04's `open_application_group` is already referenced by this packet's hostile fixture). Worth a short addendum to `docs/spec/research/eve-runtime.md` — the workaround (inline the executor and every step it uses in each tool file; keep only directive-free code like schemas and plain helpers in a shared module) so the next packet doesn't have to rediscover it from a `[MISSING_EXPORT]`/`Step function not registered` error.
