Latest: iter-006 in progress, started 18:57 on 2026-09-23. Iter 005 closed with P08-A, P03 and P07-B merged (360ac69, 9821bee, e01017c); CI on e01017c is green, extension e2e included. In `.loop/state.json`, `iter` stays 5 until iter 006 closes.

Running now:
- **P04 revision 2** (PR #14): a fresh Opus escalation on `packet/P04` from f3cdec8, harness port 4330. Its prompt is `logs/handoff/P04-escalation-prompt.md`.
  - Round 2 was REVISE 6 and UI REVISE 9. The work list is T1–T21 in `logs/handoff/P04-round-2-review.md`.
  - Later REVISEs go back to this escalation. Round 3 is narrow, by the same reviewer (its worktree is kept) and the same UI critic.
- **P02.2** (new, runner workspace precedence): **PR #15** (head db8cbf9, CI 35959588048 green) is in round 1 with one Opus reviewer and no UI critic (CLI only). The Sonnet implementer's worktree is kept for a REVISE.
- After P04 merges: P05 (Opus) ∥ P03.2 (Sonnet), from their prompts in `logs/handoff/`.
- **Then:**
  - after P04: P05 (Opus) ∥ P03.2 (Sonnet), which needs P04's turn events. P03.1 follows P03.2, because they share files.
  - after P05: P08-B, which carries P08-A's follow-ups, and P06.
  - after P06: P07-C, which carries P07-B's follow-ups. Then P10.
- **Reviews:** one Opus reviewer and one Opus UI critic per PR. After round 1, rounds are narrow and check only what changed. A REVISE goes back to the same implementer once; a second REVISE goes to a fresh Opus escalation.

If this session dies: every agent pushes its branch at green steps. Spawn fresh agents from the pushed branches with `git switch packet/PNN`, once no worktree holds that branch.
**Usage:** a weekly limit stopped every agent on 9/22. Keep review rounds narrow.

Must-carry (see "Rules and lessons learned" in the pause handoff):
- **Every prompt:**
  - Branch from `origin/…`. Write only in the worktree or /tmp, and open only the /tmp paths named. MCP screenshot tools need absolute paths.
  - No recursive deletes through node, find or python. Never test a guardrail.
  - A command refused for complexity: split it, or use Edit/Write. Refused by a deny rule or permission: stop and report.
- **Orchestrator messages:** each agent's prompt has a private code word, kept in a private /tmp folder (no `wc-` prefix) and never committed. Every mid-round message carries it. Use TaskStop for a real stop.
- **Ports are exclusive:** owner 3000/3001; 4310 the extension bridge, one agent at a time; implementers 4320 and 4330; UI critics 4340 and 4350; catalog 3106.
- **Route modules:** P03's readdir-based test (D2) means route packets never edit `route-modules.test.ts`.
- **eve:**
  - Directives compile per app root (§8 item 14).
  - Turns are classified per §8 item 15: the quiet abort; `session.waiting` is ok; `turn.cancelled` is not; authorizations.
  - Run model turns through P08-A's `runTurn`, and add no new classifiers.
  - A provider 429 surfaces as `semanticErrorId "gateway-rate-limited"`.
- **URLs:** captured and pasted URLs may be http, per the contract. Only the runner's own fetches are https-only, with the SSRF rules. Opening a stored URL must refuse loopback and private targets.

Open blocks: owner-gated catalog deploy, first release tag, tag-push deny rule (GOALS Open dependencies).
Last closed iteration: 005 (merged P08-A, P03 and P07-B). Log: logs/iter-005.md.
<!-- Tier 1: read every iter. Hard cap 30 lines. Overwrite each iter; this file IS the handoff. -->
