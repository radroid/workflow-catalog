Latest: iter-005 in progress. The new orchestrator **resumed** it at 14:26 on 2026-09-22, after the owner's pause (handoff: `logs/handoff/2026-09-22-pause.md`). `.loop/state.json` is `in-progress` again; `iter` stays 4 until iter-005 closes.

Running now: two escalation implementers and the P08-A round-1 pair, one worktree each. The P03 round-2 reviewer and UI critic have finished; their worktrees and the pre-pause ones were clean and pushed, and were removed.
- **P03 (#11):** round 2 returned REVISE from both (reviewer 6, UI critic 9). A fresh **Opus escalation implementer** is working the combined list and decisions D8–D16 in `logs/handoff/P03-round-2-review.md`. Round 3 follows.
- **P07-B (#12):** a fresh Opus escalation implementer works the combined list in `logs/handoff/P07-B-round-2-review.md`, red CI first.
  - Then a full round 3 (reviewer and UI critic), including what round 2 never checked.
- **P08-A (#13):** the Sonnet successor opened PR #13 at 0af2945 (chain green, both TZ runs, 4 mutation proofs). Round 1 is running: an Opus reviewer and an Opus UI critic. A REVISE goes back to the same implementer once (its worktree is kept).
- **Then:** P04 after P03; P05 (Opus) after P04; P03.1 after P03 and P04; P08-B after P05. After that, the wave plan continues.

If this session dies: every agent pushes its branch at green steps. Spawn fresh agents from the pushed branches with `git switch packet/PNN`, once no worktree holds that branch.

Must-carry (see "Rules and lessons learned" in the pause handoff):
- **Every prompt:**
  - Branch from `origin/…`.
  - Write only in the worktree or /tmp. MCP screenshot tools need absolute paths.
  - No recursive deletes through node, find or python. Never test a guardrail.
- **Orchestrator messages:** each agent's prompt has a private code word, kept in /tmp only and never committed. Every mid-round message carries it. Use TaskStop for a real stop.
- **Ports are exclusive:**
  - owner 3000/3001;
  - 4310 only for the P07-B implementer;
  - the P03 reviewer 4320; P08-A 4330;
  - the UI critic 4340/3106.
- **Route modules:** P03's readdir-based test (D2) lands with P03. Until then, a packet adds its one name.
- **eve:** directives compile per app root (`eve-runtime.md` §8 item 14). A provider 429 surfaces as `semanticErrorId "gateway-rate-limited"`.

Open blocks: owner-gated catalog deploy, first release tag, tag-push deny rule (GOALS Open dependencies).
Last closed iteration: 004 (shipped P02.1 and P09.1). Log: logs/iter-004.md.
<!-- Tier 1: read every iter. Hard cap 30 lines. Overwrite each iter; this file IS the handoff. -->
