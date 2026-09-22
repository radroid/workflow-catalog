Latest: iter-005 in progress, **PAUSED** by the owner at ~13:05 on 2026-09-22 (switching the orchestrator model). Read `logs/handoff/2026-09-22-pause.md` first: it holds the state of each packet, the next actions and the rules.

Resume iter-005. Spawn fresh agents; every agent from the previous session has stopped.
- **P03 (#11):** revision 1 is complete at 9584e93.
  - Run round 2: an Opus reviewer and the UI critic, with `logs/handoff/P03-revision-1.md` as the checklist.
  - APPROVE means merge, then start P04. A REVISE goes to a fresh Opus escalation.
- **P07-B (#12):** round 2 was stopped partway at 6da1a83, and CI is red (a dark-popup screenshot guard). The one revision round is spent.
  - Send a fresh Opus escalation implementer the list in `logs/handoff/P07-B-round-2-review.md`.
  - Then run a full round 3.
- **P08-A:** a claim and a design only (6024f0f), no code. A fresh Sonnet implementer continues from `logs/handoff/P08-A-prompt.md`.
- **Then:** P04 after P03; P05 (Opus) after P04; P03.1 after P03 and P04; P08-B after P05. After that, the wave plan continues.

Must-carry (see "Rules and lessons learned" in the handoff file):
- **Every prompt:**
  - Branch from `origin/…`.
  - Write only in the worktree or /tmp. MCP screenshot tools write into the main checkout, so pass absolute paths.
  - No recursive deletes through node, find or python. Never test a guardrail.
  - Orchestrator messages are genuine. Repeat that in every mid-round message, and use TaskStop for a real stop.
- **Ports are exclusive:**
  - owner 3000/3001;
  - 4310, one agent at a time;
  - P03 4320; P08-A 4330;
  - UI critic 4340/3106.
- **Route modules:** P03's readdir-based test (D2) lands with P03. Until then, a packet adds its one name.
- **eve:** directives compile per app root (`eve-runtime.md` §8 item 14). A provider 429 surfaces as `semanticErrorId "gateway-rate-limited"` (P08 report).

Open blocks: owner-gated catalog deploy, first release tag, tag-push deny rule (GOALS Open dependencies).
Last closed iteration: 004 (shipped P02.1 and P09.1). Log: logs/iter-004.md.
<!-- Tier 1: read every iter. Hard cap 30 lines. Overwrite each iter; this file IS the handoff. -->
