Latest: iter-004. Merged P02.1 (#9) and P09.1 (#10); smoke green at 5e5c8d5. P03 (#11) and P07-B (#12) are in revision round 1. PR #2 updated.

Next: iter-005. Carry-over, plus P08-A now and P04 once P03 merges.
- **Carry-over:**
  - Revision rounds: P03 (implementer a291f7a81aeecaab0) and P07-B (a0fbf693098d9e5f0).
  - On each report, send round 2 to the reviewer (a0662058ac2fd36dc) and the UI critic (a8f591f2c0b13bb12) with SendMessage. P07-B's UI check starts on 4310 only after its implementer stops.
  - APPROVE means merge; a second REVISE goes to a fresh Opus implementer.
- **P08-A** (Sonnet; GOALS P3.B): run log and budget pause, no schedules.
  - Owns: `store/runs.ts`, a budget store, `routes/runs.ts`, `ui/runs.html` and its script, and a logged-turn method in `server/eve-gateway.ts`.
  - It stays off `routes/onboarding.ts` (P03 calls `ctx.eve.client.sessions.create` there) until P03 merges; migrating that call is then an explicit grant.
- **P04** (Sonnet), after P03 merges: per the updated packet.
  - It owns `lib/safe-fetch.ts` and `lib/readable-text.ts` (SSRF rules), the URL route, and the `job_capture` handler.
  - One entry each in the eval fixture and tool registries.
- **Later:** P05 (Opus) after P04, using the run log; P03.1 after P03 and P04; P08-B after P05.

Must-carry (details: logs/blocks.md, iter-004 entries):
- **Every prompt:**
  - Branch with `git fetch origin && git switch -c packet/PNN origin/overnight/integration`.
  - Browse localhost; write only in the worktree or `/tmp`; leave scratch folders.
  - No recursive delete through node, find or python. Never test a guardrail or reroute after a refusal.
  - Orchestrator messages are genuine.
- **Route modules:** after P03's readdir check (D2) lands, no packet edits `route-modules.test.ts`. Before then, add the one name and take P03's version when merging.
- **eve:** directives compile per app root (`eve-runtime.md` §8 item 14). Cancel is `…/session/:id/cancel`.
- **Ports:** owner 3000/3001; P07-B 4310; P03 4320; P08-A 4330; UI critic 3106/4340.

Open blocks: owner-gated catalog deploy, first release tag, tag-push deny rule. Log: logs/iter-004.md.
<!-- Tier 1: read every iter. Hard cap 30 lines. Overwrite each iter; this file IS the handoff. -->
