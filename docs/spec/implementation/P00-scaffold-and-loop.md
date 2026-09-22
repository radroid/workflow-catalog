# P00 · Repository scaffold and loop protocol

Status: done
Assignee: iter-001 implementer (Sonnet)
Blocked by: none
Owns: repo root (package.json, pnpm-workspace.yaml, tsconfig.base.json, .github/, .loop/, docs/, apps/catalog/ skeleton, runner/ placeholder, packages/*/ placeholders, extension/ placeholder)
Spec: §2 layout, §6 theme

## Goal
A pnpm monorepo that type-checks, lints, and tests empty packages, with the spec, research, teaching workspace, and loop protocol in place, so every later packet starts from green.

## Deliverables
- `pnpm-workspace.yaml` with `apps/*`, `packages/*`, `runner`, `extension`.
- `docs/spec/` = copy of the planning packet (`mvp-spec.md`, `CONTEXT.md`, `hard-problems.md`, `research/`, `issues/`, `implementation/`, `visuals/`). `docs/learn/` = copy of the planning `teach/` workspace.
- `apps/catalog/`: Next.js app scaffold with `globals.css` importing the tokens from `docs/spec/visuals/theme.css` and Geist/Geist Mono via `next/font`. One page that renders "workflow catalog" in the theme.
- `packages/contracts/`: empty zod package with a build and test script.
- CI: typecheck, lint, unit tests, on pull requests. Node 24 pinned in `.nvmrc` and `engines`.
- `.loop/` protocol files: only if the `auto-loop-bootstrap` skill is available to the session (the orchestrator runs it otherwise). The smoke test it should register is `pnpm -r typecheck && pnpm -r test`. If skipped, say so in the report.
- `README.md`: what this repo is, the three parts, how to run each, link to `docs/learn`.

## Acceptance
- `pnpm install && pnpm -r typecheck && pnpm -r test && pnpm -r lint` green on a clean clone.
- `pnpm --filter catalog dev` serves the themed page; screenshot attached to the PR.
- No file in the repo contains a real person's data (grep for the fixture names list in `docs/spec/implementation/fixtures-policy.md`, which this packet creates: the allowed fictional companies and people).

## Out of scope
Any feature. Any eve code.

## Report

### 2026-09-22 — Revision 1 (iter-001 implementer, Sonnet)

Review verdict was REVISE (2 medium issues). Fixed both plus four small
follow-ups, on `packet/P00` in the same worktree; new head
`22601c7f2f0433bf338a68178e06fa796969d044`.

**What changed.**
- `scripts/check-fixtures.mjs`: switched `git ls-files` → `git ls-files -z`
  (NUL-separated, unescaped paths) so non-ASCII/space/quote-containing
  tracked paths are read from their real filesystem path instead of git's
  quoted-and-octal-escaped display form. Replaced the blanket
  `catch { return; }` around `readFileSync` with one that only skips
  `ENOENT`/`EISDIR` (genuinely nothing to scan) and reports anything else
  as an offense — the old blanket catch is exactly how a real violation
  behind a non-ASCII name went undetected. Reworded the
  `noreply@anthropic.com` comment: that exception is a scanner-level
  allowance, not something `fixtures-policy.md` grants.
- Added `scripts/check-fixtures.test.mjs` (`node --test`): builds a
  throwaway git repo under `os.tmpdir()`, stages `fixtures/résumé.md`
  containing a LinkedIn URL and a Gmail address, spawns the real CLI
  against it, and asserts exit 1 (plus a clean-tree case asserting exit 0).
  Wired into the root `test` script:
  `pnpm -r test && node --test scripts/*.test.mjs` (the `node --test
  scripts/` form from the review comment doesn't work on Node 24.18.0 here
  — a bare directory argument is resolved as a single module via
  `Module._resolveFilename` rather than searched recursively, so it throws
  `MODULE_NOT_FOUND`; a glob does what was intended and is picked up by
  `pnpm`'s shell invocation). Also found and fixed a self-inflicted repeat
  of the same bug class: the test's own disallowed-email string was a
  literal in the source, which `check:fixtures` then flagged when scanning
  the test file itself; it's now assembled from parts at runtime.
- `.npmrc` didn't apply to pnpm 11.17.0 (`pnpm config get engine-strict` /
  `save-exact` returned `undefined`). Removed it (`git rm`) and moved both
  settings into `pnpm-workspace.yaml` as `engineStrict: true` /
  `saveExact: true`, which pnpm does read.
- Pinned `typescript-eslint@8.70.0` (published 2026-09-07, already supports
  TS 6.0) instead of `8.70.1` (published 2026-09-21) and deleted the
  `minimumReleaseAgeExclude` block pnpm had auto-written for the eleven
  `8.70.1` sub-packages — 8.70.0 is well outside the release-age window on
  its own, so the exclude (a standing bypass of that supply-chain check) is
  no longer needed.
- Added top-level `permissions: contents: read` to
  `.github/workflows/ci.yml`.
- Updated the PR body: screenshot link now points at the commit that
  carries the PNG (`22601c7f...`) instead of the `packet/P00` branch ref
  (which disappears on squash-merge), and added a "Revision 1" section
  listing all of the above.

**Tests run (real output).** Ran the full acceptance sequence twice more —
once mid-fix, once as a final pass — each on a genuinely fresh
`git clone --branch packet/P00` into a new `/tmp` directory:
`pnpm install --frozen-lockfile` (lockfile passes supply-chain policy with
no exclude entries needed), `pnpm -r typecheck`, `pnpm -r test`
(`apps/catalog` 3/3, `packages/contracts` 3/3), `pnpm -r lint`,
`pnpm typecheck && pnpm test` (the registered smoke test — `pnpm test` now
also runs `node --test scripts/*.test.mjs`: 2/2 pass, including the
non-ASCII repro asserting real exit 1), `pnpm --filter contracts build`,
`pnpm --filter catalog build`, `pnpm check:fixtures` (0 offenses) — every
command exit 0 on every run. Manually reproduced the reviewer's exact
repro (staged `packages/x/fixtures/résumé.md` with a LinkedIn URL and a
Gmail-domain address — see `check-fixtures.test.mjs` for the exact fixture)
against both the old script
(silently exits 0 — confirmed the bug) and the fixed script (exits 1,
correctly names `résumé.md` in the offense output). CI on GitHub Actions:
green on both the mid-revision and final pushes (run
35688153516, all 9 steps green, `contents: read` in effect).

**Assumptions/deviations from the review comment.** `node --test scripts/`
(bare directory) does not recursively discover test files on Node
24.18.0 as installed here — verified directly, it fails with
`MODULE_NOT_FOUND`. Used `node --test scripts/*.test.mjs` instead (shell-
expanded by pnpm's script invocation), which is what the review's "(e.g.
...)" was gesturing at rather than a hard requirement on exact syntax.

**The one thing to sharpen next time.** Any regression test whose fixture
data is a *literal* disallowed string (an email, a non-`*.example` URL)
needs to either live somewhere `check:fixtures` doesn't scan or have that
literal assembled at runtime — the scanner does not know the difference
between "a test asserting a violation is caught" and "a violation." This
bit both the original hostile-fixture policy design and this revision's
own regression test; worth a line in `fixtures-policy.md` or
`docs/spec/implementation/README.md` so the next packet doesn't rediscover
it a third time.

### 2026-09-21 — iter-001 implementer (Sonnet)

**What was done.** Full pnpm workspace scaffold: root `package.json`
(scripts, engines, packageManager), `pnpm-workspace.yaml`
(`apps/*`, `packages/*`, `runner`, `extension`), `tsconfig.base.json`
(strict per CLAUDE.md), root `eslint.config.mjs` (flat config,
typescript-eslint repo-wide + eslint-config-next scoped to
`apps/catalog/**`), `.nvmrc`/`.npmrc`, root `README.md`,
`scripts/check-fixtures.mjs` (dependency-free fixtures-policy scanner),
`.github/workflows/ci.yml`. `packages/contracts` is a real package: one
`PROTOCOL_VERSION` constant + zod schema, one Vitest test, internal-package
`exports` (points at `src/index.ts`), `build` via `tsc -p
tsconfig.build.json`. `apps/catalog` is a real Next.js 16 / App Router /
React 19 app: one themed home page (`globals.css` imports
`docs/spec/visuals/theme.css` by relative path, remaps `--font-sans`/
`--font-mono` to the `geist` package's `next/font` variables), one Vitest
test asserting the theme wiring. `packages/job-assistant`, `runner`,
`extension` are placeholders (`package.json` + README naming the packet
that fills each in). Took the acceptance screenshot on port 3101 with
Playwright, looked at it, killed the server, confirmed the port was free.
Opened PR #1 (`packet/P00` → `overnight/integration`); CI green on the
first push (all 9 steps: checkout, pnpm/node setup, install, typecheck,
lint, test, check:fixtures, build catalog).

**Tests run (real output).**
- `pnpm -r typecheck` — `apps/catalog` and `packages/contracts` clean
  (`tsc --noEmit`); 3 placeholders echo. Exit 0.
- `pnpm -r test` — Vitest: `apps/catalog` "Test Files 1 passed (1), Tests 3
  passed (3)"; `packages/contracts` "Test Files 1 passed (1), Tests 3
  passed (3)"; 3 placeholders echo. Exit 0.
- `pnpm -r lint` — ESLint 0 errors/0 warnings on `apps/catalog` and
  `packages/contracts`; 3 placeholders echo. Exit 0.
- `pnpm typecheck` / `pnpm test` (the registered `.loop/state.json` smoke
  test, run standalone) — both exit 0.
- `pnpm --filter contracts build` — `tsc -p tsconfig.build.json`, emits
  `dist/index.js` + `dist/index.d.ts`. Exit 0.
- `pnpm --filter catalog build` — Turbopack production build, "Compiled
  successfully", static-prerendered `/` and `/_not-found`. Exit 0.
- `pnpm check:fixtures` — 0 offenses across the tree (including the
  pre-existing `docs/spec/` and `docs/learn/` content from S0). Exit 0.
- All of the above repeated verbatim on a genuine clean clone
  (`git clone --branch packet/P00` into `/tmp`, `pnpm install
  --frozen-lockfile`) — same results. CI on GitHub Actions independently
  confirmed all steps green in 30s.

**What was skipped and why.** `.loop/` protocol files: already bootstrapped
by the orchestrator in iter-000 (`.loop/state.json` present with
`base_branch: overnight/integration`, `smoke_test: pnpm typecheck && pnpm
test`, matching what this packet expects). Not touched, per the packet's
own instruction. `docs/spec/implementation/fixtures-policy.md`: already
existed from S0 with the exact fictional-fixtures policy this packet's
scanner enforces; verified, not rewritten.

**Assumptions made.**
- **Package names** exactly as specified: `catalog`,
  `@workflow-catalog/contracts`, `@workflow-catalog/job-assistant`,
  `@workflow-catalog/runner`, `@workflow-catalog/extension`. Both
  `pnpm --filter catalog ...` and `pnpm --filter contracts ...` (scopeless)
  resolve unambiguously — checked directly.
- **Root-hoisted tooling.** `typescript`, `vitest`, `eslint`,
  `typescript-eslint`, `eslint-config-next`, `@eslint/js`, `vite`,
  `@types/node` are root-only `devDependencies`; no package re-declares
  them. Verified empirically (not just assumed) that pnpm's
  ancestor-`node_modules/.bin` PATH walk-up resolves `tsc`/`vitest`/`eslint`
  correctly from each package's own `typecheck`/`test`/`lint` script before
  building out the rest of the scaffold on that assumption. `next` is also
  a root `devDependency`, needed only so `eslint-config-next`'s custom
  parser module (`require("next/dist/compiled/babel/eslint-parser")`,
  which does not declare `next` as a peer) can resolve it from the shared
  pnpm store; `apps/catalog` separately declares `next`/`react`/`react-dom`
  as its own real dependencies for the app itself.
- **ESLint 9, not 10** — the packet's own anticipated fallback, but for a
  more specific reason than a peer-range warning: ESLint 10 +
  `eslint-config-next@16.3.5`'s bundled Babel parser threw
  `TypeError: scopeManager.addGlobals is not a function` on real catalog
  files (reproduced, not inferred from the peer-dependency warning alone).
  Recorded so a future packet doesn't re-discover this the hard way when
  eslint-config-next catches up.
- **`eslint-config-next` scoping goes further than "scope the file globs."**
  Also drops the `next/typescript` sub-config entirely (redundant with the
  repo-wide `typescript-eslint` config; keeping it risked a duplicate
  plugin-registration error on catalog's own files) and strips the
  remaining `next` entry's `languageOptions.parser` (eslint-config-next's
  Babel parser — letting it win, since it's later in the config array,
  broke `@typescript-eslint/no-unused-vars` on type-only imports like
  `import type { Metadata } from "next"`, because Babel's TS handling
  doesn't feed that rule the same scope information). Both changes are
  commented inline in `eslint.config.mjs`.
- **`agentRules: false`** in `apps/catalog/next.config.ts`. Next 16
  auto-writes an `AGENTS.md`/`CLAUDE.md` into the app directory on first
  `dev`/`build` ("Generated AGENTS.md and CLAUDE.md for AI agents"). Caught
  this during the screenshot step (an 11-byte `apps/catalog/CLAUDE.md`
  containing just `@AGENTS.md` had appeared), deleted both, disabled the
  feature, and confirmed on a clean-clone build that it doesn't come back —
  it would otherwise sit next to and conflict with this repo's real
  `CLAUDE.md` hierarchy.
- **`turbopack.root` / `outputFileTracingRoot`** in `next.config.ts`, set
  to the monorepo root via `path.join(__dirname, "..", "..")`. Needed
  because `globals.css`'s `@import` of `docs/spec/visuals/theme.css`
  reaches outside `apps/catalog`; confirmed this is required (not
  speculative) by building without it first.
- **Contracts `exports`** use the "internal package" pattern
  (`exports["."]` → `src/index.ts` directly, `types` same target) per the
  packet's own recommendation, so Next's `transpilePackages`, Vitest, and
  eve's bundler all need no prebuild. `build` still exists (emits `dist/`)
  for P01's JSON Schema emission.
- **`@types/node` pinned to `24.13.6`** (latest `24.x`) rather than the
  global `latest` (`26.x`), to track the `.nvmrc`/`engines` Node 24 pin.
- Every third-party version was checked against the real npm registry at
  install time (not recalled from memory), including confirming TypeScript
  `latest` is `7.0.2` (out of `typescript-eslint`'s `<6.1.0` range, per the
  packet) and that `typescript@6.0.3` exists.

**The one thing to sharpen in this packet next time.** The
`eslint-config-next` integration is more fragile than the one-line
"scope it to apps/catalog" instruction suggests — it took two real,
reproduced failures (an ESLint-10 crash, then a parser-override bug hiding
behind a passing-looking config) to land on a version that both lints
correctly and doesn't silently disable typescript-eslint's own analysis on
catalog files. A future revision of this packet (or a note in
`ARCHITECTURE.md`/CLAUDE.md) could save the next implementer that
round-trip by naming the ESLint-9 pin and the parser-strip up front, or by
pointing at `@next/eslint-plugin-next` directly instead of the
`eslint-config-next` aggregate if the Babel parser issue resurfaces after a
version bump.
