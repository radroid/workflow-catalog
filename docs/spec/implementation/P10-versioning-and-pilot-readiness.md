# P10 · Package versioning, upgrade, and pilot readiness

Status: open
Assignee: none
Blocked by: P02–P09
Owns: runner/upgrade/, runner/ui/settings.html (upgrade section), packages/job-assistant/CHANGELOG.md, docs/pilot/
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
