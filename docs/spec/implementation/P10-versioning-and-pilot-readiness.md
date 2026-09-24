# P10 · Package versioning, upgrade, and pilot readiness

Status: open
Assignee: none
Blocked by: P02–P09
Owns: runner/upgrade/, runner/server/routes/upgrade.ts, runner/ui/settings.html (upgrade section), packages/job-assistant/CHANGELOG.md, docs/pilot/
Spec: F12, §10 definition of done

## Goal
An instance stays on its package version until the person accepts an upgrade, and the owner can run the success test end to end on a second machine.

## Deliverables
- `npm run upgrade`: fetch the release matching the catalog's current version, show the changelog, require confirmation, migrate workspace schema via versioned migration scripts in `packages/contracts/migrations/`, record the new version in `workspace.json`.
- `docs/pilot/success-test.md`: the scripted run from spec §10 with a checklist and expected timings; `docs/pilot/privacy-checklist.md`; `docs/pilot/known-limitations.md` (machine-off, Web Store review, `chatgpt()` unknowns).
- `docs/learn` lesson 0003 stub "Upgrading the pinned eve version" (outline only; the owner writes it after the first real bump).

## Acceptance
- Instance on 0.1.0 stays on 0.1.0 after a 0.2.0 release until confirmed; migration fixture runs forward and is idempotent.
- The success test executed by the packet's agent on a clean machine or VM, with the transcript attached; every failed step becomes a `blocked` note, not a silent skip.
- All previous packets' acceptance suites green in CI on `main` candidate branch.

## Out of scope
Anything new. This packet closes the MVP.

## Carried into part B (from P02.2's round-2 review, iter 006)
Findings are in `logs/blocks.md`, "P02.2 peer review, round 2". These small edits are granted to part B, on top of its Owns: the lines named below, and new tests.
- **R2-N1.** `runner/README.md:143-147` says setup's default is "always `~/JobAssistant`" and that "`--yes` without `--workspace` always fails". Both are true only on a first run: on a re-run, the default is the recorded workspace. Say "on a first run", and drop "revision 1" (`:144`, `:170`), which is review jargon.
- **R2-N2.** Doctor's case-only match rests on `fs.realpathSync.native`. Add a test that a case-only difference doesn't warn, so the JS `realpathSync` can't slip back in.
- **R2-N5.** `runner/lib/eve-env.ts:22` takes the rest of `PATH` from the global `process.env`, not its `processEnv` option. Use the option. This behaves identically in production.
- **`doctor --live`'s failure line** (from P03.2's round-3 reviews). `cli/doctor.ts:58` prints "The model check failed: The model answered, …", with a capital after the colon, and may pass raw provider text through. Match the Status page's wording: one prefix, then a lower-case plain clause. `cli/doctor.ts` and `lib/live-check.ts` are granted for this line.
- **Dropped as trivial:** R2-N3 (a test comment), R2-N4 (`forget.ts:79`'s note wording for an unset source, which no production caller builds) and R2-N6 (the order of P02.2's report sections).
