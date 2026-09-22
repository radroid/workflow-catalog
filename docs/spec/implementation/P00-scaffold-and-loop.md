# P00 · Repository scaffold and loop protocol

Status: claimed
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
