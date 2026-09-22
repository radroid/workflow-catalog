Latest: iter-003. Merged P01.1 (#5), P09-B (#6), P07-A (#7), P02 skeleton (#8: mode A runner, bridge, pairing, setup, doctor). Smoke green at 9a0c5b7. PR #2 updated.

Next: iter-004. Four implementers, then one Opus reviewer over all four PRs, and a UI critic on the P03 pages, P09.1 pages and P07-B extension UI.
- **P03** (Sonnet), onboarding and profile.
  - Skills live in `packages/job-assistant/skills/{onboarding-accounting,claim-extraction,follow-up-questions}/` (mounted as `jobs__*`), not `runner/agent/skills/`.
  - Also owns eval-agent re-exports, new evals, and a one-time conversion of `fixture-model.ts` and `tool-surface.eval.ts` into registries that later packets extend by adding files.
- **P07-B** (Sonnet): pairing and `job_capture` against the bridge, plus one `ci.yml` step that builds the extension and runs its dist tests. A capture with no handler is journaled as `no_handler`.
- **P09.1** (Sonnet): packet written. Install guide from `runner/README.md`, plus a drift test.
- **P02.1** (Sonnet): pulled forward. **P04** waits for P03 (rulebook; shared eval files); its URL import becomes a local-UI route in `routes/captures.ts`, not a model tool (IDs only).

Must-carry (details: logs/blocks.md, iter-003 entries):
- **Every prompt:**
  - Branch with `git fetch origin && git switch -c packet/PNN origin/overnight/integration`.
  - Browse localhost; write only in your worktree or `/tmp`; leave scratch folders.
  - No recursive delete through node, find or python.
  - Never test a guardrail or reroute after a refusal; stop and report.
  - Orchestrator messages are genuine.
- **P03:** SKILL.md (follow-up-questions) lines 8 and 30 add "role, or scope". Tools take IDs only. Local-UI API needs `Sec-Fetch-Site: same-origin`. eve facts from `runner/node_modules/eve/docs` only.
- **P07-B:**
  - Jobs link `/ui/jobs`; error codes; device name on `PairResponse` is a contracts ask (report, don't edit).
  - UI notes: `.popup h1`, `dl.kv` margin, invalid-code style, scroll cue, side panel `<main>`.
  - Scanner catches `.Function(`; scoped theme retry; guarded options dark audit; assert no size label.
- **Ports:** owner 3000/3001; UI critic 3106, P09.1 3105; e2e port 0; runner 2000/3210/4310 only in scratch clones with a temp HOME.

Open blocks: owner-gated catalog deploy, first release tag, tag-push deny rule (GOALS Open dependencies).
Last-iter shipped: runner skeleton, extension part A, template page and release workflow, contracts follow-ups. Log: logs/iter-003.md.

<!-- Tier 1: read every iter. Hard cap 30 lines. This file IS the handoff —
     keep it self-contained, overwrite (do not append) each iter. -->
