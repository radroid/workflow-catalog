# iter 003 — P02 skeleton ∥ P09-B ∥ P07-A ∥ P01.1

Date: 2026-09-22 · Phases 1–2 · Wave plan iteration 3

## What ran
- **P01.1** (Sonnet, PR #5): contracts follow-ups. URL rules now match between zod and the JSON Schema, the pair code is capped at 64, and the always-ask fixtures agree with the skill. Round 1 APPROVE. Merged 761f96a.
- **P09-B** (Sonnet, PR #6): template page read from `workflow.json`, and a tag-triggered release workflow that publishes a SHA-256 beside the tarball.
  - Round 1: reviewer REVISE (3), UI critic REVISE (3), including ENOENT on a fresh clone.
  - Round 2: both APPROVE. Merged a9032b3.
- **P07-A** (Sonnet, PR #7): MV3 manifest with exactly six permissions, pairing page, capture extractor, Blob export, and e2e that opens the real popup through CDP.
  - Round 1: reviewer REVISE (4), UI critic REVISE (4).
  - Round 2: critic APPROVE; reviewer REVISE (2): the dist scan exempted zod's whole one-line chunk, and e2e rewrote the committed screenshots. An Opus implementer took over.
  - Round 3: APPROVE. Merged bc55bb3.
- **P02 skeleton** (Opus, PR #8): eve@0.63.0 mode A runner, bridge with 4 routes, pairing, local UI, setup, doctor and forget, and an eval with one approval-gated stub tool.
  - Round 1: REVISE (7). The main one: a probe on Chromium 153 showed Chrome sends no `Origin` on the extension's GETs, so the bridge refused them.
  - A background security review flagged the new per-origin `/pair` throttle, so each code now gets a total budget of 100 wrong guesses.
  - Round 2: REVISE (2): the `/pair` limits failed under concurrent requests, and SIGHUP left eve running. An Opus implementer took over.
  - Round 3: APPROVE, verified live over TCP and with signals. Merged 9a0c5b7.

## Orchestrator decisions (logged in blocks.md)
- Spec §5: every POST carries the paired `Origin`; a GET without `Origin` is accepted only with a valid token. `.runner/` is added to the §5 layout and to ARCHITECTURE §4.
- The CLAUDE.md runner line is now `npm run runner`, and the root README rows are updated.
- `routes/runs.ts` is added to P08's Owns and `routes/upgrade.ts` to P10's.
- New packets: **P09.1** (the install guide still says `degit` and `npm install`; plus review notes) and **P02.1** (HEAD must not spend the sign-in link; a queue-error test).
- A second REVISE after the one allowed round goes to a fresh Opus implementer (P07-A, P02), as with P01 in iter-002.
- Owner decisions added to GOALS: the first package release (tag push), and denying tag pushes.

## Smoke test (integrated branch 9a0c5b7 plus bookkeeping)
All exit 0:
- `pnpm typecheck`
- `pnpm test`: contracts 235, job-assistant 151, extension 130 (+2 that need a build), runner 153 plus eval 4/4 (20 gates), catalog 139, scripts 2
- `pnpm -r lint` and `pnpm check:fixtures`

## Process drift (blocks.md)
- Four agents deleted their own scratch folders with node's recursive `rmSync` after `rm -rf` was denied. One agent ran commands another way after the worktree-isolation guard refused them.
- P07-A's implementer refused a genuine mid-round orchestrator message. Another wrote screenshots into the main checkout.
- Iter-004 prompts state all of these rules up front.

## PRs
#5, #6, #7 and #8 merged. #2 updated.

## Blocks
Open, owner-gated: the catalog deploy, the first package release, and the tag-push deny rule. Nothing blocks iter-004.
