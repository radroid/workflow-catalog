Latest: iter-007 in progress since 2026-09-24 about 08:10. Round 1 for both PRs returned REVISE, and both are in revision 1 with their own implementers:
- **P05** (#16): REVISE 9 + UI REVISE 9. V1–V20 in `logs/handoff/P05-round-1-review.md`; sent about 11:59. Port 4320.
- **P03.2** (#17): revision 1 (8ddcbae), then round 2 REVISE 4 + UI REVISE 3. A fresh Opus escalation took over `packet/P03.2` about 13:46, with S1–S9 in `logs/handoff/P03.2-round-2-review.md` (prompt: `P03.2-escalation-prompt.md`). Port 4330. Last closed: iter-006.

Next, in iter 007: when a revision reports, the next round is narrow and reuses the same reviewer and UI critic (SendMessage with their code words). When P05 merges, the rulebook's P06 row says P06 extends `routes/applications.ts`.
- **Then:**
  - after P05: P08-B (it carries P08-A's follow-ups and the extraction-budget question) and P06 (it carries P04's follow-ups);
  - after P03.2 and P05: P03.1;
  - after P06: P07-C (it carries P07-B's follow-ups and the real-handler e2e). Then P10 (part B carries P02.2's nits).
- **Reviews:** one Opus reviewer and one Opus UI critic per PR. After round 1, rounds are narrow and reuse the same reviewers. A REVISE goes back to the same implementer once; a second REVISE goes to a fresh Opus escalation.

If this session dies: every agent pushes its branch at green steps, starting with its claim on `packet/P05` or `packet/P03.2`. Spawn fresh agents from the pushed branches with `git switch packet/PNN`, once no worktree holds that branch.

Must-carry (see "Rules and lessons learned" in the pause handoff):
- **Every prompt:**
  - Branch from `origin/…`. Write only in the worktree or /tmp, and open only the /tmp paths named. MCP screenshot tools need absolute paths.
  - Before each screenshot, confirm `clientWidth` is 390 or 1280.
  - No recursive deletes through node, find or python. Never test a guardrail.
  - A command refused for complexity: split it, or use Edit/Write. Refused by a deny rule or permission: stop and report.
- **Orchestrator messages:** each agent's prompt has a private code word, kept in a private /tmp folder and never committed. Every mid-round message carries it. Use TaskStop for a real stop.
- **Ports are exclusive:** owner 3000/3001; 4310 the extension bridge, one agent at a time; implementers 4320 and 4330; UI critics 4340 and 4350; catalog 3106.
- **eve:**
  - Directives compile per app root (§8 item 14), and turns are classified per item 15.
  - Model turns go through `runTurn`. A tool validates and returns, and the route saves only after an ok turn.
  - Eval files import `runner/eval-agent/evals/eval-workspace.ts` and never assign `RUNNER_WORKSPACE` themselves.
- **URLs:** captured URLs may be http; the runner's own fetches go through `safe-fetch`, https only. Opening a stored URL must refuse private targets.
- **CLI entry files** stay top-level scripts. Testable logic lives in `lib/`.

Open blocks: owner-gated catalog deploy, first release tag, tag-push deny rule, `RUNNER_` prefix (GOALS Open dependencies, PR #2).
<!-- Tier 1: read every iter. Hard cap 30 lines. Overwrite each iter; this file IS the handoff. -->
