# P10 · Package versioning, upgrade, and pilot readiness

Status: claimed (part A)
Assignee: manual session (Sonnet), part A
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
