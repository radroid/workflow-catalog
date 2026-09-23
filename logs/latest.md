Latest: iter-005 in progress (resumed again at 16:04 on 2026-09-23 after a weekly usage limit). The new orchestrator **resumed** it at 14:26 on 2026-09-22, after the owner's pause (handoff: `logs/handoff/2026-09-22-pause.md`). `.loop/state.json` is `in-progress` again; `iter` stays 4 until iter-005 closes.

Running now: P07-B revision 4 and the P03 round-4 pair, one worktree each. Reviewers' worktrees are removed once clean and pushed.
- **P03 (#11):** revision 3 (J1–J8) reached fbb6444, with CI green; it already merges P08-A (keeping its readdir test). Round 4 is running as a narrow confirmation round: an Opus reviewer (4320 only if needed) and an Opus UI critic (4350, clone `/tmp/wc-ui8-p03`). A REVISE goes back to the same Opus implementer. APPROVE means merge, then start P04.
- **P07-B (#12):** round 4 on 9529761: the reviewer APPROVED; the UI critic returned REVISE (1 issue: a refused pairing is announced 2–3 times). Revision 4 is with the same Opus implementer, with decisions K1–K4 (`logs/handoff/P07-B-round-4-review.md`). Round 5 confirms only K1–K4.
- **P08-A (#13): merged** (squash 360ac69) after round 3: both reviewers APPROVED. Its nits and polish go to P08-B ("Carried into part B" in the P08 packet).
- **Then:** P04 after P03; P05 (Opus) after P04; P03.1 after P03 and P04; P08-B after P05. The runner follow-up (P02's `checkModel` to reuse P08-A's `runTurn`, eve item 15) comes after P03 merges. After that, the wave plan continues.

If this session dies: every agent pushes its branch at green steps. Spawn fresh agents from the pushed branches with `git switch packet/PNN`, once no worktree holds that branch.
**Usage:** a weekly limit stopped every agent at about 17:05 on 9/22, and all resumed at 16:04 on 9/23. Keep review rounds narrow.

Must-carry (see "Rules and lessons learned" in the pause handoff):
- **Every prompt:**
  - Branch from `origin/…`.
  - Write only in the worktree or /tmp. MCP screenshot tools need absolute paths.
  - No recursive deletes through node, find or python. Never test a guardrail.
- **Orchestrator messages:** each agent's prompt has a private code word, kept in a private /tmp folder (no `wc-` prefix) and never committed. Prompts limit agents to the /tmp paths they name. Every mid-round message carries it. Use TaskStop for a real stop.
- **Ports are exclusive:**
  - owner 3000/3001;
  - 4310 only for the P07-B implementer (revision 4);
  - the P03 reviewer 4320;
  - the UI critics 4340 and 4350; catalog 3106.
- **Route modules:** P03's readdir-based test (D2) lands with P03. Until then, a packet adds its one name.
- **eve:** directives compile per app root (§8 item 14). An aborted client turn ends quietly as `completed`, and `turn.cancelled` is not ok (§8 item 15). A provider 429 surfaces as `semanticErrorId "gateway-rate-limited"`.

Open blocks: owner-gated catalog deploy, first release tag, tag-push deny rule (GOALS Open dependencies).
Last closed iteration: 004 (shipped P02.1 and P09.1). Log: logs/iter-004.md.
<!-- Tier 1: read every iter. Hard cap 30 lines. Overwrite each iter; this file IS the handoff. -->
