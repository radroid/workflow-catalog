Latest: iter-000 (bootstrap) — no iters have run yet.

Phase: 1
Next step: iter-001 — P1.A (P00 scaffold) alone: one implementer on branch packet/P00 targeting overnight/integration, one reviewer, then open the overnight/integration → main PR and keep its packet table updated.
Open first: GOALS.md, docs/spec/implementation/README.md, docs/spec/implementation/P00-scaffold-and-loop.md, docs/spec/mvp-spec.md
Open blocks: none
Carry-forward: smoke test `pnpm typecheck && pnpm test` is red by design until P00 defines the root scripts. Chrome Web Store developer registration is an open dependency (blocks store distribution only; unpacked install covers the build).
Last-iter shipped: nothing yet — the first iter writes logs/iter-001.md.

<!-- Tier 1: read every iter. Hard cap 30 lines. This file IS the handoff —
     keep it self-contained, overwrite (do not append) each iter. -->
