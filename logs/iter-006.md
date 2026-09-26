# iter 006 — P04 and P02.2 merged

Dates: 2026-09-23 18:56 to 2026-09-24 08:05 · Phase 2 · The wave plan's iteration 6 (P06 ∥ P08-B) waits on P05, which waited on P04.

## What ran
- **P04, job capture** (PR #14): merged 08262a1.
  - Round 1: REVISE 9, UI REVISE 9. The URL fetch failed on Node 24, IPv6 got past the SSRF checks, and hostile HTML was quadratic. The event was held open for the whole model turn, but the extension times out at 5 s.
  - Revision 1, by the Sonnet implementer, followed L1–L14. The main change: extraction runs after the capture responds.
  - Round 2: REVISE 6, UI REVISE 9. Fields were saved during the turn, stale states never cleared, and the budget was checked only at queue time.
  - Revision 2, by a fresh Opus escalation, followed T1–T21. Round 3: both APPROVE. M7 was proven with a `node:dns` stub.
- **P02.2, runner workspace precedence** (PR #15, new): merged 2b93cf0.
  - Round 1: REVISE 3. Setup adopted the ambient workspace, doctor compared strings, and forget offered the environment's workspace.
  - Revision 1 followed W1–W8, plus an orchestrator addendum: an entry guard in `cli/runner.ts` would have skipped the runner on symlinked paths. Round 2: APPROVE.
- Each round's full findings are in `logs/handoff/P04-round-{1,2,3}-review.md` and `logs/handoff/P02.2-round-1-review.md`.

## Orchestrator decisions (blocks.md)
- **P05's skills live in the workflow package** (`packages/job-assistant/skills/`). Its Owns list was corrected, and its prompt is ready.
- **Eval workspaces.** eve copies the environment into its dev-host Worker once, after importing every eval file. So one shared module owns `RUNNER_WORKSPACE` at import time. The first rule for this was wrong, and it was amended after P04's round 1.
- **New P02.2.** GitHub Actions sets `RUNNER_WORKSPACE`, so `.env.local` now wins for the workspace. Forget removes only what `.env.local` records (the orchestrator's ruling). Renaming the `RUNNER_` prefix is an owner question in PR #2.
- **Lesson:** never make a CLI entry file importable by adding an argv guard. Put the testable logic in `lib/`.
- **Follow-ups carried:**
  - P04's UI polish, two nits and the shared button border go to P06.
  - P02.2's nits go to P10 part B.
  - The e2e reaching real handlers goes to P07-C.
  - Extraction turns and the budget go to P08-B.
- **P03.2 deliverable 5:** `extract_claims` saves only after an ok turn, P04's T1 rule.

## Incidents
- The orchestrator's L12 wording, "set up a model in Settings", was wrong; T12 fixed it.
- One orchestrator write mixed a shell command into a file's contents. It was caught and fixed before commit.
- The Mac slept during an implementer's test run. The serial rerun was green, and the reviewer saw no flakes.

## Smoke test (integrated branch 08262a1)
All exit 0:
- `pnpm install --frozen-lockfile` and `pnpm typecheck`.
- `pnpm test`: contracts 235, job-assistant 153, runner 852 plus eval 6/6 (105 gates), catalog 168, extension 329 (+5 that need a build), scripts 2.
- `pnpm -r lint` and `pnpm check:fixtures`.
- CI on 08262a1, which includes the extension e2e, is checked at the next wake-up.

## PRs and blocks
- #14 and #15 merged; #2 updated.
- Owner-gated: the catalog deploy, the first release tag, the tag-push deny rule, and the `RUNNER_` prefix question.
- Nothing blocks iter 007.

Next: P05 (Opus) ∥ P03.2 (Sonnet), from `logs/handoff/P05-prompt.md` and `P03.2-prompt.md`. Then P03.1 and P08-B, then P06.
