# GOALS.md — loop backlog for workflow-catalog

Read by `autonomous-build-loop` every iteration. Each item points at its packet file under `docs/spec/implementation/`; the packet holds the deliverables, Owns paths, and acceptance tests. Items in the same phase with disjoint Owns may run in parallel (up to four implementers). Never pick an item whose "blocked by" items are not `[done]`.

## Phase 1 — Foundation

- [x] P1.A — P00 Repository scaffold — pnpm monorepo, themed catalog shell, contracts stub, CI; spec P00-scaffold-and-loop.md. Done iter 001, PR #1 (squash d107806).
- [ ] P1.B — P01 Workflow package and contracts — zod schemas, workflow.json, skills, templates, fixtures; spec P01; blocked by P1.A.
- [ ] P1.C — P02 spike: chatgpt() under eve start vs eve dev — scratch dir outside the repo; report both outcomes verbatim; spec P02 step 0; blocked by P1.A.
- [ ] P1.D — P02 Runner skeleton, bridge, pairing, setup, doctor — eve@0.63.0 project in chosen mode; spec P02; blocked by P1.B, P1.C.
- [ ] P1.E — P09.A Catalog: invite sign-in, install-guide shell, learn docs — Neon free, no email provider; spec P09; blocked by P1.A.

## Phase 2 — Own the workflow

- [ ] P2.A — P03 Onboarding and career profile — sources accounting, claims, readiness lock, profile file; spec P03; blocked by P1.D.
- [ ] P2.B — P04 Job capture — extension/paste/URL paths, snapshots, hostile fixture; spec P04; blocked by P1.D.
- [ ] P2.C — P07.A Extension: manifest, pairing page, capture extractor, file export — no bridge calls yet; spec P07; blocked by P1.A.
- [ ] P2.D — P09.B Catalog: template page from workflow.json, release workflow — spec P09; blocked by P1.B, P1.E.
- [ ] P2.E — P07.B Extension: pairing and job_capture against the bridge — spec P07 and P04; blocked by P1.D, P2.C.

## Phase 3 — Apply

- [ ] P3.A — P05 Preparation with evidence, validator, export — citations, excluded-claim proof, hostile pipeline test; spec P05; blocked by P2.A, P2.B.
- [ ] P3.B — P08.A Run log and budget pause — no schedules yet; spec P08; blocked by P1.D.
- [ ] P3.C — P06 Board and application sessions — stages, manifests, commands, reconciliation; spec P06; blocked by P3.A.
- [ ] P3.D — P08.B Schedules and catch-up — daily and weekly, last-run marker, idempotent retries; spec P08; blocked by P3.A, P3.B.
- [ ] P3.E — P07.C Extension: sessions, tab group, side panel, the nine gates — spec P07; blocked by P3.C, P2.E.

## Phase 4 — Ship the pilot

- [ ] P4.A — P10.A Pilot docs: success test, privacy checklist, known limitations — spec P10; blocked by P3.C.
- [ ] P4.B — P10.B Upgrade flow and full acceptance run — spec P10; blocked by every other item.

## Open dependencies (waiting on user)

- Chrome Web Store developer registration and private listing (blocks store distribution only; unpacked install covers the overnight build).
- Confirm the currency reading (USD before tax) and repo visibility (public). No current block.
