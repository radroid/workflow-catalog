# PLAN.md

Current build sequence. Source of truth for phase ordering; complements `GOALS.md` (which holds individual items). Packet-level ordering (Blocked-by, Owns, what can run alongside what) is the table in `docs/spec/implementation/README.md`; the iteration-by-iteration wave plan is `docs/spec/implementation/OVERNIGHT-OPUS-PROMPT.md` Part B.

## Phase 0 — Bootstrap (DONE)

- `iter-000` — Repo scaffolded via `auto-loop-bootstrap` skill on top of the S0 planning packet (`docs/spec`, `docs/learn`).

## Phase 1 — Foundation

**Exit criteria:** `pnpm install && pnpm -r typecheck && pnpm -r test && pnpm -r lint` green on a clean clone with the themed catalog page served (P00); `packages/contracts` and `packages/job-assistant` publish the zod schemas and a validating `workflow.json` with fictional fixtures (P01); the `chatgpt()` under `eve start` vs `eve dev` spike outcome is recorded verbatim and the runner skeleton pairs, sets up, and passes `doctor` in the chosen mode (P02); catalog invite sign-in, install-guide shell, and `docs/learn` rendering work locally (P09.A).

**Target iters:** 3

**Key items:** see `GOALS.md` § Phase 1.

## Phase 2 — Own the workflow

**Exit criteria:** onboarding reaches the readiness lock with every source accounted for and writes an approved career profile file (P03); job capture from extension, paste, and URL yields snapshots and the hostile fixture stays data (P04); the extension's manifest carries exactly the six permissions, pairs against the bridge, and captures a job (P07.A, P07.B); the template page renders version, checksum, and changelog from `workflow.json` and the release workflow publishes a tarball (P09.B).

**Target iters:** 2

**Key items:** see `GOALS.md` § Phase 2.

## Phase 3 — Apply

**Exit criteria:** a prepared resume in which every statement traces to a confirmed claim ID, the validator rejects the hostile pipeline, and excluded claims are provably absent (P05); the run log and budget pause work without schedules, then daily and weekly schedules with catch-up and idempotent retries (P08.A, P08.B); the board and session manifests reconcile with the extension (P06); the extension opens the tab group and side panel with explicit Applied/Deferred and all nine browser gates green (P07.C).

**Target iters:** 3

**Key items:** see `GOALS.md` § Phase 3.

## Phase 4 — Ship the pilot

**Exit criteria:** pilot docs (success test, privacy checklist, known limitations) and the `docs/learn` lesson 0003 stub exist (P10.A); the upgrade flow works and the full acceptance run from spec §10 passes end to end on a second machine as a "friend" (P10.B); `docs/spec/implementation/OVERNIGHT-REPORT.md` written.

**Target iters:** 2

**Key items:** see `GOALS.md` § Phase 4.

## Phase boundary protocol

At each phase boundary the loop MUST run an architecture pass before the next phase's first feature iter: invoke the `Skill` tool with `skill: "codebase-design"` for the deep-module vocabulary, then survey this phase's new and changed modules against it and log each deepening candidate. If `codebase-design` is not installed, survey against the criterion directly: an interface much simpler than the implementation it hides, and a seam a test can drive without the rest of the system. Result logged to `logs/blocks.md` with `**Source:** arch-pass`.
