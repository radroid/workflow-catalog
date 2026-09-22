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

