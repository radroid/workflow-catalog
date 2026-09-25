Latest: iter-007 in progress since 2026-09-24 about 08:10.
- **P03.2** (#17): merged 47cca70 about 15:08, after three rounds (the last by an Opus escalation). The smoke test on the integrated branch is green (runner 891, evals 107 gates).
- **P05** (#16): round 2 REVISE 5 + UI REVISE 2 (X1–X10). The first escalation pushed X5 and X7 (ce49ca9), then the orchestrator's session died. A fresh Opus escalation resumed at about 00:10 on 09-25 and finished revision 2 at 1a0f854 (CI 36083736390 green; two edited assertions, both justified). Its worktree keeps `packet/P05` for any later REVISE. Last closed: iter-006.
- **Rounds 3 and 4:** round 3 gave Y1–Y8, and the same escalation did revision 3 (00ff33e). Round 4 gave REVISE 2 + UI REVISE 1, which became Z1–Z4 (`logs/handoff/P05-round-4-review.md`). Revision 4 at 451398e (CI green): round 5 gave UI APPROVE + REVISE 3, three narrow regressions. Revision 5 (Z5–Z8 in `logs/handoff/P05-round-5-review.md`) must rerun every reviewer corpus and list each changed verdict. Round 6 is the reviewer only; findings go to P05.1.
- **P06.1** (#18): round 1 gave REVISE 5 + UI REVISE 7, which became K1–K12 (`logs/handoff/P06.1-round-1-review.md`). Revision 1 is part-pushed at 1fa22fb, and CI failed there on two flaky K3 tests. A second session restart at about 05:57 stopped both implementers, and nothing pushed was lost. The P06.1 implementer was resumed to fix the flake and finish K12.

Next, in iter 007: on two APPROVEs for #16, squash-merge it, run the smoke test, close iter 007, and start iter 008. #18 merges on its own two APPROVEs.
- **Iter 008, when P05 merges:** P06 ∥ P08-B ∥ P03.1 (Sonnet), from `logs/handoff/{P06,P08-B,P03.1}-prompt.md`. Owns were checked; each packet has an "alongside" section. P06's Jobs- and Status-page items were split out into P06.1 (GOALS P3.H), already running.
- **Then:** after P06, P07-C (it carries P07-B's follow-ups and the real-handler e2e) and P10-A. Then P10-B (it carries P02.2's nits).
- **Reviews:** one Opus reviewer and one Opus UI critic per PR. After round 1, rounds are narrow and reuse the same reviewers. A REVISE goes back to the same implementer once; a second REVISE goes to a fresh Opus escalation.

If this session dies: every agent pushes its branch at green steps. Save a dead agent's uncommitted diff to /tmp, run `git switch --detach` in its worktree to free the branch, then spawn a fresh agent that runs `git switch packet/PNN`.

Must-carry (see "Rules and lessons learned" in the pause handoff):
- **Every prompt:**
  - Branch from `origin/…`. Write only in the worktree or /tmp, and open only the /tmp paths named. MCP screenshot tools need absolute paths.
  - Before each screenshot, confirm `clientWidth` is 390 or 1280.
  - No recursive deletes through node, find or python. Never test a guardrail.
  - A command refused for complexity: split it, or use Edit/Write. Refused by a deny rule or permission: stop and report.
- **Orchestrator messages:** each agent's prompt has a private code word, kept in a private /tmp folder and never committed. Every mid-round message carries it. Use TaskStop for a real stop.
- **Ports are exclusive:** owner 3000/3001; 4310 the extension bridge, one agent at a time; implementers 4320, 4330, 4360 and 4380; UI critics 4340, 4350, 4370 and 4390; catalog 3106.
- **eve:**
  - Directives compile per app root (§8 item 14), and turns are classified per item 15.
  - Model turns go through `runTurn`. A tool validates and returns, and the route saves only after an ok turn.
  - Eval files import `runner/eval-agent/evals/eval-workspace.ts` and never assign `RUNNER_WORKSPACE` themselves.
- **URLs:** captured URLs may be http; the runner's own fetches go through `safe-fetch`, https only. Opening a stored URL must refuse private targets.
- **CLI entry files** stay top-level scripts. Testable logic lives in `lib/`.

Open blocks: owner-gated catalog deploy, first release tag, tag-push deny rule, `RUNNER_` prefix (GOALS Open dependencies, PR #2).
<!-- Tier 1: read every iter. Hard cap 30 lines. Overwrite each iter; this file IS the handoff. -->
