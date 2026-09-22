Latest: iter-002. P01 merged (PR #3, 18dcf02), P09-A merged (PR #4, 3d64f23), P02 spike chose mode A (docs/spec/research/eve-spike.md). Integration PR #2 open.

Phase: 1 (P02 skeleton, P01.1 left); P09-B and P07-A (Phase 2) are unblocked.
Next step: iter-003, four implementers in parallel worktrees, then one Opus reviewer over all four PRs and a UI critic on the template page plus the extension pages.
- P02 skeleton (Opus, packet/P02, mode A) owns runner/ and packages/job-assistant/adapters/eve/.
- P09-B (Sonnet, packet/P09-B): template page + release workflow; owns apps/catalog/ and .github/workflows/release-package.yml.
- P07-A (Sonnet, packet/P07-A): manifest, options/pairing page, capture extractor, file export, no bridge calls; owns extension/.
- P01.1 (Sonnet, packet/P01.1): contracts follow-ups; owns packages/contracts/src/ and job-assistant schemas/, test/, skills/follow-up-questions/, fixtures/expected-claims.json, fixtures/index.json.
- pnpm-lock.yaml is shared and derived: change it only through pnpm; the PR merged later gets a refresh merge, never a rebase.
Must-carry (details in logs/blocks.md, 2026-09-22):
- P02:
  - Pin eve exactly and keep TS 6.0.3. eve init writes a caret, TS 7, and Vercel leftovers.
  - Store an explicit model slug in settings; the default is rejected. Doctor checks it.
  - Keep codex on PATH. Run `eve extension build` before `eve build`. Never alternate modes on one .eve/. Treat logs and .eve/ as personal data.
  - Tools use approval: always() and take task IDs only; report_status and capture_job are not model-callable.
  - Choose and document the install path in runner/README.md (a workspace dep breaks `degit runner/`).
  - Allowed: eve build/start/dev/eval on loopback 2000/3210/4310, stopped afterwards.
- P09-B:
  - First fix the dev PGlite duplicate instance (globalThis cache + test) and the `?error=__proto__` crash (Object.hasOwn).
  - Checksum = SHA-256 published beside the release asset (F2 amended); show a graceful placeholder until a release exists.
  - The loop never tags or releases.
  - UI: aria-pressed on a flipping label, focus after in-app submit, blue ring on the alert.
- P07-A: exactly six permissions; host permission only http://127.0.0.1:4310/*. Export via Blob + <a download> (no downloads permission). No build tools with postinstall scripts.
- Ports: P09-B 3105, UI critic 3106, P07-A 3107; the owner uses 3000. Kill a server with `lsof -ti tcp:PORT -sTCP:LISTEN | xargs kill`.
Open blocks: catalog deploy is owner-gated (GOALS Open dependencies).
Carry-forward: smoke test green at the iter-002 commit. P03 waits for P02 and P01.1.
Last-iter shipped: contracts + package, catalog invite/install/learn, eve spike decision. Log: logs/iter-002.md.

<!-- Tier 1: read every iter. Hard cap 30 lines. This file IS the handoff —
     keep it self-contained, overwrite (do not append) each iter. -->
