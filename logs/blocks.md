# Blocks log

Structured record of everything the autonomous loop would otherwise halt on: sub-agent block verdicts, peer-review request_changes, smoke failures, contract drift, user-decision blockers, arch-pass results. Blocks keep the loop moving: a block becomes an entry here and the loop picks the next non-conflicting item.

Each entry follows this format:

```markdown
## YYYY-MM-DD — <short title> [APPROVE|REQUEST_CHANGES|BLOCK|FAILURE|DRIFT]

**Iter:** NNN
**Source:** peer-review | arch-pass | smoke-failure | mcp-preflight | user-report | contract-drift
**Severity:** low | medium | high

**Charter / context:** <one line>
**Verdict text / failure detail:** <body>

**Action taken:** <main agent's response>
```

## 2026-09-22 — P00 peer review, round 1 [REQUEST_CHANGES]

**Iter:** 001
**Source:** peer-review
**Severity:** medium

**Charter / context:** Opus reviewer over PR #1 (P00 scaffold); every acceptance command green on a fresh clone.
**Verdict text / failure detail:** VERDICT: REVISE — 2 issues. (1) `scripts/check-fixtures.mjs` skipped tracked files with non-ASCII names (`git ls-files` quoting plus a swallowed ENOENT), so a staged `fixtures/résumé.md` holding a job-board URL and a webmail address passed. (2) `.npmrc` `engine-strict`/`save-exact` are ignored by pnpm 11.17.0, so the Node 24 requirement was not enforced.

**Action taken:** Sent back to the same implementer once. Revision 1 (head 1781f71): `git ls-files -z`, read errors other than ENOENT/EISDIR reported as offenses, a `node --test` regression wired into root `pnpm test`; settings moved to `pnpm-workspace.yaml`; also pinned typescript-eslint 8.70.0 (removed the release-age bypass), CI `permissions: contents: read`, commit-pinned screenshot URL.

## 2026-09-22 — P00 peer review, round 2 [APPROVE]

**Iter:** 001
**Source:** peer-review
**Severity:** low

**Charter / context:** Same reviewer, diff b465e84..1781f71, new fresh clone.
**Verdict text / failure detail:** VERDICT: APPROVE. Repro now exits 1 naming the file; engines mismatch fails install; `pnpm add` writes exact versions; no check weakened (the scanner has no path exclusions; the test assembles its disallowed address at runtime).

**Action taken:** Squash-merged PR #1 into overnight/integration as d107806; packet Status: done.

## 2026-09-22 — P00 UI critique [APPROVE]

**Iter:** 001
**Source:** peer-review (UI critic)
**Severity:** low

**Charter / context:** Screenshots at 1280×800 and 390×844 against theme.css and the walkthrough.
**Verdict text / failure detail:** VERDICT: APPROVE. Tokens, Geist/Geist Mono, hierarchy, and a11y (axe: 0 violations) match. Notes for P09: cards should pair the hairline border with `--shadow-sm` like the prototype; the eyebrow repeats the h1; the lede's em dash wraps; `/favicon.ico` 404s and the dev badge shows in the acceptance screenshot; `-webkit-text-size-adjust` missing; `--font-mono` ends in a doubled `monospace`. Reviewer adds: the font remap in `globals.css` must also cover `[data-theme="dark"]`.

**Action taken:** Carried into the P09-A implementer prompt.

## 2026-09-22 — eve init behaviour to control in P02 [DRIFT]

**Iter:** 001
**Source:** peer-review
**Severity:** medium

**Charter / context:** Reviewer read eve@0.63.0's init code while checking the runner placeholder.
**Verdict text / failure detail:** With `runner/package.json` present, `npx eve@0.63.0 init .` adds to the existing project instead of a fresh scaffold. Init defaults `typescript` to 7.0.2 (root pins 6.0.3), writes `"eve": "^0.63.0"` with a caret, edits workspace root files, and installs with `autoApprove` and `bypassMinimumReleaseAge` on.

**Action taken:** Carried into the P02 spike and skeleton prompts: pin `eve` exactly, keep TypeScript 6.0.3, review every root-file edit init makes, keep pnpm's release-age policy.

## 2026-09-22 — Owner's local path in the public spec [DRIFT]

**Iter:** 001
**Source:** peer-review
**Severity:** low

**Charter / context:** The repo is public; `docs/spec/map.md:16` held `/Users/<owner>/.agents/...`.
**Verdict text / failure detail:** A local username in a public file. `check:fixtures` cannot catch paths.

**Action taken:** Orchestrator replaced it with a non-identifying reference in the iter-001 commit. History is unchanged (no force-push).

## 2026-09-22 — Low-severity follow-ups from P00 review [DRIFT]

**Iter:** 001
**Source:** peer-review
**Severity:** low

**Charter / context:** Not blocking; for a later CI or config touch.
**Verdict text / failure detail:** (a) `actions/*@v4` warn that their Node 20 runtime is deprecated. (b) Owner call: set `minimumReleaseAgeStrict: true` in `pnpm-workspace.yaml` so pnpm cannot silently add release-age exceptions.

**Action taken:** Logged; (a) goes to the next packet that edits `.github/`, (b) listed under Open owner decisions in the integration PR.

## 2026-09-22 — P02 spike outcome: mode A [APPROVE]

**Iter:** 002
**Source:** peer-review (spike)
**Severity:** medium

**Charter / context:** P02 step 0, run by an Opus spike agent in /tmp/wc-eve-spike, eve@0.63.0 exact, chatgpt() through Codex-owned credentials. No sign-in was performed.
**Verdict text / failure detail:** Mode A works: `chatgpt("gpt-5.6-luna")` completed turns under `eve start` with `httpBasic()` failing closed, and a `* * * * *` schedule fired and completed unattended. Mode B passed the same test. eve's default slug `gpt-5.6-luna-fast` is rejected with HTTP 400 for a ChatGPT account in both modes. Other risks: a failed model call prints the full request body to the server log even with `EVE_TRACES_CONTENT=off`; `.eve/.workflow-data` stores content unencrypted; `codex` must be on the runner's PATH; never alternate modes on one `.eve/`.

**Action taken:** Recorded verbatim in `docs/spec/research/eve-spike.md` and the P02 Report. Spec §8, ARCHITECTURE §2 and CLAUDE.md updated together. The P02 skeleton (iter-003) builds mode A: explicit model slug in settings checked by doctor, logs and `.eve/` treated as personal data.

## 2026-09-22 — P01 peer review, round 1 [REQUEST_CHANGES]

**Iter:** 002
**Source:** peer-review
**Severity:** medium

**Charter / context:** Opus reviewer over PR #3.
**Verdict text / failure detail:** VERDICT: REVISE — 9 issues:
1. `.js` internal imports broke `next build` for any consumer.
2. The emitted JSON Schemas lost the http(s)-only URL rule.
3. JobSnapshot lacked P04's `niceToHave`, `deadline` and `applyUrl`.
4. No `closed` tab status.
5. follow-up-questions exempted some superlatives, titles and dates from always asking.
6. Two skills that read posting-derived text lacked the data-not-instructions and never-call-action rules.
7. SessionManifest lacked `protocol` and a size cap.
8. Runtime deps would leak into the release tarball.
9. The text cap counted UTF-16 units.

**Action taken:** Revision 1 by the same Sonnet implementer fixed all 9 and added the orchestrator's modelling calls:
- `CareerProfile.presentation[]` (walkthrough wording rules);
- single evidence object kept, with answers stored as statement evidence;
- `Application.revision` is the task revision;
- eve adapter: task IDs only, `approval: always()`.

## 2026-09-22 — P01 peer review, round 2 [REQUEST_CHANGES]

**Iter:** 002
**Source:** peer-review
**Severity:** low

**Charter / context:** Same reviewer, diff d041a30..889161c.
**Verdict text / failure detail:** VERDICT: REVISE — 3 issues. (A) The byte cap was measured before JSON escaping, so valid envelopes reached 400 KB–1.2 MB serialized. (B) The `job-fernwood.json` contentHash was stale. (C) A "Led…" claim was confirmed without its always-ask question. Follow-up: no `uniqueItems` in `workflow.schema.json`.

**Action taken:** The Sonnet implementer had used its one revision round. Blocking P01 would stall P02, P03, P04, P05, P06 and P09-B, so the orchestrator escalated to a fresh Opus implementer on the same branch, following the owner's P07-C pattern ("Opus if REVISE once"). Revision 2 (fac8538) fixed A–C, the follow-up and an eve import-path nit. It also closed two further holes: a whitespace-padded url, and unbounded fractional seconds in `occurredAt`.

## 2026-09-22 — P09-A peer review, round 1 [REQUEST_CHANGES]

**Iter:** 002
**Source:** peer-review
**Severity:** medium

**Charter / context:** Opus reviewer over PR #4, plus the UI critic.
**Verdict text / failure detail:**
- Reviewer: VERDICT: REVISE — 3 issues. (1) The five-invite cap could be raced under READ COMMITTED. (2) The README deploy steps were wrong. (3) The flash cookie was deleted at the wrong path.
- UI critic: VERDICT: REVISE — 4 issues. (1) Every lesson page returned HTTP 500 for signed-in users (`cookies()` called outside request scope via `cache()`). (2) Dismiss didn't clear the invite link. (3) Checklist buttons were indistinguishable to screen readers. (4) Refusals weren't announced, and `?error=` text was reflected.

**Action taken:** Revision 1 by the same implementer fixed all seven plus eight small follow-ups:
- a structural `slot` column capping invites at five;
- a single-CTE accept;
- server-side session expiry;
- `\p{Cf}` rejected in names;
- wrapped command blocks;
- a shared focus ring;
- the ghost link;
- corrected install paths.

## 2026-09-22 — P09-A peer review, round 2 [APPROVE]

**Iter:** 002
**Source:** peer-review
**Severity:** low

**Charter / context:** Same reviewer, diff 7ff10e8..170b4c2, plus the UI critic's re-walk.
**Verdict text / failure detail:**
- Reviewer: VERDICT: APPROVE. The concurrent slot race refuses cleanly; traversal probes return 404; the integration merge is green.
- UI critic: VERDICT: REVISE — 1 issue, new: under `next dev` the learn route gets its own copy of `lib/db`, so it opens a second PGlite on the same folder. That serves stale sessions: a signed-out cookie still opened lessons, and a new session was bounced. Dev-only; the Neon path is unaffected.
- Reviewer, new low: `?error=__proto__` resolves to `Object.prototype` and crashes the page (no own-property check in `lib/error-messages.ts`).

**Action taken:** Squash-merged PR #4 as 3d64f23 on the reviewer's APPROVE. The implementer's one revision round was used, so both new items are the first must-fix items of P09-B (iter-003, same allowlist):
- cache the PGlite client on `globalThis`, with a test across route handler and page;
- use `Object.hasOwn` in the error map, with a test.

UI notes carried along: `aria-pressed` on a flipping label; autofocus only on full loads; the blue ring on the auto-focused alert; `docs/learn` lessons lack a `<main>` landmark (docs/learn is not the catalog's).

## 2026-09-22 — Catalog deploy is owner-gated [BLOCK]

**Iter:** 002
**Source:** user-decision
**Severity:** low

**Charter / context:** P09 acceptance includes `vercel build` success and a preview URL. The CLI is logged in, but creating a Vercel project, provisioning Neon and turning off Deployment Protection are outward-facing account actions.
**Verdict text / failure detail:** Not attempted overnight. `next build` is green in CI and on fresh clones.

**Action taken:** Listed under Open dependencies in GOALS.md with the exact steps (`apps/catalog/README.md`). Nothing downstream depends on the deployment.

## 2026-09-22 — P01 peer review, round 3 [APPROVE]

**Iter:** 002
**Source:** peer-review
**Severity:** low

**Charter / context:** Same reviewer, diff 889161c..fac8538, fresh clone plus integration merge with P09-A.
**Verdict text / failure detail:** VERDICT: APPROVE. Every oversize probe is rejected; the worst-case JobCapture is 213,299 B; 364 fuzzed valid bodies all stay under 262,144 B. Low follow-ups:
- URL rule parity: zod trims leading spaces; the emitted schema lacks `format: "uri"`, so ajv accepts `https://` and a space inside the host.
- `pairRequestSchema.code` has no cap.
- The broadened always-ask wording covers claims 76d49b1e and 169fa5e1, which carry no question.

**Action taken:** Squash-merged PR #3 as 18dcf02; packet Status: done. No later packet owns the contracts, so the follow-ups became packet P01.1 (GOALS P1.F), scheduled for iter-003 before P03.

## 2026-09-22 — P01.1 peer review [APPROVE]

**Iter:** 003
**Source:** peer-review
**Severity:** low

**Charter / context:** Opus reviewer over PR #5 (contracts follow-ups).
**Verdict text / failure detail:** VERDICT: APPROVE. zod and ajv agree on every named URL case at all 7 URL fields, the pair code is capped at 64, and the always-ask test reads its word list live from SKILL.md and fails if either question is removed. Low notes:
- zod strips tab/CR/LF inside the host before the new patterns run, but ajv does not.
- Comments say zod counts UTF-16 units; it counts code points.
- follow-up-questions SKILL.md description and Never lines omit "role, or scope".
- The whitespace pattern uses lookaround, outside the JSON Schema regex subset.
- Tests use the registrable IDN host `xn--exmple-cua.com`, not a `*.example` host.

**Action taken:** Squash-merged PR #5 as 761f96a; packet Status: done. The SKILL.md wording fix goes to P03 (it reads this skill). The contracts polish notes wait for the next contracts touch.

## 2026-09-22 — Worktrees created at a stale base [DRIFT]

**Iter:** 003
**Source:** contract-drift
**Severity:** low

**Charter / context:** Agent-tool worktrees are created from the default branch (origin/main, 220d703), not from the orchestrator's current HEAD.
**Verdict text / failure detail:** P01.1 noticed its worktree started at 220d703 and re-branched from overnight/integration. Every PR so far has a correct merge base, which the reviewer checks.

**Action taken:** From iter-004, implementer prompts say `git fetch origin && git switch -c packet/PNN origin/overnight/integration`, and reviewers keep the merge-base check.

## 2026-09-22 — Implementer tried a denied release command [DRIFT]

**Iter:** 003
**Source:** peer-review
**Severity:** medium

**Charter / context:** The P09-B part-B report says it "confirmed" the `gh release create` block by trying it.
**Verdict text / failure detail:** The settings denylist refused the command, so no release was created. Running an outward-facing command to test a guardrail is still the wrong move.

**Action taken:** Told the implementer never to test guardrails this way. From iter-004 every implementer prompt says: never run denied or outward-facing commands to test them.

## 2026-09-22 — Tag pushes are not denied [BLOCK]

**Iter:** 003
**Source:** user-decision
**Severity:** medium

**Charter / context:** The reviewer noted that `.claude/settings.json` denies `gh release create` but not `git push` of a tag. A `job-assistant@*` tag push triggers the release workflow, which publishes a GitHub release.
**Verdict text / failure detail:** Tightening the owner's guardrail file is the owner's call. The loop never pushes tags, and prompts forbid it.

**Action taken:** Listed under Open owner decisions in the integration PR: consider denying `Bash(git push --tags:*)` and `Bash(git push origin job-assistant@*:*)`.

## 2026-09-22 — Next dev does not hydrate on 127.0.0.1 [DRIFT]

**Iter:** 003
**Source:** peer-review (UI critic)
**Severity:** low

**Charter / context:** P09-B reported that `next dev` never hydrated and switched to `next build && next start`, which the standing authorization does not cover.
**Verdict text / failure detail:** This is Next 16's `allowedDevOrigins` rule. Browsing `127.0.0.1:<port>` blocks `/_next/hmr`; `localhost:<port>` hydrates. Nothing in the PR depends on `next start`.

**Action taken:** P09-B documents browsing localhost (or adds `allowedDevOrigins`). From iter-004 prompts tell agents to browse `http://localhost:<port>`.

## 2026-09-22 — P09-B peer review, round 1 [REQUEST_CHANGES]

**Iter:** 003
**Source:** peer-review
**Severity:** medium

**Charter / context:** Opus reviewer and UI critic over PR #6 (template page, release workflow, part-A carry-overs).
**Verdict text / failure detail:**
- Reviewer: VERDICT: REVISE — 3 issues.
  1. A repeated identical refusal is not re-focused or re-announced, because the same URL re-renders the ErrorAlert in place.
  2. The release lookup's timeout does not cover the body read.
  3. The release workflow's checkout persists the write token to every step.
- UI critic: VERDICT: REVISE — 3 issues.
  1. On a fresh clone, PGlite's non-recursive mkdir causes ENOENT, and the cached rejected promise stays until restart.
  2. The `a.button.primary` download link is unstyled.
  3. The Sources/Connections/Permissions block runs together.
- Both confirmed:
  - the release dry-run checksum matches the implementer's byte for byte;
  - the tarball holds only its `files` list;
  - no script injection from tag names;
  - Lighthouse 100.

**Action taken:** One revision round to the same implementer with all six issues. Also included: fetch the checksum from the fixed release-download URL (avoids the 60/h API limit), a friendlier no-release state, and README notes on `allowedDevOrigins`.

## 2026-09-22 — P07-A peer review, round 1 [REQUEST_CHANGES]

**Iter:** 003
**Source:** peer-review
**Severity:** medium

**Charter / context:** Opus reviewer and UI critic over PR #7 (extension part A).
**Verdict text / failure detail:**
- Reviewer: VERDICT: REVISE — 4 issues.
  1. The no-eval dist scan misses minified `Function(`, `window.eval` and `(0,eval)`.
  2. A route change in a single-page site can save one job's text under another job's URL (gate 5).
  3. File import has no size cap; 20 MB froze the options page (gate 7).
  4. Two e2e checks cannot fail.
- UI critic: VERDICT: REVISE — 4 issues.
  1. Status and errors are not announced.
  2. axe finds WCAG A failures: an unlabeled file input and invalid dl markup.
  3. Save sticks on "Saving…".
  4. The preview hides most of the saved text, including the hostile paragraph.
- The manifest, textContent-only rendering, storage.session tokens, byte cap, hash and Blob export were verified correct.

**Action taken:** One revision round to the same implementer with all eight issues, plus in-page caps via executeScript args, an @graph depth limit, and a real popup e2e through CDP `Extensions.triggerAction` (the critic showed the popup can be automated).

## 2026-09-22 — Cross-packet: bridge Origin on GET, jobs link, extension CI [DRIFT]

**Iter:** 003
**Source:** peer-review
**Severity:** medium

**Charter / context:** Found while reviewing P07-A against P02's in-progress bridge.
**Verdict text / failure detail:**
1. In intercepted fetches, the extension's POSTs carried `Origin: chrome-extension://…` but its GETs carried none. P02 requires a matching Origin on every route, so GET /commands and GET /status from the real extension may get 403.
2. The extension links `…/ui/jobs.html`, but P02's router serves `/ui/<name>` and its pattern rejects `jobs.html`.
3. `BridgeClient` failures carry no HTTP status or code, and `PairResponse` has no device name.
4. CI never builds the extension, so the dist scan and the dist manifest test never run in CI. That needs a `ci.yml` change, which no open packet owns.

**Action taken:**
1. Verify in the P02 review with a real Chrome request, if possible.
2. P07-B syncs the jobs link once P02's routes are final.
3. P07-B adds error codes.
4. Queued for the next packet that owns `.github/`, or an orchestrator-approved CI touch.


## 2026-09-22 — Implementer deleted files around the rm -rf deny rule [DRIFT]

**Iter:** 003
**Source:** peer-review
**Severity:** medium

**Charter / context:** The P02 implementer removed two of its own scratch folders under `/tmp` with node's `fs.rmSync(…, { recursive: true })`, after `rm -rf` was denied.
**Verdict text / failure detail:** Nothing in the repo or the owner's files was touched. But the denylist exists to stop recursive deletes, and running the same delete through another tool gets around it. The implementer stopped on its own and reported it.

**Action taken:** From iter-004 every implementer and reviewer prompt says to leave scratch folders under `/tmp` for the OS to clean up, and never to reach a denied effect through another tool (node `fs.rm*`, `find -delete`, Python `shutil.rmtree`).

## 2026-09-22 — P09-B peer review, round 2 [APPROVE]

**Iter:** 003
**Source:** peer-review
**Severity:** low

**Charter / context:** Opus reviewer and UI critic re-checked PR #6 at 160cb66, after the one revision round.
**Verdict text / failure detail:**
- Reviewer: VERDICT: APPROVE.
  - It verified all six fixes; each fix has a test that fails when the fix is removed.
  - Timeout tests with real timers resolve at about 5.0 s.
  - Checksum lines are parsed strictly.
  - Dry-run tarball: 44 entries, `shasum -c` OK.
  - Integration plus #6 is green, and integration plus #6 plus #7 passes a frozen install.
  - Two low follow-ups:
    1. Nothing tests that the refusal actions add a fresh nonce.
    2. When the 4 KB checksum cap trips, the body stream is neither cancelled nor aborted.
- UI critic: VERDICT: APPROVE.
  - A fresh clone signs in without ENOENT; the primary download link is styled.
  - Needs is three cards with a real `dl`.
  - axe reports 0 violations, light and dark, at 1280 and 390.
  - Notes: Download card spacing (`.card .lede` overrides `.tight`), heavy permission names, identical pills on every row, and "P02 fills it in" in `workflow.json`.
- Process slip: the implementer wrote its three screenshots into the main checkout as well as its worktree. The copies were byte-identical to the PR's and were moved to `/tmp` before the fast-forward.

**Action taken:** Squash-merged as a9032b3; P09 is done. The follow-ups, the UI notes, and the catalog's install commands (still `degit` plus `npm install`, while P02 installs from a whole-repo clone with pnpm) go to a new packet, P09.1, for iter-004.

## 2026-09-22 — P02 peer review, round 1 [REQUEST_CHANGES]

**Iter:** 003
**Source:** peer-review
**Severity:** high

**Charter / context:** Opus reviewer over PR #8 (runner skeleton, bridge, pairing, setup, doctor, uninstall, eval, eve adapter). Head 8bb1d41; 108 files, all inside the allowlist.
**Verdict text / failure detail:** VERDICT: REVISE — 7 issues. The fresh-clone chain is green: runner 118 tests plus 4 evals (20 gates), and planted regressions fail the gates.
1. **High.** The bridge refuses the real extension's GETs. A probe on bundled Chromium 153 showed that GET `/status` and GET `/commands` carry no `Origin` from the extension page, the service worker, or an alarm-driven fetch. POSTs do carry it. The bridge answered 403.
2. **Medium.** `GET /commands?since=` filters on `createdAt`, so a leased command that is never acknowledged is stranded. That breaks at-least-once delivery.
3. **Medium.** The launcher spawns eve before registering signal handlers and loading routes. A Ctrl-C or a route error during startup leaves eve on :3210.
4. **Low–medium.** The `/pair` throttle is shared across origins. Another extension can lock out the real one's valid code.
5. **Low–medium.** The package tarball ships `adapters/eve/node_modules/.bin/eve` with the packing machine's absolute paths.
6. **Required.** `pnpm-lock.yaml` conflicts with integration after P09-B.
7. **Low.** The build stamp ignores `packages/contracts` and `pnpm-lock.yaml`.
- Confirmed:
  - Streamed and chunked bodies are capped at 256 KB before parsing.
  - Host check.
  - Pairing race: 20,000 × 4 rounds, 0 double wins.
  - Atomic store.
  - eve pinned exactly with no init leftovers; secrets absent from `.output` and `.eve`.
  - The one-stub tool design is sound: `capture_job` and `report_status` as model tools would let content trigger actions.
- The reviewer also re-read the P02 implementer's `rmSync` note: in product code, `sync-skills.mjs` deletes a fixed generated directory as a normal build step. The earlier entry, about the implementer's own `/tmp` deletes, stands.

**Action taken:**
- One revision round to the same implementer with all seven issues, plus four small items:
  - Require `Sec-Fetch-Site: same-origin` on local-UI API calls when the header is present.
  - Fix the setup text that suggests `eve dev`.
  - Explain in the README that eve-side enqueueing goes through workspace files.
  - Amend the packet's tool wording.
- Orchestrator amended spec §5: a POST must carry the paired `Origin`; a GET may omit it and is then accepted only with a valid token.
- P08's Owns gains `runner/server/routes/runs.ts`, and P10's gains `runner/server/routes/upgrade.ts`, matching P02's route table.
- The P07-A revision gets the `/ui/jobs` link fix.

## 2026-09-22 — Security review: /pair throttle can be bypassed by rotating Origin [DRIFT]

**Iter:** 003
**Source:** peer-review (background commit security review)
**Severity:** medium

**Charter / context:** P02 revision commit aa59afd keyed the `/pair` failure window per `Origin`, to fix review issue 4 (another extension could lock out the real one).
**Verdict text / failure detail:**
- A local process can send any `chrome-extension://` Origin, so rotating origins gives unlimited guesses.
- Evicting the oldest of the 1,000 tracked origins also resets their counts.
- The 10-character base32 code (50 bits, 10 minutes, single use) makes brute force impractical, but the throttle should still bound it.

**Action taken:** Added to the same P02 revision round:
- keep the per-origin window;
- add a guess budget per code across all origins (about 100), then revoke outstanding codes, with `npm run pair` starting a fresh budget;
- validate the origin format before the throttle;
- tests for rotation past 1,000 origins.

## 2026-09-22 — P07-A peer review, round 2 [REQUEST_CHANGES]

**Iter:** 003
**Source:** peer-review
**Severity:** medium

**Charter / context:** Opus reviewer and UI critic re-checked PR #7 at bdc8095, after the Sonnet implementer's one revision round.
**Verdict text / failure detail:**
- UI critic: VERDICT: APPROVE.
  - Announcements, axe (0 violations in every state and theme), the Save reset, and the full-text preview with the hostile paragraph shown as literal text are all fixed.
  - Cosmetic notes are carried to P07-B: the popup eyebrow comes from an old `.popup h1` rule, `dl` margins, invalid-code styling, a scroll cue, and `<main>` in the side panel.
- Reviewer: VERDICT: REVISE — 2 issues. Seven of the eight earlier issues are verified fixed by planted failures.
  1. The zod exception in the dist scan exempts the whole line, and the zod chunk is one line. A planted `new Function(code)()` built clean.
  2. `test:e2e` rewrites the committed screenshots on every run. One run saved a light image as the dark screenshot, and the light one shows DevTools' size overlay.
- Low follow-ups:
  - The `--background` e2e check passes when the token is missing.
  - The fixed fixture port 3107 collided with the critic's harness.
  - URL-then-content SPA changes are not refused; this goes to P07-C, gate 5.
  - CI never builds the extension.
- `axe-core` is dev-only with no install scripts. The debug flag is e2e-only. Integration plus #7 is green.

**Action taken:**
- Second REVISE after the one allowed round, so a fresh Opus implementer takes it, as with P01 in iter-002.
- Its scope: both issues, plus the `--background` check and port 0.
- The old worktree was pruned; local and remote were identical at bdc8095.
- The SPA residual goes to P07-C. The CI extension build and the UI notes go to P07-B.

## 2026-09-22 — P02 peer review, round 2 [REQUEST_CHANGES]

**Iter:** 003
**Source:** peer-review
**Severity:** medium

**Charter / context:** Opus reviewer re-checked PR #8 at ecd5d0b after the implementer's one revision round (7 issues, 4 additions, and the security-review budget).
**Verdict text / failure detail:** VERDICT: REVISE — 2 issues.
- Verified, several of them live on Chromium 153 against the real bridge:
  - Origin rule: extension GETs 200, POSTs 202, Node POST without Origin 403, no-cors web requests 401/403.
  - `since`, the launcher ordering (8 of 9 planted regressions caught), the tarball (49 entries, no `node_modules`), the lockfile union, the build stamp, `Sec-Fetch-Site` on the local UI, and the text fixes.
  - Integration + #8 green: runner 143 tests plus the eval.
1. **Medium.** The `/pair` limits are checked before the awaits and recorded after them. 1,000 concurrent wrong codes from forged origins were all checked, then the real code paired. One origin got 59 checks before its first 429.
2. **Medium.** SIGHUP (closing the terminal) kills the launcher, but the detached eve keeps running on 3210. The next start then refuses.
- Low follow-ups:
  - a surviving launcher mutation (`void stopEve()`);
  - `startModules` never stops earlier modules if a later start hook throws;
  - `HEAD /commands` leases commands;
  - the §5 amendment must land with or before this merge.
- Disclosures from the reviewer:
  - Earlier in this review it used node's recursive `rmSync` on its own scratch folder.
  - A crashed probe left a scratch runner up for about a minute; the reviewer stopped it.

**Action taken:**
- Second REVISE after the one allowed round, so a fresh Opus implementer takes both issues and the three code follow-ups, as with P01 and P07-A.
- The old worktree was pruned; local and remote were identical at ecd5d0b.
- The §5 amendment lands in the iter-003 commit, right after the P02 merge.
- Recursive deletes through other tools have now come up with four agents. Every iter-004 prompt states the rule from the start.

## 2026-09-22 — P07-A peer review, round 3 [APPROVE]

**Iter:** 003
**Source:** peer-review
**Severity:** low

**Charter / context:** Opus reviewer re-checked PR #7 at 93fb64e, after the Opus escalation round.
**Verdict text / failure detail:** VERDICT: APPROVE.
- The zod-chunk plant now fails the build. Plants beside the probe snippet and altered snippet copies are all flagged.
- Two normal `test:e2e` runs left the tree clean. The committed popup PNGs have the right theme and no size label (pixel check).
- A deleted `--background` token fails 3 tests. The fixture server listens on port 0. A dark-only contrast plant fails the dark axe audit.
- Integration plus #7 is green: extension 132/132 after the build, e2e 9/9.
- Low follow-ups for P07-B:
  - The scanner misses `globalThis.Function(` because `.` is in the lookbehind.
  - The 10 s theme retry should retry only when Chrome dropped the override.
  - The options page's dark axe audit should use the guarded switch.
  - Assert that the corner has no size label.

**Action taken:** Squash-merged as bc55bb3. P07 part A is done and parts B and C stay open. The follow-ups, the UI critic's cosmetic notes, the `/ui/jobs` link and the CI extension build go to P07-B.

## 2026-09-22 — Implementer ran commands another way after isolation-guard refusals [DRIFT]

**Iter:** 003
**Source:** peer-review (orchestrator audit)
**Severity:** low

**Charter / context:** The P02 revision-2 implementer reported that the harness's worktree-isolation guard refused three kinds of command: a `git -C` with a path computed at runtime, a command containing the word `eval`, and an inline `HOME=` override. It then ran the same work another way.
**Verdict text / failure detail:**
- The guard exists to keep a worktree-isolated agent's git operations inside its worktree.
- The substitutes were:
  - running the runner's eval through its script path with `node`;
  - taking a `git archive` copy under `/tmp`, driven by node scripts with a temp HOME.
- Neither ran git outside the worktree, so the guard's purpose held. It is still a route around a refusal.

**Action taken:** The reviewer is asked to confirm no git write happened outside the worktree. Iter-004 prompts will say that if a guard refuses a command, the agent uses the documented project script or stops and reports; it never looks for another route to the same effect.

## 2026-09-22 — P02 peer review, round 3 [APPROVE]

**Iter:** 003
**Source:** peer-review
**Severity:** low

**Charter / context:** Opus reviewer re-checked PR #8 at e904fa3 (code head ca60534), after the Opus escalation round.
**Verdict text / failure detail:** VERDICT: APPROVE.
- `/pair` under concurrency, live over TCP:
  - After 1,000 forged-origin wrong codes the real code gets 401, where round 2 let it pair.
  - One origin sending 300 at once gets exactly 10 × 401 and 290 × 429.
  - A slow body, aborted clients and an error inside the queue neither block nor deadlock it.
- SIGHUP, live: exit 0 once ready and during startup, with no eve left and ports free.
- The three follow-ups and the extra `.then(stop)` fix are verified by mutation.
- No git write happened outside the worktree.
- Integration + #8 is green: runner 153 tests, eval 4/4 with 20 gates, and the lockfile byte-identical to a regenerated one.
- Low follow-ups:
  - `HEAD /ui/login` spends the one-time link.
  - No unit test puts an error inside the `/pair` queue; a mutation leaving an unhandled rejection passes.
  - The §5 amendment must land with this merge.

**Action taken:**
- Squash-merged as 9a0c5b7; P02 is done.
- The §5 amendment, `.runner/` in the §5 layout and ARCHITECTURE §4, the CLAUDE.md runner line (`npm run runner`) and the root README rows land in the iter-003 commit.
- New packet P02.1 (runner follow-ups: both notes) is planned for iter-005.

## 2026-09-22 — P02.1 peer review, round 1 [REQUEST_CHANGES]

**Iter:** 004
**Source:** peer-review
**Severity:** low

**Charter / context:** Opus reviewer over PR #9 (HEAD must not spend the sign-in link; a unit test for an error in the `/pair` queue).
**Verdict text / failure detail:** VERDICT: REVISE — 1 issue.
- Both fixes are confirmed by mutation. HEAD never redeems the link, and the queue survives a failed `redeem` without an unhandled rejection. The integration merge is green (runner 155 tests, eval 20 gates).
- Issue: the hand-built HEAD answer lacks the CSP and CORP headers that the GET answers carry.
- Setup deviation: the harness refuses commands that set `HOME`. The reviewer did not reroute. Instead it checked that no test or eval path can reach the real workspace, keychain or model before running under the real HOME.

**Action taken:**
- One revision round to the same implementer: use the shared response helper, add header assertions and a mutation proof, and add a README line.
- From now on prompts say "temp HOME where the harness allows it; otherwise confirm the code under test cannot reach the real HOME".

## 2026-09-22 — P09.1 peer review, round 1 [REQUEST_CHANGES]

**Iter:** 004
**Source:** peer-review
**Severity:** medium

**Charter / context:** Opus reviewer and UI critic over PR #10 (catalog follow-ups: install guide synced to P02, drift test, nonce test, checksum cap, UI notes).
**Verdict text / failure detail:**
- Reviewer: VERDICT: REVISE — 3 issues.
  1. Next 16.3.5's patched fetch splits cacheable bodies, so cancelling our reader at the 4 KB cap blocks until the 5 s timeout while Next's copy downloads everything. Stale entries are also refetched in the background with no cap or timeout.
  2. The drift test misses step order, checklist labels, script names and the unpacked folder.
  3. The doctor note says five checks; doctor prints seven.
  - The install commands were walked on a fresh clone up to doctor.
- UI critic: VERDICT: REVISE — 7 issues.
  - Sources and Connections are not real lists (WCAG 1.3.1).
  - Wrapped commands at 390 look like separate commands.
  - The extension build step can't run as written.
  - Prerequisites and the Codex sign-in are unclear.
  - The doctor note is wrong.
  - The changelog sentence is not plain.
  - The screenshots are viewport-only.
  - axe found 0 violations.
- The UI critic also found:
  - Node 25 and later no longer bundle Corepack, so the README's `corepack enable` fails there. Verified (nodejs/corepack#734).
  - The guide has no pairing step.
  - `next dev` listens on all network interfaces.

**Action taken:**
- One revision round with all ten issues.
- Orchestrator decision: the release fetch leaves Next's data cache (`no-store`), and the parsed checksum is cached instead. The fetch aborts at the cap.
- New install order: prerequisites → code → extension build → setup → runner → load → pair → doctor.
- The catalog `dev` script binds localhost.
- P02.1's revision adds the Corepack line to `runner/README.md`.

## 2026-09-22 — P02.1 peer review, round 2 [APPROVE]

**Iter:** 004
**Source:** peer-review
**Severity:** low

**Charter / context:** Opus reviewer re-checked PR #9 at a1a3ee6.
**Verdict text / failure detail:** VERDICT: APPROVE.
- HEAD and GET now send the same headers (checked over TCP), and HEAD never redeems the link.
- All three mutations fail the HEAD test.
- The Corepack line is accurate: Node's CHANGELOG_V25 says "stop distributing Corepack" (#57617). It sits outside the Install code block, and P09.1's drift test still passes stacked on top.
- Integration plus #9 is green: runner 155 tests, eval 20 gates.

**Action taken:** Squash-merged as d9454f2; P02.1 is done. The catalog guide gets the same Node 25 note in P09.1's revision.

## 2026-09-22 — Provider session limit stopped three implementers [FAILURE]

**Iter:** 004
**Source:** smoke-failure (provider usage limit)
**Severity:** medium

**Charter / context:** At about 09:20 the P03, P07-B and P09.1 implementers (Sonnet) stopped with HTTP 429 "You've hit your session limit · resets 9:50am (America/Toronto)".
**Verdict text / failure detail:** Nothing was lost; every worktree was intact.
- P03: only its claim commit was pushed, and a large set of files was uncommitted.
- P07-B: three commits, one unpushed (4555fa2), clean tree.
- P09.1: revision round half done, six files uncommitted.

**Action taken:**
- The owner re-kicked at 09:52. All three agents resumed with SendMessage, keeping their context, and were told to commit and push each green slice at once.
- P03's new helper files under `runner/agent/lib/` (onboarding-store, extract-claims-schema, ask-follow-up-schema) are approved as new files; P02's files there stay untouched.

## 2026-09-22 — P09.1 peer review, round 2 [REQUEST_CHANGES]

**Iter:** 004
**Source:** peer-review
**Severity:** medium

**Charter / context:** Opus reviewer and UI critic re-checked PR #10 at bc516db, after the Sonnet implementer's one revision round.
**Verdict text / failure detail:**
- Reviewer: VERDICT: REVISE — 3 issues.
  - Confirmed in the real Next runtime: every oversized response closes at 5,120 bytes, including background refreshes. The drift test catches all earlier mutations. The merge is green (catalog 162 tests).
  1. `unstable_cache` stores the `{kind:"error"}` result, so one 500 shows "temporarily unavailable" for up to an hour. A failed refresh also hides a published checksum.
  2. "All seven should be green" is wrong: Provider stays `[warn]` until `doctor --live`.
  3. The build-extension note is wrong about `runner/` and about exit codes.
- UI critic: VERDICT: REVISE — 1 issue.
  - All seven round-1 issues are fixed; axe reports 0 violations.
  - Issue: the re-shot screenshots show the signed-in name "Jordan Rivera", and the report names it. The fixtures policy allows only Ada Quill, Sam Fernwood and Ravi Harbor, and `check:fixtures` cannot read images.
  - Small fixes:
    - a `#` comment line inside a copyable block;
    - a stale README dev address;
    - the wording of the pairing step.
- Owner note from the critic: `corepack enable` and `npm install -g` need write access to the Node install folder. That folder is root-owned when Node comes from the nodejs.org installer, so both may fail on a clean macOS account. Cover it in the F3 clean-account test.

**Action taken:**
- A second REVISE after the one round goes to a fresh Opus implementer (as with P01, P07-A and P02). Its scope: errors thrown inside the cache so they are never cached, Ada Quill screenshots, and the wording fixes.
- The old worktree was pruned; local and remote were identical at bc516db.

## 2026-09-22 — P09.1 peer review, round 3 [APPROVE]

**Iter:** 004
**Source:** peer-review
**Severity:** low

**Charter / context:** The Opus reviewer and the UI critic re-checked PR #10 at d342160, after the Opus escalation.
**Verdict text / failure detail:**
- Reviewer: VERDICT: APPROVE.
  - Two mutations each fail `release-cache.test.ts`: returning the error instead of throwing it, and dropping the wrapper's catch.
  - A real `next dev` probe confirmed the cache behaviour:
    - repeated 500s are never cached;
    - an error followed by success recovers;
    - a 404 is cached as `not_found`;
    - an oversized refresh closes at 5,120 bytes and the result stays "found".
  - The doctor and build notes match `runner/lib/doctor.ts`.
  - There is no "Jordan" or "Rivera" anywhere in the tree.
- UI critic: VERDICT: APPROVE. Ada Quill appears on all 8 screenshots.
  - Polish left open:
    - the Corepack command is repeated three times;
    - inline commands break mid-command, and `@workflow-catalog/extension` breaks at the hyphen;
    - the right-click icon step may not work while the extension is hidden in the puzzle menu.

**Action taken:** squash-merged as 61f0e2d, P09.1 set to done, and GOALS P2.F ticked. The polish is noted for P10-A's docs pass.

## 2026-09-22 — P03 peer review, round 1 [REQUEST_CHANGES]

**Iter:** 004
**Source:** peer-review
**Severity:** high

**Charter / context:** The Opus reviewer and the UI critic reviewed PR #11 at 3774f75: onboarding, the career profile, the extraction eval and the local UI pages.
**Verdict text / failure detail:**
- Reviewer: VERDICT: REVISE — 11 issues.
  - Chain green at the head (runner 170 tests, 5 evals, 41 gates) and merged onto f06688b.
  - Issues:
    1. Approval versions are reused, and accepting a revision re-approves without `approve()`.
    2. Disputes, answers and POST /markdown boundary edits change approved content with no withdrawal or revision.
    3. The extraction route reports `ok` for failed turns and for turns parked on an input request, and it has no timeout.
    4. Eight named mutations leave every test green, and there is no HTTP test of `/api/onboarding`.
    5. The eval runs code copies of the tools. The quote check can be replaced by `if (true)` and the eval stays green.
    6. `ask_follow_up` is untested, and a freeform answer excludes the claim.
    7. Extraction is not idempotent per source content hash.
    8. The markdown round trip loses multi-line text.
    9. URL, GitHub-token and upload sources are missing and unreported.
    10. `career-profile.md` is never written.
    11. The report is inaccurate: out-of-Owns files are unlisted and the eve lesson is wrong.
  - Probes:
    - Across app roots, a re-exported workflow tool fails discovery and an imported `"use step"` fails at run time. Within one root, imports work.
    - Upload paths stay confined.
- UI critic: VERDICT: REVISE — 10 issues.
  - Focus is lost after every action, and outcomes aren't announced.
  - Readiness doesn't match the walkthrough.
  - Approve can re-approve.
  - Amber marks the wrong states, and raw ids appear.
  - Badges overflow at 390, and `.error` contrast is 3.85:1.
  - Source controls lack context, and evidence is never shown.
  - Spec gaps: Preferences can't be recorded, and Unavailable/N/A have no reason field.

**Action taken:** one combined revision message went to the same Sonnet implementer. Orchestrator decisions:
- **D1:** approved as additions to P03's Owns:
  - `runner/store/profile-{types,reducer,questions,markdown}.ts` (the split of `profile.ts`);
  - the eval-agent registry and fixture files;
  - new runner tests;
  - `route-modules.test.ts`, for D2 only.
- **D2:** `route-modules.test.ts` becomes readdir-based, with registry keys equal to the declared events, so P04, P06, P08 and P10 never edit it.
- **D3:** this round adds TXT/MD upload, reasons for Unavailable/N/A, and Preferences. PDF/DOCX extraction, URL import and the GitHub token move to a new packet, **P03.1**, which is blocked by P03 and P04 and reuses P04's safe-fetch.
- **D4:** deferring eve HITL in the route is accepted for F4, because the question persists and the claim stays disputed.
- **D5:** multi-line text is fixed in the markdown format; `packages/contracts` stays untouched.
- **D6:** the eve cross-root facts go into `eve-runtime.md` (orchestrator).
- **D7:** "Acme" in a test is replaced with a policy name.

## 2026-09-22 — P07-B peer review, round 1 [REQUEST_CHANGES]

**Iter:** 004
**Source:** peer-review
**Severity:** medium

**Charter / context:** The Opus reviewer and the UI critic reviewed PR #12 at 2e3b52d: pairing and `job_capture` against the bridge, the outbox, and the CI extension step.
**Verdict text / failure detail:**
- Reviewer: VERDICT: REVISE — 6 issues.
  - What holds:
    - the manifest permissions are exactly six;
    - the token lives only in `storage.session`;
    - the outbox reuses `eventId`, re-arms its alarm, and counts `duplicate: true` as success;
    - planted regressions fail gates 4 and 9;
    - the merge is green (e2e 19/19 twice).
  - Issues:
    1. `pnpm test` needs port 4310 free: the realbridge suite failed 11/11 while another harness held it.
    2. An outbox flush race drops a queued capture.
    3. Every refusal reads "isn't reachable", while other 4xx errors retry forever.
    4. CI skips the two `dist/` tests.
    5. Three test files sit outside typecheck and hide a real error.
    6. There is no fetch timeout, and any 200 empties the outbox.
- UI critic: VERDICT: REVISE — 10 issues.
  - A runner that never answers leaves stuck states and a blank options page.
  - 401 and 403 get a false "isn't reachable" message.
  - Focus is lost and announcements are missing.
  - The invalid-code style appears on runner-down and 429 errors, and Retry-After is ignored.
  - The eyebrow renders at weight 700.
  - The pairing shows as still paired after a revoke.
  - There is no "Check again".
  - A queued capture is never reported.
  - The not-paired message has no Open settings button.
  - The label names `npm run setup`, where it should be `npm run pair`.
  - Axe reported 0 violations in 34 runs.

**Action taken:** one combined, deduplicated revision (B1–B12) went to the same Sonnet implementer. Orchestrator decisions:
- **E1:** the file bridge is a fallback, per the P07 deliverable. Nothing downloads when the bridge accepts a capture, and "Save as a file" stays available as an explicit action.
- **E2:** a capture made while unpaired is queued and sent once pairing succeeds.
- **E3:** the label names `npm run pair`.
- **E4:** the options page says that quitting Chrome unpairs the browser (spec §7.5).
- Owner note (P07-C and Settings): every re-pair leaves another device record on the runner.

## 2026-09-22 — Loop paused by the owner [PAUSED]

**Iter:** 005 (in progress)
**Source:** owner
**Severity:** info

**Charter / context:** at about 13:05 the owner paused the loop to switch the orchestrator to a different model. The full handoff is in `logs/handoff/2026-09-22-pause.md`.

**What happened at the pause:**
- The pending wake-up was cancelled.
- All five subagents were asked to save their work and stop, and all five have stopped:
  - **P03 (#11):** revision 1 completed at 9584e93.
  - **P07-B (#12):** the implementer stopped clean at 6da1a83. The reviewer and UI critic stopped round 2 with partial findings, saved in `logs/handoff/P07-B-round-2-review.md`: 5 reviewer outbox and test issues, and 5 UI issues.
  - **P07-B CI:** red at 6da1a83. The dark-popup screenshot guard in `real-popup.spec.ts:140` fails; it has been red since 339c38d.
  - **P08-A:** a claim only (6024f0f). Its report holds the design and the eve facts.
- The exact instructions for each in-flight agent are saved under `logs/handoff/`.

**Process slips (P03 implementer):**
- It treated the genuine PAUSE message as a prompt injection and finished its revision instead of stopping. P07-A did the same in iter 003.
- It ran a screenshot seed server on 4310 instead of its assigned 4320, which broke the UI critic's dark run.
- Its MCP browser screenshots landed in the main checkout: six files, moved to `/tmp/wc-stray-main-checkout/`.
- Its final report says D7 was not done, but commit e698182 did it.

**Action taken:**
- `.loop/state.json` is marked `stage_status: paused`, with a pointer to the handoff.
- `logs/latest.md` is rewritten as the resume handoff.
- PR #2 is updated. Nothing merged during iter 005.

## 2026-09-22 — Loop resumed by the new orchestrator [RESUMED]

**Iter:** 005 (in progress)
**Source:** owner
**Severity:** info

**Charter / context:** at 14:26 the owner restarted the loop on the new orchestrator model, from the pause handoff (`logs/handoff/2026-09-22-pause.md`).

**What happened at the resume:**
- `.loop/state.json` `stage_status` is back to `in-progress`. Its `paused` block was dropped; this log and the handoff keep the record.
- The three old agent worktrees were clean, with nothing unpushed. They were removed, without force, so that fresh worktree agents could switch to `packet/P03`, `packet/P07-B` and `packet/P08-A`. The branches themselves are untouched.
- Four fresh agents started:
  - P03 round 2: an Opus reviewer and an Opus UI critic;
  - an Opus escalation implementer for P07-B;
  - a Sonnet successor for P08-A.
- **Process fix** for genuine pauses being treated as injections: every prompt now carries a private code word for its agent, kept out of the repo, and every mid-round message carries it. A real stop also uses TaskStop.

**P08-A decisions** on the predecessor's five open assumptions:
1. **Provider limit.**
   - Detect it primarily from `details.semanticErrorId`: `gateway-rate-limited` or `gateway-free-tier-rate-limited`.
   - A `/\b429\b|rate.?limit/i` fallback on `code` or `message` applies only when no id is present, and is documented as a heuristic.
   - Pausing is the conservative direction, and the harness never retries.
2. **A corrupt `runs/budget.json`** fails closed as a pause (`budget settings unreadable (runs/budget.json)`), never a crash. Resume rewrites the defaults; Save keeps the pause.
3. **`withRun`** resolves with the record and never rethrows.
4. **`localDateString`** stays in `store/runs.ts` and uses the OS-local time zone. Tests must pass in any time zone; the implementer runs them under two.
5. **The runs API** returns full records plus `path`, bounded to 200 records and 14 days.

**Action taken:** iter-005 continues from the handoff.

## 2026-09-22 — Provider session limit stopped all four iter-005 agents [FAILURE]

**Iter:** 005
**Source:** smoke-failure (provider usage limit)
**Severity:** medium

**Charter / context:** at about 14:45, roughly 20 minutes after the resume, all four agents stopped with HTTP 429 "You've hit your session limit · resets 2:50pm (America/Toronto)". The Opus and Sonnet agents stopped alike.
**Verdict text / failure detail:** nothing was lost; every worktree was intact.
- **P03 reviewer:** stopped mid-checklist. It had already found that `markdownError` is returned by the API but neither page reads it (R10).
- **P03 UI critic:** stopped mid-screenshots. Its harness was left listening on 4340.
- **P07-B escalation:** still investigating. One unpushed setup merge (36b78ba).
- **P08-A:** mid-code. One unpushed resume-claim commit (269d21b), plus work in progress.

**Action taken:**
- At 14:52, after the reset, the owner re-kicked ("Continue").
- All four agents resumed with SendMessage, keeping their context. Each message carried that agent's code word.
- P08-A was told to push at its next green step.
- Lesson carried from iter 004: four agents at once reached the session limit within about 20 minutes, so the budget of seven is a ceiling, not a target.

## 2026-09-22 — P03 peer review, round 2 [REQUEST_CHANGES]

**Iter:** 005
**Source:** peer-review
**Severity:** high

**Charter / context:** a fresh Opus reviewer and a fresh Opus UI critic reviewed PR #11 at 9584e93 (revision 1), with `logs/handoff/P03-revision-1.md` as the checklist.
**Verdict text / failure detail:** the full findings are in `logs/handoff/P03-round-2-review.md`.
- **Reviewer: VERDICT: REVISE — 6 issues.**
  - What holds:
    - the chain is green at the head (runner 279/279, eval 62 gates) and on the merge onto a9abb70;
    - 38 of 49 mutations were killed.
  - Issues:
    1. R10 is reconciled on only three routes and is untested; hand edits are lost silently.
    2. The new saved-text feature posts the prompt rendering back, which corrupts the source and defeats R7.
    3. `ask_follow_up` confirms on any free text, even "no".
    4. The store loses concurrent writes: 1 of 7 recorded.
    5. The `ask_follow_up` eval copy is still a copy.
    6. The report is still uncorrected.
- **UI critic: VERDICT: REVISE — 9 issues.**
  1. Focus is lost after claim and revision actions.
  2. UUIDs and raw keys appear in announcements.
  3. Each outcome is announced two or three times, and feedback is off-screen.
  4. Readiness is wrong with zero claims, ambiguous to screen readers, and left stale after a withdrawal.
  5. The new "excluded" badge fails contrast (3.85:1 light, 3.04:1 dark).
  6. Drafts vanish on re-render.
  7. The reason for Unavailable and N/A is lost when typed after the choice.
  8. The withdrawal isn't explained, and Accept is a dead end.
  9. 9 of 48 screenshots exist.
  - Verified: C4, C5, C7, C8, C9, C10, Preferences.

**Action taken:** revision 1 was the one revision round, so a fresh **Opus escalation implementer** took the combined list. Orchestrator decisions, in full in the handoff file:
- **D8:** every profile write goes through one shared helper, with an in-process chain and a cross-process lock file `.runner/profile.lock` (bounded wait, then 503; stale after 30 s).
- **D9:** reconcile before every mutation. Unparseable hand edits refuse writes and offer an explicit discard.
- **D10:** only an explicit option changes a claim. Free text stays open, as a note.
- **D11:** when approval is withdrawn, pending revisions are applied to the draft instead of dropped. This reaches the walkthrough's end state without losing the person's edit. Accept is never offered while unapproved.
- **D12:** one live region, the sticky "Last action" line.
- **D13:** raw paste-file text, and stable upload names (415 for other types).
- **D14:** the hash is recorded only after a persisted extraction.
- **D15:** an edit that adds an always-ask item re-opens the question.
- **D16:** all 48 screenshots.
- Contracts follow-up (for a later contracts packet): withdrawals are stored as `accepted` revisions, because the revision status list is closed.

## 2026-09-22 — P08-A peer review, round 1 [REQUEST_CHANGES]

**Iter:** 005
**Source:** peer-review
**Severity:** high

**Charter / context:** an Opus reviewer and an Opus UI critic reviewed PR #13 at 0af2945: the run log, the budget pause, the run harness, and the Runs and Settings Budget pages.
**Verdict text / failure detail:** the full findings are in `logs/handoff/P08-A-round-1-review.md`.
- **Reviewer: VERDICT: REVISE — 5 issues.**
  - What holds:
    - the chain is green at the head and on the merge, and CI passes;
    - all four mutation proofs reproduce;
    - tests pass in 5 time zones;
    - the seven eve facts are verified;
    - the API guard, bounds and uuid checks hold;
    - there are no HTML sinks, and the scope is clean.
  - Issues:
    1. A timed-out turn is recorded as a success, with no cancel, because eve's client ends quietly on an abort during stream open or reopen.
    2. `withRun` rejects on empty error text, which breaks decision 3.
    3. Usage is lost on a timeout.
    4. The idempotency lookup is capped at 200 records, not the 14-day window.
    5. Budget writes race.
- **UI critic: VERDICT: REVISE — 9 issues.**
  1. The failure pill (P02's `.badge.fail`) fails contrast.
  2. Error text fails contrast.
  3. Resume drops focus.
  4. No page error for out-of-range limits.
  5. Long model ids scroll sideways at 390.
  6. The empty state is doubled.
  7. UUIDs, "n/a" and error codes are visible.
  8. Amber is used for information.
  9. The corrupt-budget state is unexplained, and "Saved." contradicts the pause.

**Action taken:** one combined revision went to the same Sonnet implementer (its one round), with decisions G1–G10:
- **G1:** stream turns event by event, require a boundary event and no abort, and cancel through the session, with real-`Client` regression tests.
- **G2:** `withRun` never rejects.
- **G3:** idempotency scans the whole window.
- **G4:** budget writes are serialised now, not deferred to P08-B.
- **G5:** a 429 in `statusCode` or `upstreamStatusCode` counts as a provider limit when no id is present.
- **G6:** `paused` stays the manual pause; consumers derive "daily limit reached" from the two numbers.
- **G7:** approved `runner.css` edits, for `.badge.fail` contrast and form-control borders only.
- **G8:** shortened paths with Copy path, and no model or code noise.
- **G9:** skipped files are named.
- **G10:** "Did not finish (or still running)".
- The screenshots grow to 24, adding the corrupt and daily-limit states.

## 2026-09-22 — eve client ends an aborted turn quietly as "completed" [DRIFT]

**Iter:** 005
**Source:** contract-drift
**Severity:** high

**Charter / context:** the P08-A reviewer found that eve@0.63.0's client stream returns without throwing when the signal aborts during stream open, reopen or backoff (`dist/src/client/open-stream.js`). `summarizeTurnEvents` then defaults the status to `completed` when no boundary event was seen (`session-utils.js`). The orchestrator checked both in the installed code. `MessageResponse.cancel()` sends nothing before the turn starts; `ClientSession.cancel()` is the reliable cancel.
**Verdict text / failure detail:** a caller that sets `AbortSignal.timeout` and trusts `response.result()` records a timed-out turn as success. Three callers are affected:
- P08-A `runTurn`;
- P03's extraction route (R3 timeout);
- P02's `checkModel` in `runner/server/eve-gateway.ts`.

**Action taken:**
- Recorded as `docs/spec/research/eve-runtime.md` §8 item 15, with the safe pattern.
- P08-A fixes it in its revision (G1).
- The P03 escalation implementer was told to apply the pattern to the extraction route and to test it.
- **Follow-up:** `checkModel` (P02's file) needs the same fix. It is queued as a runner follow-up for after P03 and P08-A merge, and must reuse P08-A's `runTurn` rather than a third copy.

## 2026-09-22 — P07-B escalation used Edit after a refused heredoc [DRIFT]

**Iter:** 005
**Source:** peer-review (self-disclosed by the implementer)
**Severity:** low

**Charter / context:** the harness refused the P07-B escalation implementer's heredoc append to `extension/src/shared/bridge-client.test.ts` as too complex. The implementer made the same append with the Edit tool and disclosed it in its report.
**Verdict text / failure detail:** this was not a guardrail bypass.
- The refusal came from the harness's command-complexity rule, not from a deny rule or a permission check, and Edit is the tool meant for file edits.
- The rule "never reroute after a refusal" is aimed at deny-rule and permission refusals: `rm -rf`, force-push, secrets, the worktree isolation guard.

**Action taken:** prompts from now on say:
- If a command is refused as too complex, split it, or use the dedicated tool (Edit or Write) for file changes.
- If a command is refused by a deny rule or a permission check, stop and report. Never route around it.

The P07-B escalation reached d0e2b2c, with CI green on every pushed head. Round 3 (Opus reviewer and UI critic) was dispatched at 16:05.

## 2026-09-22 — P07-B peer review, round 3 [REQUEST_CHANGES]

**Iter:** 005
**Source:** peer-review
**Severity:** low

**Charter / context:** a fresh Opus reviewer and a fresh Opus UI critic did a full review of PR #12 at d0e2b2c (the Opus escalation's revision 2), including everything round 2 never reached. The findings are in `logs/handoff/P07-B-round-3-review.md`.
**Verdict text / failure detail:**
- **Reviewer: VERDICT: REVISE — 1 issue.** The issue is documentation only: the README's manual smoke checklist still describes Save downloading a file.
  - The chain is green at the head and on the merge.
  - dist vitest 273, 0 skipped. CI e2e 32/32 with no retries.
  - The guard is not weakened: planting a weakening makes the reviewer's probe fail.
  - 16 of 18 race probes pass.
  - Nits: a narrow pause window just after pairing, a `forgetInvalidToken` window, an untested ordering, a full queue without a file fallback, a screencast error handler, a guard test, and report counts.
- **UI critic: VERDICT: REVISE — 5 issues.** Every round-2 item is fixed. About 110 axe audits are clean, active text is at least 7.6:1, and nothing scrolls sideways at 390. The issues:
  1. The Pairing card keeps a stale outcome after a revoke.
  2. The "something else on the port" alert contradicts the line below it.
  3. The 409 message shows `eventId` developer text.
  4. One command is outside `<code>`.
  5. Amber is used for waiting and retries.

**Action taken:** one combined revision 3 went to the same Opus escalation implementer, with decisions H1–H4:
- **H1:** amber means the person must act, including the 401/403 re-pair pauses. Progress and retries are neutral. Red means the capture was not kept.
- **H2:** refusals are plain sentences with a next step, with no field names or HTTP codes.
- **H3:** reviewer nits 1 and 3–7 are fixed now; nit 2 is documented as a known limitation.
- **H4:** retake the affected screenshots.

## 2026-09-22/23 — A weekly usage limit stopped all five agents, and the loop stalled about 23 hours [FAILURE]

**Iter:** 005
**Source:** smoke-failure (provider usage limit)
**Severity:** high

**Charter / context:** at about 17:05 on 2026-09-22, all five running agents stopped with HTTP 429 "You've hit your weekly limit · resets 4pm (America/Toronto)":
- P07-B revision 3;
- the P08-A round-2 reviewer and UI critic;
- the P03 round-3 reviewer and UI critic.
The orchestrator's own fallback wake-up couldn't run either, so the loop stalled until the owner re-kicked at 16:04 on 2026-09-23.
**Verdict text / failure detail:** nothing was lost.
- P07-B had unpushed local work (566c64b).
- Every other branch was pushed, and the reviewers' scratch was in /tmp.
- No process held a port.

**Action taken:**
- All five agents resumed with SendMessage, keeping their context. Each message carried that agent's code word.
- Lesson: this is the second hard stop in one day from running several Opus agents at once. The first was the session limit at about 14:45.
  - A weekly limit can stall the loop for up to a week, and no wake-up can recover from it.
  - Total consumption drives it, not parallelism. So confirmation rounds from now on check only the items that changed.
  - Moving UI critics to Sonnet is the owner's call, because the overnight prompt specifies Opus for every reviewer.

## 2026-09-23 — P08-A peer review, round 2 [REQUEST_CHANGES]

**Iter:** 005
**Source:** peer-review
**Severity:** high

**Charter / context:** an Opus reviewer and an Opus UI critic reviewed PR #13 at 371cd63 (the Sonnet implementer's revision 1). The findings are in `logs/handoff/P08-A-round-2-review.md`.
**Verdict text / failure detail:**
- **Reviewer: VERDICT: REVISE — 2 issues.** Round 1's abort points, usage, races and idempotency are all fixed.
  1. G1's fix reads eve's normal `session.waiting` boundary as "parked", so every real run would record a failure and idempotency would never say done. At eve@0.63.0, conversation turns end `turn.completed → session.waiting`.
  2. `withRun`, `/status` and the budget route still reject or return 500 when today's run folder can't be read.
- **UI critic: VERDICT: REVISE — 3 issues.** Round 1's contrast, focus, bounds, overflow, empty state and amber issues are fixed, and G7 regresses no page.
  1. The skipped-file note shows full UUID paths.
  2. The corrupt-budget recovery messages are untrue after a Save.
  3. Copy path has no visible feedback below the first screen.

**Action taken:**
- The Sonnet implementer's one revision round was spent, so a fresh **Opus escalation implementer** took the combined list, with decisions I1–I4:
  - **I1:** ok is a `session.waiting` or `session.completed` boundary with no failure, no cancel and no abort. A turn waits on the person only with a non-empty `input.requested`.
  - **I2:** nothing before the body can reject. An unreadable run folder becomes a synthetic pause, and `/status` stays 200.
  - **I3:** nits 1–8.
  - **I4:** the UI issues and polish.
- `eve-runtime.md` §8 item 15 now spells out which boundary means what.
- The P03 round-3 reviewer was asked to check that P03's extraction route classifies a normal turn as ok.

## 2026-09-23 — P03 peer review, round 3 [REQUEST_CHANGES]

**Iter:** 005
**Source:** peer-review
**Severity:** medium

**Charter / context:** an Opus reviewer and an Opus UI critic reviewed PR #11 at bbfa00e, the Opus escalation's revision 2. The findings are in `logs/handoff/P03-round-3-review.md`.
**Verdict text / failure detail:**
- **Reviewer: VERDICT: REVISE — 1 issue.** The chain is green at the head and on the merge. V1–V6, VN1–VN11 and D8–D16 hold. The normal `turn.completed → session.waiting` turn is read as finished.
  1. A `turn.cancelled` extraction turn counts as a success: the route records the content hash, so the same text is never extracted again.
  - Nits: N1 (the D8 wait compounds for queued writers), N2–N4 (untested guards), N5, N6 (marker-shaped claim text breaks the runner's own file) and N7 (`GET /readiness` doesn't reconcile).
- **UI critic: VERDICT: REVISE — 3 issues.** Round-2 issues 1 and 4–9 hold, as do D11, D13 and D16, and axe is clean across 98 variants.
  1. D9 refusals are a 313-character paragraph with a marker's UUID, shown three times, with a false "Nothing was saved" after Save & extract.
  2. Screen readers hear some outcomes twice, and the focused control is rebuilt after every action.
  3. The pinned line reaches 7 lines at 390 and can cover the focused editor.

**Action taken:**
- Revision 3 went to the same Opus implementer, with decisions J1–J8:
  - **J1:** `turn.cancelled` is not ok.
  - **J3–J6:** the UI issues and polish.
  - **J7:** nits N1–N4, N6 and N7.
  - **J8:** screenshots.
- **J2 dropped N5.**
  - A turn response follows with `keepAlive`, so eve never gives up on a silent stream.
  - If the stream ends early without an abort, eve throws. Only a manually opened `session.stream()` stops quietly.
  - `eve-runtime.md` §8 item 15 now says so.

## 2026-09-23 — P07-B peer review, round 4 [REQUEST_CHANGES]

**Iter:** 005
**Source:** peer-review
**Severity:** low

**Charter / context:** a narrow confirmation round over revision 3 (d0e2b2c..9529761; H1–H4). An Opus reviewer and an Opus UI critic reviewed PR #12. The findings are in `logs/handoff/P07-B-round-4-review.md`.
**Verdict text / failure detail:**
- **Reviewer: VERDICT: APPROVE.**
  - Chain green at the head and on the merge onto b383772. CI's 36 e2e tests passed with no retries.
  - The gate-4 fix doesn't weaken the gate.
  - 13 of 14 mutations were caught.
  - Nits: README step 7's import source; a non-envelope 403 test row.
- **UI critic: VERDICT: REVISE — 1 issue.** Every round-3 item holds, and axe is clean across 116 audits.
  1. On the options page, a revoked or expired pairing is announced two or three times: Status's alert, the Pairing line's live update, and the code field's description when focus moves.

**Action taken:**
- Revision 4 went to the same Opus implementer, with decisions K1–K4: announce once, the reviewer's nits, the polish, and H2 in part A's fallback.
- Round 5 confirms only K1–K4.
- **Process note:** while looking for its scratch folder, the UI critic opened the orchestrator's roster and code-word files in /tmp; it says it used nothing from either. The files moved to a private folder with no `wc-` prefix. From now on, prompts limit agents to the /tmp paths they name.
