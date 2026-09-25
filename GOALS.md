# GOALS.md — loop backlog for workflow-catalog

Read by `autonomous-build-loop` every iteration. Each item points at its packet file under `docs/spec/implementation/`; the packet holds the deliverables, Owns paths, and acceptance tests. Items in the same phase with disjoint Owns may run in parallel (up to four implementers). Never pick an item whose "blocked by" items are not `[done]`.

## Phase 1 — Foundation

- [x] P1.A — P00 Repository scaffold — pnpm monorepo, themed catalog shell, contracts stub, CI; spec P00-scaffold-and-loop.md. Done iter 001, PR #1 (squash d107806).
- [x] P1.B — P01 Workflow package and contracts — zod schemas, workflow.json, skills, templates, fixtures; spec P01; blocked by P1.A. Done iter 002, PR #3 (squash 18dcf02).
- [x] P1.C — P02 spike: chatgpt() under eve start vs eve dev — scratch dir outside the repo; report both outcomes verbatim; spec P02 step 0; blocked by P1.A. Done iter 002: mode A (docs/spec/research/eve-spike.md).
- [x] P1.D — P02 Runner skeleton, bridge, pairing, setup, doctor — eve@0.63.0 project in chosen mode; spec P02; blocked by P1.B, P1.C. Done iter 003, PR #8 (squash 9a0c5b7).
- [x] P1.E — P09.A Catalog: invite sign-in, install-guide shell, learn docs — Neon free, no email provider; spec P09; blocked by P1.A. Done iter 002, PR #4 (squash 3d64f23); deploy steps owner-gated.
- [x] P1.F — P01.1 Contracts follow-ups — URL rule parity (zod vs JSON Schema), pair code cap, always-ask fixture consistency; spec P01.1-contracts-followups.md; blocked by P1.B. Must land before P2.A (P03). Done iter 003, PR #5 (squash 761f96a).

## Phase 2 — Own the workflow

- [x] P2.A — P03 Onboarding and career profile — sources accounting, claims, readiness lock, profile file; spec P03; blocked by P1.D. Done iter 005, PR #11 (squash 9821bee).
- [x] P2.B — P04 Job capture — extension/paste/URL paths, snapshots, hostile fixture, shared safe-fetch; spec P04; blocked by P2.A (rulebook: P04 after P03). Done iter 006, PR #14 (squash 08262a1).
- [x] P2.C — P07.A Extension: manifest, pairing page, capture extractor, file export — no bridge calls yet; spec P07; blocked by P1.A. Done iter 003, PR #7 (squash bc55bb3).
- [x] P2.D — P09.B Catalog: template page from workflow.json, release workflow — spec P09; blocked by P1.B, P1.E. Done iter 003, PR #6 (squash a9032b3); first release owner-gated.
- [x] P2.E — P07.B Extension: pairing and job_capture against the bridge — spec P07 and P04; blocked by P1.D, P2.C. Done iter 005, PR #12 (squash e01017c).
- [x] P2.F — P09.1 Catalog follow-ups — install commands synced to the runner's whole-repo clone path with a drift test, refusal-nonce test, stop reading at the checksum cap, UI notes; spec P09.1-catalog-followups.md; blocked by P1.D, P2.D. Done iter 004, PR #10 (squash 61f0e2d).
- [x] P2.H — P03.2 Onboarding and model-turn follow-ups — one turn classifier (P03's extraction and P02's checkModel onto P08-A's runTurn), P03 round-4 nits and polish; spec P03.2-onboarding-and-turn-followups.md; blocked by P2.B (P04 adds turn events). Runs before P2.G (shared files). Done iter 007, PR #17 (squash 47cca70).
- [ ] P2.G — P03.1 Onboarding sources: PDF/DOCX, exported archives, URL import, GitHub token, plus the happy-dom devDependency — deferred from P03 at review (iter 004); spec P03.1-onboarding-sources.md; blocked by P2.A, P2.B, P2.H (shared files) and P3.A (package.json).

## Phase 3 — Apply

- [ ] P3.A — P05 Preparation with evidence, validator, export — citations, excluded-claim proof, hostile pipeline test; spec P05; blocked by P2.A, P2.B.
- [x] P3.B — P08.A Run log and budget pause — no schedules yet; spec P08; blocked by P1.D. Done iter 005, PR #13 (squash 360ac69).
- [x] P3.F — P02.1 Runner follow-ups — HEAD must not spend the one-time sign-in link; a unit test for an error inside the /pair queue; spec P02.1-runner-followups.md; blocked by P1.D. Done iter 004, PR #9 (squash d9454f2).
- [x] P3.G — P02.2 Runner workspace precedence — `.env.local` wins for the workspace so an ambient `RUNNER_WORKSPACE` (GitHub Actions sets one) can't redirect a set-up runner; doctor warns on disagreement; spec P02.2-runner-workspace-precedence.md; not blocked (found by the P04 round-2 reviewer, iter 006). Done iter 006, PR #15 (squash 2b93cf0).
- [ ] P3.C — P06 Board and application sessions — stages, manifests, commands, reconciliation, plus the Applications-page follow-ups; spec P06; blocked by P3.A.
- [ ] P3.H — P06.1 Jobs and Status page follow-ups — the Jobs-page and Status-page items P04's, P03.2's and P05's reviews carried to P06, the `.secondary` border and the `.error` colour; split from P06 in iter 007; spec P06.1-jobs-and-status-followups.md; not blocked: pulled forward in iter 007, and it copies P05's runner-down notice from `packet/P05` until P05 merges.
- [ ] P3.D — P08.B Schedules and catch-up — daily and weekly, last-run marker, idempotent retries; also the part-A review follow-ups (P08 packet, "Carried into part B"); spec P08; blocked by P3.A, P3.B.
- [ ] P3.E — P07.C Extension: sessions, tab group, side panel, the nine gates — spec P07; blocked by P3.C, P2.E.

## Phase 4 — Ship the pilot

- [ ] P4.A — P10.A Pilot docs: success test, privacy checklist, known limitations — spec P10; blocked by P3.C.
- [ ] P4.B — P10.B Upgrade flow and full acceptance run — spec P10; blocked by every other item.

## Open dependencies (waiting on user)

- Chrome Web Store developer registration and private listing (blocks store distribution only; unpacked install covers the overnight build).
- Confirm the currency reading (USD before tax) and repo visibility (public). No current block.
- Catalog deploy (P09, owner-gated, outward-facing account actions): create the Vercel project with root `apps/catalog`, provision Neon free via the Vercel Marketplace, set `OWNER_SECRET`, `SESSION_SECRET`, `DATABASE_URL`, turn Deployment Protection off (the app does its own auth), then `vercel pull` → `vercel build` → `vercel deploy --prebuilt` for a preview. Steps: `apps/catalog/README.md`. Blocks only the "catalog live on Hobby" acceptance items.
- First package release (P09-B, owner-gated): push the tag `job-assistant@0.1.0` to run `.github/workflows/release-package.yml`. The loop never tags or releases. Until a release exists, the template page shows "not published yet" and links to the install guide.
- Guardrail suggestion: `.claude/settings.json` denies `gh release create` but not tag pushes. Consider denying `Bash(git push --tags:*)` and `Bash(git push origin job-assistant@*:*)`.
