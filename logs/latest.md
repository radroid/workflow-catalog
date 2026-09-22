Latest: iter-001 — P00 scaffold merged (PR #1, squash d107806). Integration PR #2 (overnight/integration → main) open.

Phase: 1
Next step: iter-002 — three agents in parallel: P01 (Sonnet, worktree, packet/P01), the P02 spike (Opus, scratch dir /tmp/wc-eve-spike, outside the repo; no repo writes), and P09 part A (Sonnet, worktree, packet/P09A: invite sign-in, install-guide shell, docs/learn rendering). Then one Opus reviewer over the P01 and P09-A PRs, and a UI critic on the P09-A pages. The orchestrator writes the spike outcome verbatim into the P02 packet's Report and into docs/spec/research/eve-spike.md.
Open first: GOALS.md, docs/spec/implementation/README.md, P01-workflow-package-and-contracts.md, P02-runner-spike-and-skeleton.md (step 0), P09-catalog-site.md, logs/blocks.md (P02 and P09 follow-ups).
Parallel-safety rules for iter-002:
- Owns are disjoint: P01 = packages/contracts/, packages/job-assistant/; P09-A = apps/catalog/ (no release workflow yet); the spike stays outside the repo.
- Shared derived file: pnpm-lock.yaml. Change it only through pnpm, never by hand. The PR that merges second gets `overnight/integration` merged into it and `pnpm install` rerun. No rebase or force-push.
- Root package.json and pnpm-workspace.yaml stay untouched. The one exception is an `allowBuilds` entry for a dependency that truly needs a build script; it needs a comment and a mention in the report. Prefer dependencies without build scripts (Node 24 runs .ts scripts directly).
Facts for iter-002:
- The Codex CLI is installed and `codex login status` reports "Logged in using ChatGPT", so the spike can test chatgpt() through codex app-server without a human. No provider API keys are in the environment.
- Port 3000 is in use by the owner. Agent ports: 3101 and up for implementers and critics, 2000 for eve dev, 3210 for eve start, 4310 for the bridge. Kill servers with `lsof -ti tcp:PORT -sTCP:LISTEN | xargs kill`.
- Vercel CLI 41.3.2 is logged in (account "curlycloud"), and neonctl is not installed. Creating a Vercel project, provisioning Neon, and turning off Deployment Protection are owner-gated: they are outward-facing account actions. P09-A builds and tests against PGlite (or an equivalent local Postgres), and the deploy steps become an owner dependency.
Open blocks: none. Follow-ups: see blocks.md entries dated 2026-09-22 (P02 eve init quirks; P09 UI notes and dark-mode font remap).
Carry-forward: the smoke test is `pnpm typecheck && pnpm test` (green at d107806). Chrome Web Store registration is still an open owner dependency.
Last-iter shipped: P00 monorepo scaffold, CI, fixture scanner, themed catalog page. Log: logs/iter-001.md.

<!-- Tier 1: read every iter. Hard cap 30 lines. This file IS the handoff —
     keep it self-contained, overwrite (do not append) each iter. -->
