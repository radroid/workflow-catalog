# P10 · Package versioning, upgrade, and pilot readiness

Status: done (part A 2026-09-25, PR #22, squash 2bf591b; part B 2026-09-25, PR #25, squash 50016c3)
Assignee: manual session (Sonnet), part B
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

## Carried into part A (from P05's round-2 review, iter 007)
- **`docs/pilot/known-limitations.md`, the PDF's characters.** The PDF embeds Noto Sans, which covers Latin (with its extensions), Greek, Cyrillic and Vietnamese. Complex scripts inside its coverage, such as Devanagari's joined letter forms, were not checked. Other scripts (CJK, Arabic, Hebrew, emoji) print "�", and the page warns at the name field and beside the PDF. The Markdown and Word files keep every character.

## Carried into part B (from P02.2's round-2 review, iter 006)
Findings are in `logs/blocks.md`, "P02.2 peer review, round 2". These small edits are granted to part B, on top of its Owns: the lines named below, and new tests.
- **R2-N1.** `runner/README.md:143-147` says setup's default is "always `~/JobAssistant`" and that "`--yes` without `--workspace` always fails". Both are true only on a first run: on a re-run, the default is the recorded workspace. Say "on a first run", and drop "revision 1" (`:144`, `:170`), which is review jargon.
- **R2-N2.** Doctor's case-only match rests on `fs.realpathSync.native`. Add a test that a case-only difference doesn't warn, so the JS `realpathSync` can't slip back in.
- **R2-N5.** `runner/lib/eve-env.ts:22` takes the rest of `PATH` from the global `process.env`, not its `processEnv` option. Use the option. This behaves identically in production.
- **`doctor --live`'s failure line** (from P03.2's round-3 reviews). `cli/doctor.ts:58` prints "The model check failed: The model answered, …", with a capital after the colon, and may pass raw provider text through. Match the Status page's wording: one prefix, then a lower-case plain clause. `cli/doctor.ts` and `lib/live-check.ts` are granted for this line.
- **Dropped as trivial:** R2-N3 (a test comment), R2-N4 (`forget.ts:79`'s note wording for an unset source, which no production caller builds) and R2-N6 (the order of P02.2's report sections).

## Report

### 2026-09-25 — Part B (manual session)

Branched `packet/P10-B` from `origin/overnight/integration`. Built the
upgrade flow (`runner/upgrade/` — semver, checksum, a hand-rolled tar
reader/writer, an https-only/SSRF-safe fetcher that reuses only
`safe-fetch.ts`'s `isBlockedAddress`, and the migration runner), the route
(`runner/server/routes/upgrade.ts`, factory-based for test injection), the
CLI (`runner/cli/upgrade.ts`), the Settings Upgrade section
(`runner/ui/settings.html` + `runner/ui/assets/settings-upgrade.js` +
`settings.css`), the one shipped migration fixture
(`packages/contracts/migrations/0001-career-profile-backfill-arrays.ts`,
0.1.0 → 0.2.0), `packages/job-assistant/CHANGELOG.md`, the four carried
part-B items, and 16 screenshots. Per the sequencing note, held
`runner/package.json` and Acceptance 2 until the orchestrator confirmed
P03.1 had merged; then merged `origin/overnight/integration` (commit
`69401ac`), added the `"upgrade"` script (`566e555`), and ran the success
test.

**Acceptance map:**
1. *An instance on 0.1.0 stays on 0.1.0 until confirmed; the migration
   fixture runs forward and is idempotent; a checksum mismatch refuses; a
   failed step leaves the workspace unchanged.*
   - Never-applies-without-confirmation: `runner/test/upgrade-core.test.ts`
     › "nothing changes without confirmation (F12's core guarantee)" ›
     "checkForUpgrade alone never writes to the workspace, however many
     times it is called"; and `upgrade-core.test.ts` › "applyUpgrade" ›
     "never applies without a matching confirmed version: a stale
     confirmation (the release moved on) is refused, and nothing changes".
   - Migration fixture forward + idempotent:
     `packages/contracts/migrations/0001-career-profile-backfill-arrays.test.ts`
     › "0001-career-profile-backfill-arrays" › "backfills presentation and
     revisions as [] on a profile missing them, producing a schema-valid
     profile" and › "is idempotent: running it a second time on its own
     output changes nothing further"; also exercised end-to-end (real file,
     real schema) by `runner/test/upgrade-core.test.ts` › "applyUpgrade" ›
     "runs the shipped 0.1.0 -> 0.2.0 fixture migration for real: a
     pre-migration career-profile.json gets backfilled".
   - Checksum mismatch refuses: `upgrade-core.test.ts` › "checkForUpgrade" ›
     "refuses (checksum_mismatch) when the downloaded tarball does not
     match its .sha256, and never reads it as JSON"; route-level in
     `upgrade-route.test.ts` › "GET /api/upgrade" › "refused (200, ok:
     false shape from checkResponse) with a plain message for a checksum
     mismatch" and › "POST /api/upgrade/confirm" › "422s a refused
     (checksum mismatch) confirmation with a plain message, never a raw
     exception".
   - A failed migration step leaves the workspace unchanged:
     `runner/test/upgrade-migrate.test.ts` › "runMigrations" › "a failed
     step leaves the workspace unchanged: an earlier step's write is never
     committed either" (also: "refuses when there is a gap in the chain
     …, and writes nothing", "refuses to migrate backward", "refuses when
     two migrations both claim the same from version").
2. *The success test, executed.* `docs/pilot/success-test-run.md` (new).
   Fresh clone `/tmp/wc-p10b-clone` (`packet/P10-B` @ `566e555`), fresh
   workspace `/tmp/wc-p10b-ws`. Passed for real: steps 1 (clone+install), 2
   (setup, `gateway` provider substituted so no real keychain/live-model
   touch), 3's `node`/`runner`/`workspace`/`privacy`/`eve`/`extension`
   lines (the checklist's own documented pre-pairing shape), 5's build
   half, 15 (forget, dry-run then real). **Blocked with cause (gate review
   round 1, B3):** step 3's `provider` line — the checklist's Expect says
   `warn`, but no real provider account or key may be used in this run, so
   `gateway`-with-no-key (the only reachable substitution) reads `fail`
   instead; the run's exit code is 1 either way (`cli/doctor.ts:64`,
   `report.ok ? 0 : 1`, and two `[FAIL]` lines were present). Also blocked:
   step 4 (port 3210 held by an unrelated pre-existing process on this
   shared machine — `lsof` confirmed before the attempt; `cli/runner.ts`
   hard-codes the port with no override; not authorized to kill another
   process to free it), which cascades to 6–14 (all need the running
   bridge); 5's load half and 6 additionally need branded Chrome; 10, 12's
   live half, 13's
   catch-up-on-demand and 14's "Paused" case additionally need a live model
   call, a real Chrome tab group, real wall-clock waiting, or a real
   provider 429 respectively — none forced, per the brief's own examples of
   what a blocked step looks like. No failed (non-blocked, non-passed)
   steps.
3. *All previous packets' acceptance suites green in CI.* PR head CI run:
   see the final reply for the run id/result (recorded there once the PR is
   open and the run completes). Latest CI on `overnight/integration`
   itself: run `36188000551`, `success` (`gh run list --branch
   overnight/integration --limit 1`). Local chain on the PR branch, merged
   with current `origin/overnight/integration` (head `566e555`, before the
   success-test-run commit): `pnpm install --frozen-lockfile` (exit 0),
   `pnpm typecheck` (exit 0, 6/6 workspaces), `pnpm test` (contracts 244,
   job-assistant 153, apps/catalog 168, runner 2192 + 7 evals/161 gates,
   extension 428 passed/5 skipped, fixtures-policy script 2/2, all green,
   no `--workspace-concurrency=1` fallback needed), `pnpm -r lint` (exit 0,
   6/6), `pnpm check:fixtures` (exit 0). `git status --porcelain` empty
   afterward. The gate's added reviewer check (`sh
   /tmp/wc-manual/eve-build-check.sh <worktree-root>`) also ran clean:
   `EVE_BUILD_EXIT=0`, `git status --porcelain` empty.
4. *Each carried part-B item has a test or a recorded check.* See below.

**Carried items (all four; edited assertions file:line, old → new, why):**
- **R2-N1** (`runner/README.md`). `:144` "the default is always
  `~/JobAssistant`, and `--yes` without `--workspace` always fails" →
  distinguished first-run (true) from a re-run (the recorded workspace is
  the default and `--yes`'s answer); dropped "revision 1" at `:144` and in
  the Doctor section ("warn (P02.2 revision 1)" → "warn (P02.2)"). Docs-only:
  recorded check, no test (nothing in README.md is executable).
- **R2-N2** (doctor's case-only match). `runner/test/doctor.test.ts` new
  test at line 255, "R2-N2: does not warn on a case-only difference, on a
  filesystem where that names the same folder" — probes the real
  filesystem's case sensitivity via `stat().ino`/`.dev` (macOS APFS here is
  case-insensitive, so the test genuinely exercises the path; it no-ops on
  a case-sensitive filesystem such as Linux CI ext4).
- **R2-N5** (`runner/lib/eve-env.ts:22`). `evePathEnv(options.codexDir)` →
  `evePathEnv(options.codexDir, options.processEnv.PATH)` — was silently
  defaulting to the real global `process.env.PATH` instead of the injected
  option. `runner/test/eve-env.test.ts` new tests: "R2-N5: takes the rest
  of PATH from its own processEnv option, never the real process.env.PATH"
  and "R2-N5: an injected PATH combines with codexDir the same way the real
  process.env.PATH would".
- **`doctor --live`'s failure line** (`cli/doctor.ts` / `lib/live-check.ts`).
  `` `The model check failed: ${result.detail ?? "no detail"}\n` `` (capital
  after the colon, raw detail passed through) → a new
  `formatCheckFailure(detail)` in `lib/live-check.ts` returning `` `The
  check failed: ${detail ?? "no detail"}` ``, with the "the model answered,
  but not …" detail lower-cased to match `server/eve-gateway.ts`'s existing
  convention. `runner/test/live-check.test.ts` (new): "formatCheckFailure"
  › "matches the Status page's exact prefix" and › "falls back to 'no
  detail', same as the Status page does for a missing detail".

**Chain and CI:** see Acceptance 3 above; PR opened into
`overnight/integration`, body and final reply carry the PR number, head SHA
and CI run id.

**Not touched, and why:** `apps/catalog`, `extension/` (beyond the one real
build in the success test) and every other packet's files — outside this
packet's `Owns:`.

**Open questions / unfinished:** none beyond the success-test's recorded
blocked steps (all environmental — a shared machine's port, branded
Chrome, a live model, real wall-clock time — never this packet's own code).

### 2026-09-25 — Part B gate fix round 1 (manual session)

Fixed the 3 BLOCKING items from the round-1 gate review of PR #25
(`/tmp/wc-manual/P10-B-gate-review.md`, head `2790338`), plus F11 (a
FOLLOW-UP in that review, reclassified BLOCKING by the orchestrator in a
separate message before this round started). FOLLOW-UPs F1–F10 and
F12–F21 were not touched, per instruction; F1 (the fetch is its own
transport, not `safeFetch` itself) was explicitly ratified by the
orchestrator and needed no change.

- **B1a** (an Acceptance bullet — "0.1.0 stays on 0.1.0 … until confirmed"
  — mapped to tests that passed with the behaviour broken). Added
  `runner/test/upgrade-route.test.ts` › "GET /api/upgrade" › "B1a: repeated
  GETs while a release is available never apply it …", which calls `GET
  /api/upgrade` five times against a workspace with a genuine 0.2.0 release
  available and asserts `workspace.json` (read fresh off disk via
  `currentWorkspaceVersion`, never the route's own response or the cached
  `workspace.manifest`) stays at `0.1.0` throughout, with no
  `career-profile.json` migration write. Added the CLI's own confirmation
  logic as a new, directly testable unit: `runner/upgrade/cli-flow.ts`'s
  `runUpgradeCli(workspace, deps)` takes an injectable `ask`/`yes`/`isTTY`,
  never a real terminal; `cli/upgrade.ts` is now a thin wrapper around it
  (Owns already required this shape — "logic lives in `runner/upgrade/`").
  New `runner/test/upgrade-cli-flow.test.ts` (6 tests) covers a declined
  ("no") confirmation and a non-interactive run without `--yes` (`ask` is
  never even called, proven with a spy that throws if it is), both leaving
  the workspace at `0.1.0`.
  **Proof, per the review's own mutation:** temporarily added `if
  (check.status === "available") await applyUpgrade(ctx.workspace,
  check.nextVersion, deps);` to the GET handler (the reviewer's exact
  M1a) — the new B1a route test failed (second GET saw `up_to_date`
  instead of `available`); reverted, re-ran, passed. Diff and test output
  for both states were inspected before moving on; the mutation was never
  committed.
- **B1b** (the same bullet's "a failed migration step leaves the workspace
  unchanged" half, and the Decisions' "records the new version only after
  every step succeeds"). Added `runner/test/upgrade-core.test.ts` ›
  "applyUpgrade" › "B1b: a failing migration step leaves workspace.json at
  the old version …": seeds a real workspace with `career-profile.json` set
  to `[]` (an array — the shipped 0001 migration throws on any non-object,
  and no production writer ever produces one, so this forces a genuine
  failure through the real migration, not a mock), calls `applyUpgrade`
  with a real 0.2.0 release available, asserts it rejects with
  `MigrationError`, then reads `workspace.json` and `career-profile.json`
  fresh off disk and asserts both are exactly as they were.
  **Proof, per the review's own mutation:** temporarily moved
  `workspace.writeJson(["workspace.json"], …)` to before `runMigrations(…)`
  in `upgrade.ts` (the reviewer's exact M3) — the new B1b test failed
  (`workspace.json` read `0.2.0` instead of `0.1.0`); reverted, re-ran,
  passed.
- **B2** (an edit outside Owns, neither forced nor disclosed). Reverted
  `packages/contracts/tsconfig.json` and `tsconfig.build.json` to their
  `origin/overnight/integration` content exactly (`git checkout
  origin/overnight/integration -- packages/contracts/tsconfig.json
  packages/contracts/tsconfig.build.json`). Confirmed after reverting:
  `pnpm --filter @workflow-catalog/contracts typecheck`, `lint`, `build`,
  and `test` all still exit 0 (244/244 tests). The one consequence is that
  `packages/contracts/migrations/*.ts` is no longer typechecked by that
  package's own `tsc` invocation — unchanged from every other packet's
  dynamically-imported files (e.g. `server/routes/*.ts`), which were never
  typechecked that way either; `runner`'s own `tsc` and the runtime
  type-stripping loader are what actually govern these files' correctness.
- **F11 (BLOCKING by orchestrator addendum):** "every Settings page load
  calls the GitHub API and downloads the tarball and .sha256, unasked."
  `runner/upgrade/upgrade.ts` now splits the release lookup from the
  download: a private `lookupRelease()` does the one GitHub API call
  (`fetchLatestRelease`) and, from the release's own asset list alone,
  can already tell `up_to_date` from `available` from `refused
  (missing_asset)` — no download. `checkForUpgrade` (`GET /api/upgrade`,
  the "Check for updates" button) is now exactly that lookup, returning
  `releaseNotes` (the release's own GitHub body — already generated from
  `workflow.json`'s changelog by `release-package.yml`) as the changelog,
  instead of a structured array read out of the tarball. `applyUpgrade`
  (`POST /api/upgrade/confirm`) is the only thing that ever calls
  `downloadReleaseAsset`, and only after re-confirming a matching release
  is still available. New `GET /api/upgrade/status`
  (`server/routes/upgrade.ts`) reads the workspace's own recorded version
  off disk via `currentWorkspaceVersion` and touches `deps` not at all —
  this is what `ui/assets/settings-upgrade.js`'s `loadStatus()` now calls
  on page load instead of the old `loadUpgrade()`'s `GET /api/upgrade`;
  the section shows none of its four outcome panels until a person
  presses "Check for updates".
  Proof: `runner/test/upgrade-fixtures.ts` gained
  `downloadForbiddenUpgradeDeps` (throws if any asset URL is ever
  requested) and `recordingUpgradeDeps` (logs which request kind each call
  was). `upgrade-core.test.ts` › "checkForUpgrade" › "F11: never downloads
  the tarball or its checksum …" uses the former; › "applyUpgrade" › "F11:
  downloads the tarball and checksum only once confirmed …" uses the
  latter to assert a check makes exactly one `release_lookup` call and a
  subsequent confirm is the first call to touch `tarball`/`checksum`.
  `upgrade-route.test.ts` › "GET /api/upgrade/status" › "F11: reports the
  workspace's current version and makes no network request at all" passes
  `networkForbiddenDeps` (throws on any `resolve`/`performRequest` call)
  straight into the route and asserts it still answers 200. The "refused"
  screenshot scenario changed from a checksum mismatch (no longer
  reachable from a check alone) to `missing_asset` (still check-time
  detectable from the release's own asset list); all 16
  `docs/screenshots/P10-B-upgrade-*.png` were retaken — the section's
  first state (no longer an auto-run check), the changelog rendering
  (plain release notes, not a structured list), and the refused message
  all changed. Added one line to `docs/pilot/privacy-checklist.md`
  naming the Upgrade check/confirm as network use the person starts, and
  what each contacts. Updated `runner/README.md`'s Upgrade section and its
  "Extending the runner" row to match the new check-vs-confirm split and
  the new `cli-flow.ts`/`/status` route.
- **B3** (success-test step 3 labelled "passed" though its `provider` line
  didn't go as written). `docs/pilot/success-test-run.md` step 3 and its
  Summary, and this file's own Acceptance 2 bullet above, now say step 3
  "passed except `provider`: blocked" — the checklist's Expect is `warn`
  there, but no real provider account or key may be used in this run, so
  the reachable substitution (`gateway`, no key) necessarily shows `fail`
  instead; the exit code (1, from `cli/doctor.ts:64`'s `report.ok ? 0 :
  1` with two `[FAIL]` lines present) is now stated explicitly rather than
  left silent.

**Chain, after all of the above** (merged with current
`origin/overnight/integration` — already up to date, no new commits since
part B's own chain): `pnpm typecheck` (exit 0, 6/6), `pnpm test` (exit 0:
contracts 244, job-assistant 153, apps/catalog 168, runner 2201 + 7
evals/161 gates, extension 428/5 skipped, fixtures-policy 2/2 — the 9 new
upgrade tests from this round are included in runner's 2201), `pnpm -r
lint` (exit 0, 6/6), `pnpm check:fixtures` (exit 0). `git status
--porcelain` empty after committing. Re-ran the gate's `sh
/tmp/wc-manual/eve-build-check.sh <worktree-root>` for this round too
(`runner/upgrade/upgrade.ts`, `server/routes/upgrade.ts`, `cli/upgrade.ts`
all changed again): `EVE_BUILD_EXIT=0`, `git status --porcelain` showed
only this round's own doc edits (no stray build artifacts).

Head after this round, CI run id and result: see the final reply.

### 2026-09-25 — Part B gate fix round 2 (manual session)

The re-check confirmed B1b, B2 and B3 done and the code already behaving
correctly for B1a and F11; the orchestrator scoped this round to tests
only ("change no production code unless a new test shows a real bug") —
none did. Four items, each mutation-proved against the reviewer's named
mutation before being committed:

1. **B1a, the `/status` route.** The existing `networkForbiddenDeps`-based
   test only checked the response shape, and the review noted its throw
   is swallowed inside `fetchBytes` into a graceful `{ok:false,
   reason:"dns_failed"}` — so a route that made a network call and
   ignored the failure would still pass. Added
   `runner/test/upgrade-fixtures.ts`'s (already-present)
   `recordingUpgradeDeps` to `upgrade-route.test.ts` › "GET
   /api/upgrade/status" as a new primary test asserting `calls` is `[]`
   after the request — a true call-count proof, not an outcome-shape
   one. Kept the old `networkForbiddenDeps` test alongside it ("belt and
   suspenders"). **Mutation:** added `await checkForUpgrade(currentVersion,
   deps).catch(() => undefined);` to the `/status` handler (the
   reviewer's exact bug) — the new spy test failed (`calls` was
   `["release_lookup"]`) while the old shape-only test still passed 200
   with the right body, exactly confirming the review's diagnosis;
   reverted, both pass.
2. **F11, the page.** Added `runner/test/settings-upgrade-page.test.ts`, a
   happy-dom page test in the shape of `sessions-page.test.ts` /
   `board-page.test.ts`, loading Settings with `settings-upgrade.js` and
   asserting the load requests only `/api/upgrade/status`, and only a
   press of Check-for-updates additionally requests `/api/upgrade`.
   Required extending `runner/test/page-harness.ts`'s `openUiPage` with
   two new optional fields, `script` (the `assets/<name>.js` to import,
   when it differs from `page`) and `liveRegionId` (defaults to
   `"last-action"`) plus a lenient live-region reader (Settings has three
   scripts and a plain `#status-message` text node, not the harness's
   built-in single-script/`#last-action`+`.text`-child assumption). Both
   are backward-compatible no-ops for existing callers when omitted —
   confirmed by re-running `sessions-page.test.ts` and `board-page.test.ts`
   (9 tests) unchanged. **Mutation:** pointed `loadStatus()` at
   `/api/upgrade` instead of `/api/upgrade/status` (the reviewer's exact
   bug) — the new test failed (`page.requests` was `["GET
   /api/upgrade"]`); reverted, passed.
3. **Checksum before read.** Added `upgrade-core.test.ts` › "applyUpgrade"
   › "the checksum is verified before the tarball is ever read or parsed
   …": a garbage, non-gzip/non-tar buffer paired with a wrong checksum.
   A correct implementation reports `checksum_mismatch` without ever
   reaching the parse step that would otherwise throw
   `TarballReadError`. **Mutation:** swapped the order in `applyUpgrade`
   so `readFileFromReleaseTarball` ran before `verifyChecksum` — the new
   test failed (`unpack_failed` instead of `checksum_mismatch`, from the
   garbage bytes throwing during parse); reverted, passed.
4. **The regression.** Restored the two tests the gate flagged as dropped,
   now directly against `applyUpgrade`: "refuses (unpack_failed) when the
   verified tarball has no package/workflow.json" and "refuses
   (invalid_manifest) when workflow.json's own version disagrees with the
   release tag." **Mutations, per the review:** dropping the
   tag-vs-`workflow.json`-version refusal made the `invalid_manifest`
   test fail immediately (the real 0.1.0→0.2.0 migration ran to
   completion, flipping the result to `"upgraded"`); reverted, passed.
   Dropping the missing-`workflow.json` refusal did *not* fail the
   `unpack_failed` test on the reason code alone — the following
   `JSON.parse(Buffer.from(undefined)…)` call happens to throw and land
   in a different catch block that reuses the same `"unpack_failed"`
   reason string, just with a different message. Strengthened the test
   to also assert the exact message
   (`"The release tarball has no package/workflow.json."`); re-ran with
   the mutation still in place — now failed correctly (message was "…is
   not valid JSON." instead); reverted, passed. This message assertion
   is a strengthening, not a weakening: it is what makes the restored
   test able to catch the reviewer's actual regression.

After every mutation-proof, `git diff --stat` on `runner/upgrade/upgrade.ts`,
`runner/server/routes/upgrade.ts`, and `runner/ui/assets/settings-upgrade.js`
was checked clean before moving to the next item; the round's committed
diff is exactly `runner/test/page-harness.ts`,
`runner/test/upgrade-core.test.ts`, `runner/test/upgrade-route.test.ts`,
and the new `runner/test/settings-upgrade-page.test.ts` — zero production
code changed.

**Chain:** merged with current `origin/overnight/integration` — already up
to date, no new commits since round 1. `pnpm typecheck` (exit 0, 6/6),
`pnpm test` (exit 0: contracts 244, job-assistant 153, apps/catalog 168,
runner 2206 + 7 evals/161 gates — the 5 new/reworked tests from this round
included, up from round 1's 2201 —, extension 428/5 skipped,
fixtures-policy 2/2), `pnpm -r lint` (exit 0, 6/6), `pnpm check:fixtures`
(exit 0). `git status --porcelain` empty after committing.

Head after this round, CI run id and result: see the final reply.

### 2026-09-25 — Gate fix round 1 (manual session, Sonnet)

Fixed all 7 BLOCKING items from the gate review (`/tmp/wc-manual/P10-A-gate-review.md`, PR #22 head `50171a1`). FOLLOW-UPs F1–F23 were not touched, per instruction. Merged `origin/overnight/integration` first (now `9e2866e`, includes P08-B as `c33689a`); clean merge.

- **B1** (five `/ui/*.html` 404s): dropped `.html` from all five URLs in `success-test.md` (application, board, sessions, settings, runs). Re-checked every `127.0.0.1:4310/ui/…` path in all three docs — `grep -n "\.html" docs/pilot/*.md` now returns nothing.
- **B2:** step 3 now says `extension` shows `fail` ("No browser extension is paired.") and the command exits 1 until step 6, and that this is expected there.
- **B3:** steps 7–8 rewritten to the real controls — **Confirm**/**Exclude** on a candidate, a "question open" claim answered with **Yes, I have evidence** or **No, exclude it**; approval needs every claim confirmed or excluded, never "disputed with a reason".
- **B4:** step 7's PDF/DOCX/zip/URL/GitHub source modes, and privacy-checklist.md's raw-PDF/DOCX line, GitHub-keychain line, and forget's `github-token` line, are all marked "per P03.1 (lands with that packet)", with today's merged behavior (paste + `.txt`/`.md` only; no `github-source.ts`; forget's key loop doesn't include it) stated alongside. Checked against `origin/packet/P03.1` again for wording.
- **B5:** "What ever leaves the machine" now names every provider turn — onboarding claim extraction (`routes/onboarding.ts`'s `buildExtractionPrompt`), job extraction, preparation, and the weekly-review schedule (`scheduler/dispatch.ts`'s `runWeeklyReview`, real now that P08-B is merged) — plus the content-free live check. Corrected "never writes": `open_application_group` is named as the one model action that writes (session/command files, gated by `approval: always()`).
- **B6:** rewrote the closing bullet — Un-pair only deletes the browser's own `chrome.storage.session` copy (`extension/src/options/main.ts`'s handler calls only `forgetPairing()`, no bridge request; confirmed by reading it); only Revoke on `/ui/status` invalidates the token.
- **B7:** step 1 now clones `--branch overnight/integration` explicitly, with a note to drop it once PR #2 merges; added as a fourth "owner-gated steps" bullet.

**Rechecked commands/paths across the whole of all three docs** (not just the flagged lines), on the merged tree:
- `grep -n '"setup"\|"doctor"\|"runner"\|"pair"\|"ui"\|"eval"\|"typecheck"\|"lint"\|"test"' runner/package.json` — unchanged, all match.
- `grep -n "\.html" docs/pilot/*.md` — empty (B1 fully swept).
- `for p in status onboarding profile jobs application board sessions settings runs; do grep -c "ui/$p\b" docs/pilot/success-test.md; done` against `runner/server/local-ui.ts`'s `PAGE_NAME` regex and `runner/ui/$p.html` on disk — all nine bare names are valid pages.
- `grep -n "P03.1" docs/pilot/*.md` — every P03.1-only fact now carries the marker; `known-limitations.md` has none (it never claimed a P03.1 feature) and needed no change.
- Verified new claims directly: `runner/agent/tools/open_application_group.ts` (writes, `approval: always()`), `runner/store/devices.ts` (`.runner/devices/<deviceId>.json`), `extension/src/options/main.ts:222-233` (Un-pair body), `runner/scheduler/dispatch.ts`'s `runWeeklyReview`, `runner/lib/forget.ts:106` (`Object.values(API_KEY_SECRET_NAME)`, still no `github-token`).
- `pnpm check:fixtures`: exit 0.

Files touched: `docs/pilot/success-test.md`, `docs/pilot/privacy-checklist.md`. `docs/pilot/known-limitations.md` and the lesson stub needed no change (the gate review found no BLOCKING items there).

### 2026-09-25 — Part A (manual session, Sonnet)

Shipped the three pilot docs and the lesson 0003 stub, exactly the part-A
`Owns:` — nothing else touched. Branched `packet/P10-A` from
`origin/overnight/integration` at `de0019c`; re-merged it before the final
chain and it was already up to date (no drift to fix).

Sources read beyond the brief's list: P08-B (`origin/packet/P08-B`, PR #20,
not yet merged) for the schedules/catch-up mechanism and its exact UI text
(`runner/README.md`'s "Schedules and catch-up", `scheduler/dispatch.ts`,
`ui/assets/settings-schedules.js`, `ui/assets/runs.js`) — confirmed its
prompt files live at `runner/scheduler/prompts/`, not
`runner/agent/schedules/`, via `git ls-tree -r origin/packet/P08-B --
runner/scheduler`. P03.1 (`origin/packet/P03.1`, not yet merged) for the
four onboarding source modes. P07's packet Deliverables section for the
side-panel/tab-group behaviour, marked "per P07-C" throughout
`success-test.md` since that packet hasn't landed.

**Acceptance map:**
- *Each of the three pilot docs exists and covers every item listed.*
  `docs/pilot/success-test.md`: 15 numbered steps (clone/install, setup,
  doctor, runner, unpacked extension, pairing, onboarding, three captures,
  three preparations, board, session, schedule+catch-up, budget pause,
  forget), plus an "owner-gated steps and their fallback" section.
  `docs/pilot/privacy-checklist.md`: four sections (where personal data
  lives, what leaves the machine, what the catalog stores, how `--forget`
  removes each item), one checkbox line per item with a file/code-path
  proof. `docs/pilot/known-limitations.md`: grouped "the person notices" /
  "the owner notices", covering machine-off/catch-up, MV3 worker sleep, the
  carried PDF-characters item, all 18 P05.1 validator gaps, Web Store
  review, and the `chatgpt()`/mode-A conditions.
- *Every command and path exists as written; checks recorded.* Ran and
  confirmed against the merged head:
  - `grep -n '"setup"\|"doctor"\|"runner"\|"pair"\|"ui"\|"eval"\|"typecheck"\|"lint"\|"test"' runner/package.json` — all nine scripts match verbatim.
  - `grep -n '"build"' extension/package.json` and `cat extension/manifest.json` — build script and the exact six permissions / one host permission.
  - `grep -n '"typecheck"\|"test"\|"lint"\|"check:fixtures"' package.json` — root scripts.
  - `grep -n "forget\|dry-run\|keep-workspace" runner/cli/setup.ts` — the three `--forget` flags.
  - `for p in onboarding profile jobs application board sessions settings status runs; do test -f runner/ui/$p.html; done` — every linked UI page exists.
  - `grep -n "<h1\|<h2\|<button" runner/ui/{onboarding,profile,jobs,board,sessions,application,status}.html` — every quoted button/section label ("Approve career profile", "Start a session", "Prepare", "Check the model", the Budget/Schedules ids) matches the real markup.
  - `git show origin/packet/P08-B:runner/ui/assets/settings-schedules.js` and `runs.js` — schedule card labels ("Prepare newly saved jobs", "Review open applications", "Last successful run …"/"No successful run yet") and the "catch-up" badge text.
  - `git show origin/packet/P03.1:docs/spec/implementation/P03.1-onboarding-sources.md` and its `runner/README.md` diff — the four source modes and the `github-token` keychain name.
  - `extension/src/shared/storage.ts` — the `chrome.storage.session`-only claim in the privacy checklist.
- *known-limitations.md includes all 18 P05.1 items plus the carried PDF
  item.* `grep -cE "^[0-9]+\. " docs/pilot/known-limitations.md` → 18 (9
  too-loose, 9 too-strict, same order as P05.1's "Known limitations for
  P10-A"), plus a separate PDF-characters entry carried from this packet's
  own "Carried into part A" note.
- *`pnpm check:fixtures` passes, and so does the full chain.* See below.

**Chain (repo root, merged with current `origin/overnight/integration`,
head `116d3f6`):**
- `pnpm install --frozen-lockfile`: exit 0.
- `pnpm typecheck`: exit 0, 6/6 workspaces.
- `pnpm -r lint`: exit 0, 6/6 workspaces.
- `pnpm check:fixtures`: exit 0 (no offenses).
- `pnpm test`: contracts, job-assistant, runner (eval 161/161 gates) and
  extension (329 passed/5 skipped) all green. `apps/catalog`'s PGlite-backed
  integration tests (each spins up its own in-process WASM Postgres) hit the
  30 s test timeout under this machine's concurrent-agent load — a
  different 1–4 tests each run, never the same one twice, never a real
  assertion failure. This packet touches no code outside `docs/`, so
  followed this repo's documented "Slow tests" contingency
  (`logs/handoff/P06-prompt.md`'s Rules): reran
  `pnpm -r --workspace-concurrency=1 test`, which passed clean, 0 failures,
  exit 0 (229 s for `apps/catalog` alone, serialized). Also ran the file
  that had flaked most often in isolation, `cd apps/catalog && npx vitest
  run tests/learn-route.test.ts` with nothing else contending: 6/6 passed
  in 17 s. CI runs uncontended and is the authoritative check.
- `node --test scripts/*.test.mjs`: 2/2 passed.
- `git status --porcelain`: empty after the chain.

**Not touched, and why:** `apps/catalog/lib/learn.ts` builds its lesson
list from `readdirSync` on `docs/learn/lessons/` at request time (its own
comment: "a later packet's new lesson file needs no code change to
appear"), so lesson 0003 needed no catalog-index edit, and none was made.

**Open questions / unfinished:** none; nothing blocked.
