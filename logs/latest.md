Latest: iter-005 in progress (resumed again at 16:04 on 2026-09-23 after a weekly usage limit). The new orchestrator **resumed** it at 14:26 on 2026-09-22, after the owner's pause (handoff: `logs/handoff/2026-09-22-pause.md`). `.loop/state.json` is `in-progress` again; `iter` stays 4 until iter-005 closes.

Running now: P07-B revision 3, and the round-2 pair for P08-A and the round-3 pair for P03, one worktree each. The P03 round-2 reviewer and UI critic have finished; their worktrees and the pre-pause ones were clean and pushed, and were removed.
- **P03 (#11):** the Opus escalation (D8–D16, eve item 15) reached bbfa00e, with CI green. Round 3 is running: an Opus reviewer and an Opus UI critic, with `logs/handoff/P03-round-2-review.md` as the checklist. A REVISE goes back to the same Opus implementer (its worktree is kept). APPROVE means merge, then start P04.
- **P07-B (#12):** round 3 on d0e2b2c: the reviewer returned REVISE (1 issue, README only; the code holds) and the UI critic REVISE (5 issues, messages and tone). Revision 3 went to the same Opus implementer with decisions H1–H4 (`logs/handoff/P07-B-round-3-review.md`). Round 4 is a narrow confirmation round.
- **P08-A (#13):** revision 1 (G1–G10) reached 371cd63, CI green. Round 2 is running: an Opus reviewer and an Opus UI critic, with `logs/handoff/P08-A-round-1-review.md` as the checklist. A REVISE now goes to a fresh Opus escalation implementer.
- **Then:** P04 after P03; P05 (Opus) after P04; P03.1 after P03 and P04; P08-B after P05. After that, the wave plan continues.

If this session dies: every agent pushes its branch at green steps. Spawn fresh agents from the pushed branches with `git switch packet/PNN`, once no worktree holds that branch.
**Usage:** a weekly limit stopped every agent at about 17:05 on 9/22, and all resumed at 16:04 on 9/23. Keep review rounds narrow.

Must-carry (see "Rules and lessons learned" in the pause handoff):
- **Every prompt:**
  - Branch from `origin/…`.
  - Write only in the worktree or /tmp. MCP screenshot tools need absolute paths.
  - No recursive deletes through node, find or python. Never test a guardrail.
- **Orchestrator messages:** each agent's prompt has a private code word, kept in /tmp only and never committed. Every mid-round message carries it. Use TaskStop for a real stop.
- **Ports are exclusive:**
  - owner 3000/3001;
  - 4310 only for the P07-B implementer (revision 3);
  - the P03 reviewer 4320; P08-A 4330;
  - the UI critics 4340 (P08-A) and 4350 (P03); catalog 3106.
- **Route modules:** P03's readdir-based test (D2) lands with P03. Until then, a packet adds its one name.
- **eve:** directives compile per app root (§8 item 14). An aborted client turn ends quietly as `completed` (§8 item 15). A provider 429 surfaces as `semanticErrorId "gateway-rate-limited"`.

Open blocks: owner-gated catalog deploy, first release tag, tag-push deny rule (GOALS Open dependencies).
Last closed iteration: 004 (shipped P02.1 and P09.1). Log: logs/iter-004.md.
<!-- Tier 1: read every iter. Hard cap 30 lines. Overwrite each iter; this file IS the handoff. -->
