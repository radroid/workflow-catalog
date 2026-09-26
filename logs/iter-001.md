# iter 001 — P00 repository scaffold

Date: 2026-09-21 → 2026-09-22 · Phase 1 · Wave plan iteration 1 (P00 alone)

## What ran
- **Implementer (Sonnet, worktree, `packet/P00`)**: pnpm 11 monorepo (`apps/*`, `packages/*`, `runner`, `extension`), strict `tsconfig.base.json`, ESLint 9 flat config (typescript-eslint + eslint-config-next scoped to the catalog), Vitest, Node 24 pins, CI on pull_request and on pushes to `overnight/integration`, a dependency-free `scripts/check-fixtures.mjs`, root README. Real packages: `apps/catalog` (Next 16.3.5, one themed page, Geist via the `geist` next/font package, `globals.css` imports `docs/spec/visuals/theme.css`) and `packages/contracts` (zod 4.5.4 exact, `PROTOCOL_VERSION`). Placeholders: `packages/job-assistant`, `runner`, `extension`. Opened PR #1.
- **Reviewer (Opus)**: round 1 `VERDICT: REVISE — 2 issues` (fixture scanner skipped non-ASCII paths; `.npmrc` ignored by pnpm 11). Round 2 after revision 1: `VERDICT: APPROVE`.
- **UI critic (Opus)**: `VERDICT: APPROVE`, five polish notes for P09 (see blocks.md).
- **Merge**: PR #1 squash-merged into `overnight/integration` as d107806; worktree and branches pruned; packet `Status: done`; GOALS P1.A ticked.
- **Integration PR**: #2 opened, `overnight/integration` → `main`, with the packet table.

## Decisions the implementer was given (future packets inherit them)
- TypeScript pinned at 6.0.3 (typescript-eslint supports <6.1.0; TS 7.0.2 is latest).
- zod pinned at 4.5.4, the exact version eve@0.63.0 depends on.
- Package names: `catalog`, `@workflow-catalog/{contracts,job-assistant,runner,extension}`.
- The contracts package is an internal package: its exports point at `src/index.ts`.
- Root `test` also runs `node --test scripts/*.test.mjs`.
- `engineStrict` and `saveExact` live in `pnpm-workspace.yaml`, not `.npmrc`.

## Orchestrator commits in this iter
- `docs/spec/map.md`: removed the owner's local filesystem path (public repo).
- `.gitignore`: `.claude/worktrees/` (Agent worktrees live there).
- `fixtures-policy.md`: one sentence that tests must build disallowed strings at runtime.

## Smoke test (integrated branch, d107806)
`pnpm install --frozen-lockfile` ok · `pnpm typecheck` exit 0 · `pnpm test` exit 0 (catalog 3/3, contracts 3/3, scripts 2/2) · `pnpm check:fixtures` exit 0.

## Blocks
None open. Follow-ups logged for P02 (eve init quirks) and P09 (UI notes, dark-mode font remap).

## Cost/time
Implementer ~28 min, review ~13 min, revision ~12 min, re-review ~2 min, UI critic ~6 min.
