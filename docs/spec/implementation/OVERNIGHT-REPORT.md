# Overnight report: workflow-catalog MVP

**Written:** 2026-09-25, by the manual session that took over from the autonomous loop.
**Where things stand:** every MVP packet is merged into `overnight/integration`. CI is green on its head. Nothing touched `main`.
**What's left is yours:** review PR #2 (`overnight/integration` → `main`), the owner-only items below, and the first real pilot run.

## How this session worked
- **Takeover.** The loop was suspended: `.loop/state.json` `stage_status` is `paused-manual` (58f8347). No other agent was working at takeover; the newest pushed commit was about 8 hours old.
- **One gate per packet.**
  - CI green on the PR head.
  - `pnpm typecheck && pnpm test` green on the head merged with current integration.
  - Every `## Acceptance` bullet mapped to a named, passing test.
  - One fresh Opus review, which labels each finding BLOCKING or FOLLOW-UP.
  Only BLOCKING findings went back, with at most two fix rounds, each re-checked by a fresh narrow agent.
- **A check added mid-session.** P08-B's review showed that CI never builds `runner/agent`, so a PR could leave the runner unable to start while CI stayed green. From then on, every runner PR also passed the real adapter build and `eve build`. The orchestrator ran it, because agents can't set a temp HOME.
- **Integration's history.** Each packet is one squash commit plus one "done" commit (status, GOALS tick, FOLLOW-UPs). Nothing else went in.
- **Interruptions.** The session hit the provider's usage limit twice (its resets were at 13:10 and 18:10 EDT). Every agent pushed at each green step, so nothing was lost: each one was resumed with its context once the limit reset.

## Packets

Before this session, the loop had merged P00, P01, P01.1, P02, P02.1, P02.2, P03, P03.2, P04, P07-A, P07-B, P08-A, P09 and P09.1 (see PR #2). This session merged the other nine:

| Packet | PR | Gate result | BLOCKING found | Fix rounds | FOLLOW-UPs | Squash |
|---|---|---|---|---|---|---|
| P05 Preparation and validator | #16 | passed | 0 | 0 | 6 | fa66206 |
| P06.1 Jobs and Status follow-ups | #18 | passed after fixes | 1: stale and missing screenshots | 1 | 12 | 202e636 |
| P05.1 Validator follow-ups | #19 | passed | 0 (18 known limitations handed to P10-A) | 0 | 12 | cfb2a3f |
| P06 Board and sessions | #21 | passed | 0 | 0 | 16 | 3e04e01 |
| P08-B Schedules and catch-up | #20 | passed after fixes | 2: `eve build` broken by cron-less prompts under `runner/agent/schedules/`; three acceptance tests that couldn't fail | 1 | 23 | c33689a |
| P10-A Pilot docs | #22 | passed after fixes | 7: doc statements the code contradicted | 1 | 23 | 2bf591b |
| P07-C Sessions, side panel, the nine gates | #24 | passed | 0 | 0 | 15 | 98fa482 |
| P03.1 Onboarding sources | #23 | passed after fixes | 4: a page-note regression, URL import overwriting uploads, a DOCX zip bomb, a super-linear DOCX parse | 1 | 22 | 903eed3 |
| P10-B Upgrade and the full acceptance run | #25 | passed after fixes | 3, plus F11, which the orchestrator promoted: missing proofs for "stays on 0.1.0 until confirmed" and "version written last"; out-of-Owns edits; a mislabelled transcript step; Settings fetching GitHub on every load | 2 | 22 | 50016c3 |

Every packet passed its gate: no packet is `blocked`, and no fix round ran out. `overnight/integration` CI was green at faea3a4 (run 36188000551) before P10-B, and P10-B's PR head was green (run 36206232669).

## Blocks

No packet is blocked. What remains blocked is environmental or owner-gated:
- **The success-test run** (`docs/pilot/success-test-run.md`, P10-B). Steps 1, 2, 3 (except the provider line), step 5's build, and step 15 (forget, run twice) passed on a fresh clone and workspace. Everything else is recorded `blocked`, with its reason:
  - **Step 3's provider line:** no real provider account or key may be used in this session.
  - **Step 4, starting the runner, and so steps 6–14:** 127.0.0.1:3210 is held by the owner's own Convex local backend (`convex-lo`). eve's port is hard-coded (`runner/server/eve-gateway.ts:29`), and stopping someone else's process was outside this session's authority.
  - **Step 5's load:** needs branded Chrome.
  - **Steps 6–14 in general:** they also need a live model, real wall-clock time or branded Chrome.
- **The definition of done's "catalog live on Hobby at $0":** waits on the owner-gated deploy.
- **A gate miss, recorded honestly.** P08-B's review labelled F18 (a prompt file with no fixture) as a FOLLOW-UP, though it breaks a CLAUDE.md hard rule and should have been BLOCKING. It is item 2 of "Fix before the pilot" below.

## FOLLOW-UPs triage

There are 151 FOLLOW-UPs in `FOLLOWUPS.md`. None of them fails an Acceptance bullet: a finding that did was BLOCKING and was fixed before its merge. The triage sorts them by what the pilot will actually hit.

### Fix before the pilot (16)
Most are small. The first three are gaps in the process itself.

1. **CI never builds `runner/agent`.** P08-B's gate review found that `eve build` failed on the PR while CI stayed green: the runner couldn't start at all. Since then, the orchestrator or reviewer has run the real build by hand for every runner PR. Add a CI step that builds the adapter and runs `eve build` in `runner/` (no model call is needed to build). `.github/workflows/ci.yml`. *(Found by the P08-B gate; not in `FOLLOWUPS.md`, because it belongs to no packet.)*
2. **P08-B F18:** `runner/scheduler/prompts/weekly-review.md` has no fixture that pins it: emptying the file fails no test. That breaks the CLAUDE.md hard rule that every prompt-file change ships with the fixture that proves it. **The gate should have labelled this BLOCKING, and missed it.** Add the fixture.
3. **P05.1 F12:** the probe corpus contains the bare real domain `x.com` (two rows). The fixtures policy allows only `*.example`. Swap in a fictional domain of the same shape. `runner/test/fixtures/validator-probes.json`.
4. **P07-C F1:** quitting Chrome un-pairs, because pairing lives in `storage.session`. Pairing again makes a new device, and the runner then refuses every report on a session opened before the restart (`command_not_for_device`). Applied and Defer only say "mark it on the Board", yet the panel still offers them. The pilot will hit this on its second day. At the least, hide Applied and Defer on a session bound to another device and say why. Better, let the runner re-bind a session to the person's new device after an explicit confirmation.
5. **P08-B F16:** a corrupt or unreadable `scheduler/state.json` reads as "nothing paused", so a person's pause is silently dropped and the schedule spends quota. Fail closed, as the budget does. `runner/scheduler/store.ts:56`.
6. **P08-B F14 and F5:**
   - The first start of a fresh install fires both schedules as catch-ups for fires that never happened. That includes a weekly-review model turn over zero applications, which counts against the day's budget.
   - A fire that hit a provider limit, or refused every job, is recorded as a success.
   - Fix: skip catch-up before the first recorded slot, and record those outcomes truthfully. `runner/scheduler/dispatch.ts`.
7. **P10-A F7:** the success test's forget step doesn't say to stop the runner first. A live runner (the scheduler tick, the bridge) can recreate files under the workspace forget just removed. Fix the step, and consider making `forget` refuse while the runner is up.
8. **P10-A F16:** the privacy checklist's "deleting the repo leaves nothing behind" is false after `--keep-workspace`, and when eve's shared sign-in is kept (the default). Correct it.
9. **P10-A F4 and F5:**
   - Step 13 misses that weekly-review also fires on the first start, a real provider turn that counts against step 14's budget.
   - Step 14 assumes zero runs so far.
   - The owner will see different numbers than the script says. `docs/pilot/success-test.md`.
10. **P03.1 F5:** the GitHub token field is `type="text"` with no `autocomplete="off"`, so the pasted token shows in clear and stays after a failed save. Use a password field.
11. **P03.1 F16:** the GitHub import (`affiliation=owner`) includes private repositories' READMEs, the page doesn't say so, and the response has no size cap. Say it on the page and cap the read, or limit the import to public repositories.
12. **P03.1 F22:** the DOCX guard has no running-total inflate cap, unlike the ZIP path. A 10 MB DOCX of duplicate entries inflates to 979 MB before its refusal. Reuse the archive's running total. `runner/lib/document-text.ts`.
13. **The flaky unhandled rejection** in `runner/test/status-page-followups.test.ts`: `status.js` calls `showError` after the test's teardown, and parallel `pnpm test` runs fail on it with every assertion green. Three separate reviews hit it (P06.1 F11, P08-B F22, P10-A F23). Guard `showError`, or await the initial load in the test.
14. **P06 F5:** "Write to outbox" is offered for a session whose command is still queued for the browser, so the group can open twice. `create()` guards this case, but `writeOutbox()` doesn't. `runner/store/sessions.ts`.
15. **eve's port is hard-coded to 3210** (`runner/server/eve-gateway.ts:29`), which is also the default port of Convex's local backend. One is running on the owner's machine right now (`convex-lo`), so `npm run runner` can't start there. P10-B's success-test run was blocked at step 4 for exactly this reason. Make the port configurable in `.env.local`, or at least have doctor and the runner name the process holding it. *(Found by the P10-B run.)*
16. **P08-B F2 and F3:** the Settings half of carried items P-a and P-c isn't done, though P08-A's report said P-c shipped. With `runs/` unreadable, Resume answers "The runner hit an unexpected error.", and a stored pause says "Resume can't clear this pause." with no next step. `runner/ui/assets/settings-budget.js`.

### Fix before the first real release (P10-B)
The upgrade flow has nothing real to find until the first tag exists (owner-only), so none of these blocks the pilot. Each will bite on the first 0.1.x release:
- **F2:** a release with no schema migration (0.1.0 → 0.1.1) is offered but can never be applied. `applyUpgrade` throws, and Settings shows "The runner hit an unexpected error.". Treat a missing migration step as a no-op. `runner/upgrade/migrate.ts`.
- **F6:** any non-2xx from GitHub's `releases/latest` (a 403 rate limit, a 5xx) reads as "You're on the latest release.". `runner/upgrade/release-source.ts`.
- **F3:** the 0001 migration fixture lives in the production migrations directory, so a real 0.2.0 would run it. It's a no-op for today's profiles; keep it, or replace it, knowingly.
- **F1:** the release fetch is its own https transport rather than `safeFetch`. The orchestrator ratified this at merge. It reuses `isBlockedAddress` and mirrors every rule, but it has no TLS test like `safe-fetch.test.ts`. Add one, or move it onto `safeFetch`.
- **F4 and F5:** a failed migration and a malformed release tag both answer the generic 500.

### Later (the rest)
These are polish, wording, extra tests and hardening beyond Acceptance, and none blocks a pilot on the owner's own machine.
- **The validator** (P05 F1–F6, P05.1 F1–F11): the word-matching gaps. The too-loose and too-strict cases the pilot might meet are already in `docs/pilot/known-limitations.md`, the 18 from P05.1. P05 F1 ("Served as CTO" passing against a claim that reports *to* the CTO) is the one dishonest pass the docs call out. The rest are corpus completeness (round 1's probes and the realistic documents aren't pinned; the row count isn't pinned) and report accuracy.
- **The file-bridge revision gap** (P06 F1–F3, P07-C F8): the session manifest has no application revision, so a choice made on a file-imported session stays local. This needs a contract change (`SessionManifest`, the `/events` result schema). The bridge path, which is the normal one, is unaffected. It's listed in the known limitations.
- **Page polish across the runner** (P06.1 F5–F9, F12; P06 F11, F12, F15; P08-B F7–F13; P03.1 F3, F6–F11, F13, F14; P07-C F2–F4, F12, F14): clamps, focus after rare actions, raw ids in the options preview, amber for a self-chosen pause, time zones not labelled, commands not in `<code>`.
- **Test and report accuracy** (P06.1 F1–F4, F10; P06 F13; P08-B F1, F4, F19–F21, F23; P10-A F12, F14, F22; P07-C F9–F11; P03.1 F1, F2, F4, F19–F21): overclaiming test titles, missing screenshots, report counts, and proofs that exist only at the store level. P03.1 F4, the `fixtures.test.ts` edit, was ratified at merge.
- **Robustness beyond Acceptance** (P06 F6–F10, F14, F16; P08-B F6, F15, F17; P07-C F5–F7, F13, F15; P03.1 F8, F15, F17, F18):
  - DST drift in schedules;
  - at-most-once schedule slots;
  - PDF parsing continuing after its time budget;
  - `storage.local` records never pruned;
  - a restored tab reported as `closed` on Refresh;
  - `runner/validate/` missing from the build stamp.
- **Docs** (P10-A F1–F3, F6, F8–F11, F13, F15, F17–F21; P06 F4): the success test's setup prompts and Chrome UI wording, the catalog fallback, what the catalog does keep (display name, checklist ticks, hashed invite tokens), and lesson 0002's link to 0003.

## The three riskiest assumptions
1. **That the flows work with a real model.**
   - Every test, eval and review in this build used scripted models. Onboarding extraction, job extraction, preparation (with its refuse-and-fix revision loop), the weekly review and the model check have never run against the live ChatGPT provider end to end. P02's spike proved only that `chatgpt()` answers under `eve start` in mode A.
   - Three things are unverified:
     - that a real model converges through the validator's refusals in one turn;
     - how long that takes, and what it costs in quota;
     - that eve surfaces provider limits the way §8 item 15 says.
   - The success-test run here couldn't reach the model steps (see Blocks).
2. **That a word-matching validator is an adequate honesty guarantee.**
   - The promise "every sentence cites a confirmed claim, and no number, date or title goes beyond it" rests on a deterministic, rule-based matcher.
   - Its known gaps are documented: 18 items in `docs/pilot/known-limitations.md`, 9 of them too loose, including "Served as CTO" passing against a claim about reporting *to* the CTO.
   - The pilot needs a human read of every exported document. The validator lowers the risk; it doesn't remove it.
3. **That the browser half holds up in real Chrome, on a real laptop.**
   - The nine gates are automated on bundled Chromium only. Branded Chrome, real sleep, a real restore, and a second profile are a manual checklist (`extension/MANUAL-GATES.md`) nobody has run yet.
   - Two known edges will show early:
     - pairing lives in `storage.session`, so quitting Chrome un-pairs, and existing sessions are then refused (fix-before-pilot item 4);
     - the fixed loopback ports (3210 for eve, 4310 for the bridge) collide with other local tools; your Convex backend holds 3210 today (item 15).

## What to test first
1. **Free port 3210** (stop the Convex local backend) and run `docs/pilot/success-test.md` steps 4–14 on this machine, with your real ChatGPT sign-in. That's the first live-model run of the whole flow.
   - Step 10, preparing an application, carries the most risk. Time it, and read every exported sentence against the claims it cites.
2. **Mid-session, quit and reopen Chrome, then pair again.** See what the side panel does with the open session (item 4).
3. **Run forget with the runner stopped** (`npm run setup -- --forget` per `docs/pilot/success-test.md` step 15), and confirm the workspace, `.env.local` and the keychain entries are gone (items 7 and 8).
4. **Walk `extension/MANUAL-GATES.md` in branded Chrome**, including a laptop sleep across the 15-minute poll.
5. **After the first release tag exists:** Settings → "Check for updates". It should contact nothing until you press it.

## Owner-only (no action was taken on any of these)
- **Review and merge PR #2** (`overnight/integration` → `main`). Nothing in this session touched `main`.
- **The catalog deploy:** a Vercel project with root `apps/catalog`, Neon free through the Marketplace, `OWNER_SECRET`, `SESSION_SECRET` and `DATABASE_URL`, Deployment Protection off. Then `vercel pull` → `vercel build` → `vercel deploy --prebuilt`. See `apps/catalog/README.md`. Until then, the "catalog live on Hobby at $0" item of the definition of done is open.
- **The first release tag,** `job-assistant@0.1.0`. It runs `.github/workflows/release-package.yml`. The upgrade flow has nothing real to find until a release exists.
- **The Chrome Web Store:** developer registration and a private listing. The unpacked install covers the pilot.
- **No new paid service** was added. Hosted spend is still $0.
- **Decisions still open from earlier:** the currency reading (USD before tax); a tag-push deny rule in `.claude/settings.json`; renaming the `RUNNER_*` environment variables before the first release (GitHub Actions sets `RUNNER_WORKSPACE`); and `minimumReleaseAgeStrict`.
