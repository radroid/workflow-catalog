# P05 · Preparation with evidence, the validator, and export

Status: claimed (iter 007)
Assignee: iter-007 implementer (Opus)
Blocked by: P04
Owns:
- The preparation skills in `packages/job-assistant/skills/`: requirements-extraction, claim-matching, resume-drafting, cover-letter-drafting and revision-diff. Also the `resume` and `cover-letter` templates in `packages/job-assistant/templates/`.
  - The skills live in the workflow package, which the eve adapter mounts as `jobs__<skill>`. There is no `runner/agent/skills/` (iter 006 correction).
- `runner/agent/tools/prepare_application.ts` and its directive-free `runner/agent/lib/prepare-*.ts` modules. Also its eval-agent re-export, fixture handler, one entry each in the fixture and tool registries, and its eval.
- `runner/validate/`, `runner/export/` and `runner/store/applications.ts`.
- `runner/server/routes/applications.ts`, and `runner/ui/application.html` with its assets.
- New tests in `runner/test/`.
- New preparation fixtures in `packages/job-assistant/fixtures/`, with additive `index.json` entries.
- `runner/package.json` and `pnpm-lock.yaml`, for the DOCX and PDF export dependencies only (and a devDependency to read their text back in tests, under the same rules):
  - The libraries must be maintained, with no native build step, no install scripts and no network access.
  - Pin exact versions, and report the choice and the reason.
  - While P05 runs, no other packet edits these two files (iter 006 decision).
- `runner/README.md`: the P05 lines, and the P05 row of "Extending the runner".
Spec: F7, hard-problems #2 and #3

## Goal
Every sentence in a generated document cites a confirmed claim, and the person sees what changed and why.

## Deliverables
- `prepare_application` as a durable workflow tool: requirements → matching (confirmed claims only; excluded claims are removed from the context, not just discouraged) → gap questions (park, never guess) → resume draft → optional cover letter → revision pass → validator → diff → export (Markdown, DOCX, PDF) → attach to the application with `{ profileVersion, jobRevision, idempotencyKey }`.
- Validator (no model): every bullet or sentence carries `[C#]` citations that resolve to confirmed claim IDs; no excluded ID appears; boundaries hold (dates and titles equal the confirmed claim text; no numbers absent from confirmed claims). Output is stripped of citation markers only at export.
- Diff view: per bullet, the source claim and the presentation change.
- Idempotency: same job revision + profile version → no new document.

## Acceptance
- Excluded-metric fixture: the number never appears in any exported format (grep the DOCX and PDF text).
- Validator unit tests for each rule, including a deliberately bad draft.
- Hostile posting fixture through the full pipeline: profile unchanged; no action tools called; output contains no instruction text from the posting.
- Two consecutive preparations of the same inputs → one document.
- Documents record profile version and job revision; changing the profile and re-preparing yields a new version that names the old one.

## Out of scope
Board UI beyond the application page, sessions, schedules.

## Report

### 2026-09-24 — Implementation (iter 007)

**PR:** [#16](https://github.com/radroid/workflow-catalog/pull/16), `packet/P05` → `overnight/integration`. The branch starts from `origin/overnight/integration` at `5b4146d`. The code is final at `7171303`, and this report is the commit after it.

| Commit | What |
|---|---|
| `78a9900` | Claim |
| `84aba33` | The export dependencies (exact pins), and the deterministic validator (`runner/validate/`) |
| `60894de` | Export: Markdown from the package's templates, DOCX, PDF, and the "what changed and why" diff (`runner/export/`) |
| `7e3843a` | `prepare_application`, `store/applications.ts`, `server/routes/applications.ts`, and the pipeline tests |
| `d992af3` | Unit tests for the tool's check, the prompt and the store |
| `dd8e96b` | The preparation eval and its fixture model |
| `0ccb4b0` | The five preparation skills and two templates, rewritten to describe what the tool actually accepts |
| `3dcbe99` | The Applications page, and its happy-dom test |
| `12f3fab` | `runner/README.md`: the Applications page, its workspace files, and the P05 row |
| `b6057f2` | The coverage list numbered each item twice; found while taking screenshots, fixed, and tested |
| `20c9c8f` | Screenshots |
| `7171303` | The race CI caught (below): a preparation reads as running until both of its finishing writes are made |

| Head | CI run | Result |
|---|---|---|
| `20c9c8f` | [35987564075](https://github.com/radroid/workflow-catalog/actions/runs/35987564075) | failure: two Applications-page tests hit a real race (below) |
| `7171303` | [35988661490](https://github.com/radroid/workflow-catalog/actions/runs/35988661490) | success, every step: install, typecheck, lint, test (with the eval), the fixtures policy, the catalog build, and the extension build with vitest and Playwright |

The reply gives this report commit's own head SHA and CI run.

**What CI caught, and the fix.** On CI's runner, a page refresh landed between `finish()`'s two writes. The attempt was already written as parked or failed, and the application's `processing` still said running. `stateOf` read that pair as "interrupted", and the page announced "Couldn't prepare …" for a preparation that had in fact parked on questions. So one test waited for "Needs your answers" until it timed out, and the other read the interrupted message instead of the refusal. Locally the window was too short to hit. The fix, in `7171303`:
- The state now answers "running" for as long as this process is working on the application (`IN_FLIGHT`), whatever the files say in between. A running record that no one in this process is working on still reads as interrupted.
- `finish()` now writes the application first (documents, stage, `processing`) and the attempt second. A runner stopped between the two leaves the documents attached, and the start-up sweep records such an attempt as done, since a document carries its key.
- The page shows questions and refusals only once the state says parked or failed.

New tests in `applications-routes.test.ts`:
- › the state while a preparation finishes: done, parked and refused preparations each read as running in both the list and the detail view just before each finishing write, then as their outcome.
- "a runner that stopped after attaching the documents, before closing the attempt, finds that attempt done at start".

Both fail on the old code: the first with `"interrupted"` in both views, the second with the attempt left failed. Both pass on the new code, and the page and route suites passed three runs in a row.

**What was built.**
- **The turn.** `POST /api/applications/prepare` checks everything before any turn runs:
  - the documents' header exists
  - the job exists, and its details are extracted
  - the profile is approved: otherwise it answers "Preparation is locked: … The workflow will not guess."
  - no questions are still open
  - eve, a model and the budget are all available

  It then queues one turn per workspace through `runTurn` inside `withRun`. The prompt (`agent/lib/prepare-prompt.ts`) names the skills to load. It puts the confirmed claims (by position label, `[C1]`, never an id) and the job's extracted fields inside a random per-call boundary, as user-turn data. Excluded and undecided claims are left out entirely: their text, id and label.
- **The tool.** The model calls `prepare_application` with a task id, one entry per numbered requirement (covered by which labels, a gap question, left out, or not a requirement) and the cited draft. The tool only checks and returns (`agent/lib/prepare-logic.ts`). A refused draft comes back with each problem, by place ("Resume, Projects, bullet 1"). An excluded claim is never named: its label gets the same words as a label that was never given out. The model revises and calls again in the same turn.
- **After the turn.** The route reads the tool's last output from `events`. Any action other than `load_skill` or `prepare_application` means nothing is saved. Otherwise it re-reads the profile (a change during the turn saves nothing) and runs the validator again. Only then does it export `resume-v<n>`, `cover-v<n>` when asked (each as `.md`, `.docx` and `.pdf`) and `diff-v<n>.md`. It attaches each file with `{ profileVersion, jobRevision, idempotencyKey }` and moves the stage from saved (or preparing) to ready.
- **Failures.** A non-ok turn, a draft still refused, a model that never hands one over, or a parked preparation writes no document, never moves the stage, and sets `processing` to failed, with a plain reason. A provider limit pauses the budget, and the page says so.
- **The Applications page** (`ui/application.html`).
  - A job picker (until P06's board), and the documents' header (name and contact line; never sent to the model).
  - Each application's state, and its open questions with answer buttons.
  - The runner's refusals, in words chosen per validator rule.
  - How each requirement was met, and every version: its export links, and "What changed and why". That section lists every sentence beside the claims it cites and the presentation change ("Reworded from C1: leaves out …; adds …"), plus the changes since the version it replaces.

**Acceptance → tests.**

| Acceptance | Proven by |
|---|---|
| The excluded metric never appears in any exported format | `applications-routes.test.ts` › the excluded metric (acceptance) › "never reaches the model, and never reaches an exported document in any format, even when a first draft slips it in". The first draft slips it in, the tool refuses it by place, and the revision passes. Then every one of the seven files is read back as text: Markdown as is, DOCX from its XML parts (`test/document-text.ts`), PDF through unpdf. Each is grepped for the metric's words, `500%` and its id, as are the page's view and the version record. "a draft the tool never accepted saves nothing, …" covers a refusal that is never fixed. |
| Validator unit tests for each rule, and a deliberately bad draft | `validator.test.ts` › one rule at a time (one test per rule: `uncited`, `stray_marker`, `unknown_citation`, `excluded_claim` by label, id and wording, `unconfirmed_citation`, `raw_id`, `number`, `date`, `title`, `credential`, `posting_wording`, `heading`, `empty`) › a deliberately bad draft. `prepare-logic.test.ts` covers the `requirements` coverage rule. |
| The hostile posting through the full pipeline | `applications-routes.test.ts` › a hostile posting (acceptance) › "goes through the whole pipeline: …". It answers the two gap questions, then checks: the SHA-256 of the three profile files is unchanged; the only actions are `load_skill` and `prepare_application`; no instruction line of any prompt carries the injected text. It also greps 15 outputs for the injection phrases: every exported file in all three formats, the tool inputs and outputs, the list and detail views, the application, preparation and version records, and the run log. "a model that follows the posting's instruction and asks for another tool gets nothing saved" covers a model that obeys. Also `prepare-logic.test.ts` › the hostile posting, `application-page.test.ts` › a hostile posting, and the eval (Quill). |
| Two consecutive preparations of the same inputs → one document | `applications-routes.test.ts` › "the same job revision and profile version prepare one document: asking again runs nothing and writes nothing", and "a second request while one is running starts nothing". On the page, `application-page.test.ts` checks that Prepare again says "Already prepared". |
| Documents record the profile version and job revision; a changed profile gives a new version that names the old one | `applications-routes.test.ts` › "prepares from confirmed claims only, …, records the profile version, job revision and key on each …"; › a changed profile › "prepares a new version naming the old one when the approved profile's version changes, and keeps the old files", and "an exclusion keeps the profile's version but still prepares anew: …" |

**The brief's decisions, and where each is enforced.**
- **The tool takes IDs only.** The schema is `agent/lib/prepare-schema.ts`: a task id, requirement numbers, claim labels and draft text. A claim's id or text never goes in or out.
- **Excluded claims never reach the model.** Proven by `prepare-prompt.test.ts` ("… nothing of an excluded or undecided claim: not its text, its id or its label"), the route test above, and the eval.
- **The data boundary.** `prepare-prompt.test.ts` checks that nothing from the posting reaches an instruction line, and that the boundary is new on every call. Nothing is added to `instructions.md`, a skill or the system prompt.
- **The turn goes through P08-A's `runTurn` inside `withRun`, and results are read from `events`.** Tested under "a turn that doesn't finish": a failed turn, a turn with no boundary, a provider limit (the budget pauses), and a preparation left running when the runner stopped (marked interrupted at start).
- **No eve connection was added.**
- **Idempotency key:** `<jobId>@<revision>+profile@v<version>+<resume|resume+cover>+inputs@<digest>`. The digest covers everything the model reads: the confirmed claims, the boundaries, the presentation notes and the job's fields. It is needed because an exclusion after approval keeps the approval version but changes what may be cited.
- **Directives compile per app root.** `agent/tools/prepare_application.ts` and `eval-agent/agent/tools/prepare_application.ts` are thin wrappers over the directive-free `agent/lib/prepare-*.ts`. There is one entry each in the fixture and tool registries.
- **The eval workspace.** `preparation.eval.ts` imports `openOrCreateEvalWorkspace` at module top and never assigns `RUNNER_WORKSPACE`. It asserts nothing about the shared career profile; the profile checks run in Vitest, over private workspaces.

**Gap-question design: questions the runner owns.** eve's `ctx.ask` can't carry this. `node_modules/eve/docs/tools/workflows.mdx` says "Ending the run, by returning, throwing, or cancellation, withdraws its pending requests", and `runTurn` cancels any turn that parks on `input.requested`. So a question can't wait inside eve for someone who answers tomorrow. Instead:
1. The model sends the gap entries with no draft, and the tool answers `questions`.
2. The route records them in `applications/<taskId>/preparation.json` (status `parked`) and ends the run. The run log records a failure, "Waiting for your answer to N questions.", and the stage stays put.
3. On the page, each question is shown in amber. It has two answers: "Leave it out" (`leave_out`) and "I'll add evidence to my profile" (`add_evidence`). Answers are recorded one write at a time.
4. Preparing again with the same key carries the answers into the next prompt's data block ("Requirement N: leave it out."), and the model continues. While a question is open it answers `needs_answers`. If an answer was `add_evidence`, it answers `needs_profile` until the profile changes; that makes a new key, so the old answers don't carry over.

**Dependency choices** (`runner/package.json`, exact pins).
- `docx` 9.5.2 for DOCX, and `pdfkit` 0.20.2 for PDF (the built-in Helvetica, so no font files and no canvas). `unpdf` 1.8.1 is the one devDependency: PDF.js's serverless build, used to read PDF text back in tests. DOCX is read back with `node:zlib` in `test/document-text.ts`, so no second reader is needed.
- All three are maintained, pure JavaScript and make no network calls. I walked the 25 packages they pull in (with `@types/node` and `undici-types`): none has a `preinstall`, `install` or `postinstall` script, or a `binding.gyp`.
- `docx` 9.7.1 was rejected because it pulled `@types/node` 25 and rewrote unrelated lockfile entries. 9.5.2 is additive.
- Clean install: `git archive HEAD` extracted into `/tmp/wc-p05-clone`, then `pnpm install --frozen-lockfile --offline` exited 0 (457 packages; docx 9.5.2, pdfkit 0.20.2 and unpdf 1.8.1 installed). The only lifecycle script that ran was the existing `unrs-resolver` postinstall, from `eslint-config-next`. `export.test.ts` and `validator.test.ts` passed there (2 files, 33 tests).

**Mutation proofs: 7 of 7.** Each was applied, turned the named tests red, then reverted, and `git diff` was confirmed clean.

| # | Mutation | File | Killed by |
|---|---|---|---|
| 1 | Let excluded claims into the prompt | `agent/lib/prepare-prompt.ts` | 4 tests: `prepare-prompt.test.ts` (excluded or undecided claims), and in `applications-routes.test.ts`: "the prompt holds confirmed claims only, …", "an exclusion keeps the profile's version …", and the excluded-metric acceptance test |
| 2 | Drop the validator's excluded-id rule | `validate/validator.ts` | `validator.test.ts` › "excluded_claim: by label, by id and by wording, …" |
| 3 | Let a number no confirmed claim states pass | `validate/validator.ts` | 5 tests: `validator.test.ts` › number and › the deliberately bad draft; `prepare-logic.test.ts` › refuses a draft sentence by sentence; `applications-routes.test.ts` › "a draft the tool never accepted …"; `application-page.test.ts` › refusals in plain words |
| 4 | Strip citations before validating | `agent/lib/prepare-logic.ts` | 20 tests across `prepare-logic.test.ts` and `applications-routes.test.ts`: every path that needs an accepted draft, including the excluded-metric, hostile-posting, one-document and changed-profile acceptance tests |
| 5 | Skip the idempotency check | `server/routes/applications.ts` | `applications-routes.test.ts` › "the same job revision and profile version prepare one document …"; `application-page.test.ts` › Prepare again |
| 6 | Put the posting's requirements into the instructions | `agent/lib/prepare-prompt.ts` | 4 tests: `prepare-prompt.test.ts` › keeps everything from the posting inside the boundary, and › one line per field; `applications-routes.test.ts` › the prompt test and the hostile-posting acceptance test |
| 7 | Move the stage on a failed run | `server/routes/applications.ts` | 7 tests: `applications-routes.test.ts` › profile changed mid-turn, the unaccepted draft, gap questions, the tool-obeying model, the failed turn, the provider limit; `application-page.test.ts` › refusals |

**The chain, from the repo root at `7171303`.** `git status --porcelain` was empty before and after, apart from this report. The same chain also passed at `20c9c8f`, where runner had 971 tests.
- `pnpm install --frozen-lockfile`: already up to date.
- `pnpm typecheck`: 6 of 6 workspaces done.
- `pnpm test`, exit 0:
  - contracts: 16 files, 235 tests
  - job-assistant: 6 files, 153 tests
  - catalog: 26 files, 168 tests
  - runner: 52 files, 973 tests. The `eve eval` then passed 7 of 7 files and 159 of 159 gates: approval 4, tool-surface 4, missing-tools 8, skills 4, job-extraction 20, **preparation 54**, onboarding-extraction 65.
  - extension: 21 files and 329 tests passed, 1 file and 5 tests skipped
  - root `scripts/*.test.mjs`: 2 of 2
- `pnpm -r lint`: 6 of 6 clean, `--max-warnings 0`.
- `pnpm check:fixtures`: exit 0.
- No rerun was needed at `--workspace-concurrency=1`.

**Screenshots.** 20 files, `docs/screenshots/P05-applications-{empty,prepared-diff,gap-question,refusal,exports}-{light,dark}-{390,1280}.png`, full page.
- **Harness.** A throwaway script, `/tmp/wc-p05-screens/harness.ts`, never committed. It runs the real `createBridgeApp` with only the applications route module, on `127.0.0.1:4320` (checked free first). The workspace was fresh, under `/tmp/wc-p05-screens/`. The test suite's scripted model stood in for eve: no live model, no network, nothing from HOME or the keychain. Sign-in went through a real `/ui/login?nonce=` link.
- **How each state was reached.** Empty and prepared-diff were seeded through the real route functions. The prepared-diff state is version 2 after the degree was excluded, so "Since version 1" shows a removed sentence. The gap-question, refusal and exports states were driven in the browser, so the live line shows each real outcome. The exports state is the hostile Quill posting, answered and prepared with a cover letter, then Prepare again, which gives "Already prepared …".
- **Viewports.** 390 used device-metrics emulation (`390x844x1`), since a window resize floors at 500. `window.innerWidth` was 390 or 1280 before every capture, `scrollWidth === clientWidth` in every state (no horizontal scroll), and no element extends past the viewport at 390.
- **Contrast.** Every visible text node was measured against its composited background, with every details section open, for all four applications in both themes, plus the field error. The lowest was 7.17:1 (light) and 6.76:1 (dark), and nothing was under 4.5:1. `aria-disabled` controls use the house 0.5 opacity, and WCAG 1.4.3 exempts inactive controls.
- **Checks.** All 20 SHA-256 checksums are unique. The harness was stopped afterwards: 4310, 4320, 4340 and 4350 are free. 4330 belongs to the concurrent P03.2 implementer, and I left it alone.

**Skipped, and why.**
- **No new fixture files.** The existing fixtures cover every case: `job-fernwood.json`, `job-harbor.json`, `job-hostile.json`, `expected-claims.json` and `expected-excluded-metric.json`. The posting whose requirements the claims honestly meet ("Platform Lead · Fernwood") lives in `runner/test/preparation-helpers.ts`, because a new job-snapshot fixture would change `packages/job-assistant/test/fixtures.test.ts`, which P05 doesn't own.
- **The revision pass is not a separate model turn.** It happens inside the one turn: the tool refuses, and the model fixes what each problem names and calls again. The eval proves one refusal, then acceptance.

**Assumptions.**
- One application per job (`ensureForJob`). A successful preparation moves the stage from saved or preparing to ready. It never moves it back; an application that has moved on only gets the documents attached.
- The career profile holds no name, so the page asks for one and the runner adds it at export. It lives in `applications/details.json` and is never sent to the model.
- Claim labels follow the profile's claim order, across every status. So a label is never reused for a different claim, and an excluded claim's label never appears.

**Open questions for the orchestrator.**
1. `runner/README.md`'s P06 row still lists `server/routes/applications.ts`, which P05 has now created and owns. P06 will need to extend this module, or put its `application_status_changed` handler somewhere else. I didn't edit the P06 row.
2. The page joins the nav through its `runner-nav` meta tag, so it sits after Status. Placing it between Jobs and Board takes one line in `NAV_PAGES` in `server/local-ui.ts`, which I don't own.
3. `eve eval` prints `[workflow-sdk] Step execution already in flight` for the preparation and onboarding evals. Every gate passes; I note it only so a reviewer isn't surprised.

**Boundaries.**
- Nothing outside `Owns:` was touched: `packages/contracts`, `context.ts`, `run-harness.ts`, P03's and P04's files and `extension/` are unchanged, and no eve connection was added.
- No deny rule refused anything. The harness refused a few compound shell commands, which I split, and any command containing the word "eval", so the eval ran through `pnpm test`.
- No message carrying the orchestrator's code word arrived, and nothing else claimed to be from the orchestrator. The hostile fixture's "SYSTEM: …" text was treated as data.

**The one thing to sharpen in this packet:** say up front that eve withdraws `ctx.ask` requests when a run ends, and that `runTurn` cancels a parked turn. Then "gap questions (park, never guess)" plainly means questions the runner owns and answers carried into the next attempt, and the next implementer doesn't have to work that out from eve's docs.

### 2026-09-24 — Revision 1 (iter 007)

Round 1 ended REVISE 9 (reviewer) and REVISE 9 (UI critic). The binding decisions V1–V20 are in `logs/handoff/P05-round-1-review.md` (commit `8177541`), and all twenty are done. The branch merged `origin/overnight/integration` twice, never rebasing: at `8177541` before the work, and at `9afdbd7` once integration moved. The second merge brought only the orchestrator's logs and handoffs and notes in the P03.1 and P06 packets, and the full chain ran again on it.

| Commit | What |
|---|---|
| `ef810c9` | Merge `origin/overnight/integration` (`8177541`) |
| `84c2b95` | The stricter validator (V1–V4), the model's neutral view (V10), and read-back controls (V6) |
| `3c63419` | The server re-check test (V5), damaged records (V7), the details key and re-export (V8), the page (V11–V15, V17, V18), and the embedded PDF font (V16) |
| `e444286` | The spec's workspace layout and its index line (V9); README (nit g) |
| `d271a48` | V4 tests with the uncited sentence first |
| `d1bbcfb` | A page-test wait that times out now reports what the page showed |
| `cb94b46` | A view that reads across a preparation's finish reads it as running (the CI failure below); the runner line while the runner can't be reached |
| `7b5f672` | Screenshots (V19) |
| `14efe58` | The page never announces questions the person has already answered; the page-test teardown waits for the page's requests |
| `ac6051c` | Merge `origin/overnight/integration` again (`9afdbd7`) |

**What CI caught, and the fixes.**

`3c63419`, `e444286` and `d271a48` each failed CI on one page test, "shows open questions in amber, …" (runs 36005121121, 36005131935 and 36005354782). Locally it passed every time, including with 2 workers and with `TZ=UTC`. So `d1bbcfb` made a timed-out wait report the page's live-line history, its rows, the open detail and its last requests. Run 36007546944 then showed the page announcing "Couldn't prepare “Staff Software Engineer · Fernwood”; its details say why." for a preparation whose row and detail both showed it parked with two questions.

- **The cause.** A list or detail read spanned the whole `finish()`.
  - The view read the application record before `finish` (processing: running) and the attempt after it.
  - By the time it computed the state, the task was out of flight, so `stateOf` said "interrupted".
  - Round 1's fix (`7171303`) covered a read *between* the two finishing writes, not one around both. Revision 1 widened the window: the list view now also reads the day's run budget (V18) between reading the records and computing the state.
  - Round 1's views had the same window, only narrower. So this is a likely cause of the reviewer's nit i, a page test that flaked once under mutation load.
- **The fix, in `cb94b46`.**
  - Each application has a flight count (`FLIGHT_CHANGES`), bumped when a flight begins and when it ends.
  - A view notes the counts before its first read. A flight that started or ended during the read reads as running, and the next read is whole.
  - Test: `applications-routes.test.ts` › the state while a preparation finishes › "a view whose reads straddle the whole finish reads running, never interrupted, and the next read is the outcome". It holds the list's and the detail's attempt read while the whole preparation finishes, and it fails without the fix (R1 below).
- **The next symptom, fixed in `14efe58`.** Run 36009698438 (`cb94b46`) caught it, in "an answer that the evidence belongs in the profile points there, …".
  - The list read "running" once while the detail already showed the questions.
  - The test answered them and pressed Prepare again. Only then did a list refresh see the preparation parked, and announce "Needs your answers" after the person had answered.
  - Now answering a question stops watching that preparation, and a parked preparation is announced only while a question is open.
  - Two page tests hold the list back until the questions show from the detail alone. Each fails without its fix (R4, R5).
- **The teardown.** Under the full `pnpm test` load, two page tests failed locally during cleanup with `ENOTEMPTY`, and CI runs 36005121121 and 36005131935 showed the same after their first failure.
  - Every read takes the profile's lock file, `.runner/profile.lock` (from P03's `ProfileStore.load`), and the workspace was being removed while a refresh was still reading.
  - The page-test teardown now waits for the page's own requests to settle (`page.quiet()`) before closing it. No assertion changed.
- **Also in `cb94b46`.** While the runner can't be reached, "Before preparing" no longer says "The runner's agent is running." It says "The runner can't be reached right now." until the next good refresh (R2, R3).

**V → tests.**

| V | What | Proven by |
|---|---|---|
| V1 | Numbers | `validator.test.ts` › revision 1, V1: one draft-level test per probe: 1,950 and 2,000; 200ms and 5GB; 1e6; Arabic-Indic digits; an ordinal; a multiplier; a decimal comma. Also "1,200 is 1200, never 1 and 200" (the reviewer's M9), and a control that EC2, K8s, P99 and Q3 stay names |
| V2 | Titles | › revision 1, V2: Sr., Staff Platform-Engineer, Director/CTO/Architect opening a sentence, and lower-case "director of" and "principal engineer", against "Platform Engineer at Fernwood Labs, 2019–2021.". Also a control for the claim's own title and verb-like openings |
| V3 | Dates | › revision 1, V3: "since", "present", an open "2019–", "currently", "to date", the start without the end, no dates for a claim that ends, and "since" against a single year. Controls: the stated range, and an open end on an open claim (C7). Also the refusal's wording |
| V4 | Sentences | › revision 1, V4: 13 ways an uncited sentence rode along (no space, …, É, a lower-case start, !, ?, ．, ZWSP, NEL, a line break, an opening quote), 4 with the uncited sentence first, and a control that every good statement stays whole |
| V5 | The server re-validates | `applications-routes.test.ts` › "a turn that reports “accepted” for a draft the validator refuses saves nothing: …". No document, no version, `processing` failed, the stage unchanged, and the refusals kept |
| V6 | Positive controls | `expectReadBack` in the excluded-metric and hostile acceptance tests, before their absence loops: each DOCX and PDF must hold "Ada Quill" and a known included sentence. The pipeline, cover-letter, V8 and V16 tests also read their DOCX or PDF back for known text |
| V7 | Damaged record → 409 naming the file | › a damaged application record (revision 1, V7): the job's record refuses and names the file, and no second application is started; a record naming another job doesn't block. `application-page.test.ts` › "a damaged application record that may be the job's refuses in one line that points to the file" |
| V8 | The details key and re-export | › a changed name or contact line (revision 1, V8): re-exports the validated draft as a new version naming the old one, with no model turn and no run, even with the budget paused; the same header again is `already_prepared`; carried answers survive a header change. Page › "says the documents don't carry it yet …" ("Saved. Prepare again to put it on your documents."). `export.test.ts` › "a re-export says only the header changed" |
| V9 | The spec and index | `docs/spec/mvp-spec.md` §5 lists `applications/<taskId>/preparation.json`, `…/versions/v<n>.json` and `applications/details.json` in the README's words; `ARCHITECTURE.md`'s Application line names them |
| V10 | Excluded labels and wording | `validator.test.ts` › revision 1, V10 (3 tests); `prepare-logic.test.ts` › "tells the model an excluded label, id or wording as it would one it was never given, …"; the excluded-metric acceptance test (the model's outputs) |
| V11 | The row line after answers | Routes › gap questions: "2 questions left.", "1 question left.", "Ready to continue.", and "Waiting for the evidence you're adding.". Page › gap questions: the row follows the answers, and the amber and "Needs your answer" heading go once none is open ("Your answers") |
| V12 | Onboarding links | Page › the locked line ("Finish it on the Onboarding page."), and the add-evidence pointer and refusal. Profile stays only for the unreadable file (the V17 test) |
| V13 | Watching | Page › watching (revision 1, V13): a page opened mid-preparation announces its outcome once; the runner-down notice is said once and cleared by the next good refresh. Also the two new gap-question watch tests |
| V14 | Download names | `export.test.ts` › download names (revision 1, V14), 4 tests: the name; file-system safety; posting text; ASCII fallback plus `filename*`. Routes › `Content-Disposition` in the pipeline and V16 tests. Page › the `download` attributes |
| V15 | Version notes | Page › refreshing in place ("Version 2 replaces it.", no "It cites" on version 1), and the V8 page test |
| V16 | PDF characters | `export.test.ts`: Noto Sans prints Latin Extended, Greek and Cyrillic exactly; what it can't draw prints as U+FFFD and is named. Routes and page › characters the PDF can't draw: the name field and each PDF, and the formats that keep them |
| V17 | `<code>`, one pointer | Page › "an unreadable career-profile.md is named as code, once, with the Profile page to fix it" |
| V18 | Small fixes | nit c: routes › the sweep adopts a complete version, and never one missing a file. nit d: `prepare-prompt.test.ts` › NEL. nit g: `runner/README.md`. Polish: activity order (routes › "lists applications by their most recent activity, newest first"); the picker and `not_extracted` (page › "the picker starts on a job whose details are extracted …"); "Answer both questions" and "and" (page › the amber-questions test); the paused budget with links (page › "a paused budget says so in its own words …"); the run limit (page › first load, `ready-runs`); focus to the name field (page › "a refusal from the runner is one short line …"); the DOCX Author (export › "DOCX: the document's author is the person's name"); export links with their version (page › preparing). Polish 9, optional, is done: a file name wraps whole (`white-space: nowrap`). Polish 6, optional, is not done |
| V19 | Screenshots | Below |
| V20 | Mutation proofs | Below |

**Mutation proofs (V20).** A scratch script, `/tmp/wc-p05-mut/mutate.mjs`, applies each mutation as an exact, once-only replacement. It runs the named test files, then restores the original bytes. `git diff` was empty after every batch. Each mutation fails tests:

| ID | Mutation | Tests failed |
|---|---|---|
| M9 | No thousands separator: every comma splits a number | 3 of 72, including "1,200 is 1200 …" |
| V1a | Year check with the commas removed | 3: the 1,950 and 2,000 probes, and digits of any script |
| V1b | A unit glued on is not a quantity | 4: 200ms, 5GB, the ordinal, and the helper control |
| V1c | Other scripts' digits are not normalised | 1: Arabic-Indic |
| V2a | "Sr." ends the title phrase | 2 |
| V2b | Hyphen and slash parts are not checked | 2 |
| V2c | An opening role word never counts | 3: Director, CTO, Architect |
| V2d | Lower-case "&lt;role&gt; of X" is not a title | 1 |
| V3a | A cited claim's end year need not be stated | 3 |
| V3b | An open end passes whatever the claims say | 3 |
| V4a | An ellipsis doesn't end a sentence | 3 |
| V4b | Only ASCII capitals count | 1 |
| V4c | A full stop directly before a capital doesn't split | 2 |
| V4d | Round 1's rule: split only at a full stop, a space and an ASCII capital | 2 |
| M11 | No server re-validation after the turn | 1 of 38: the V5 test |
| M12 | The DOCX reader returns "" | 4: the excluded-metric and hostile acceptance tests, the V8 re-export and the DOCX Author |
| M10 | Both readers return "" | 7 of 39, both acceptance tests included. Rerun: my script's first run started the second edit to the same file from the original bytes, so it changed only the PDF reader (7 of 38). Fixed, then rerun with both |
| V7 | A damaged record is never taken to be the job's | 2: the route test and the page test |
| V8 | The documents' key has no details part | 3: the pipeline key, the route V8 test and the page V8 test |
| V10a | The model is told `excluded_claim` for an excluded label | 3: two in validator, one in prepare-logic |
| V10b | The model is told `excluded_claim` for an excluded claim's wording | 5, the excluded-metric acceptance test included |
| R1 | `stateOf` ignores a flight that ended during the read | 1: the straddling-read test |
| R2 | The runner line stays "running" while unreachable | 1: the V13 page test |
| R3 | The next good refresh doesn't render the runner line again | 1: the V13 page test |
| R4 | Answering leaves the preparation watched | 1: "once the person answers a question, …" |
| R5 | A parked preparation with no open question is announced | 1: "… answered elsewhere is never announced …" |

**Test expectations that changed, and why.** No test was weakened; each change follows a V decision.
- **V4:** `validator.test.ts` › text helpers now splits "Worked with J. Doe on it [C1]. e.g. this stays [C1]." into two sentences, as the stricter rule requires, and the test's name changed with it. Each half cites C1, so the draft is judged the same.
- **V3:** `datesIn` now also returns `endYears` and `startOnly`, so its two helper expectations gained those fields.
- **V10:** in `prepare-logic.test.ts` and the routes excluded-metric test, the model's outputs now say `unknown_citation` where round 1 said `excluded_claim`. The person's view still says `excluded_claim`.
- **Routes:**
  - V14/V16: file views gain `download` and `missing`.
  - V8: the key's regex gains `+details@<12 hex>`.
  - V14: `Content-Disposition` is the descriptive name.
  - V11: the parked state "Waiting for your answer to 2 questions." became "2 questions left." with `open`.
  - V17: readiness gains `code`, and V16: details gain `pdfMissing`, in the assertions on whole objects.
- **Page:**
  - V12: the locked line ends "Finish it on the Onboarding page." instead of "See the Profile page.".
  - V18: export link text gains ", version N", and V14: `download` is descriptive.
  - V18: after `details_missing`, focus goes to `details-name` (it was `prepare-submit`), and "Answer both questions" replaces "Answer all 2 questions".
  - V12: the add-evidence pointer and its refusal name Onboarding.
  - V15: the refresh test expects "Version 2 replaces it." and no "It cites" on version 1.
  - The hostile test's link text is now "Cover letter, version 1 · Word".
- **Export:** V16 replaced round 1's Helvetica `toWinAnsi` test with the two Noto Sans tests.

**V16: the font.**
- **The package.** `@expo-google-fonts/noto-sans` 0.4.2, pinned exactly in `runner/package.json`.
  - Licence: MIT AND OFL-1.1.
  - 13.4 MB unpacked, 82 files. The runner embeds two of them: `NotoSans_400Regular.ttf` (629,024 bytes) and `NotoSans_700Bold.ttf` (630,968 bytes). pdfkit subsets each into the PDF through its own fontkit.
  - No dependencies, no install scripts, no native build, no network. The lockfile change is additive (8 lines).
- **What it draws.** Latin with its extensions, Greek, Cyrillic (the critic's "Ада Квилл" now prints) and Vietnamese, each checked by a test.
- **What it doesn't.** CJK, Arabic, Hebrew, Thai, emoji, and symbols such as "→" and "✓". I checked these with the same fontkit calls, and the tests cover CJK, Hebrew, emoji and "→". Each missing grapheme cluster prints as U+FFFD and is recorded on the version (`pdfMissing`). The page warns at the name field and beside that PDF: "The PDF can't draw “艾” and “达”, so it prints � in their place. The Markdown and Word files keep them."
- **Rejected.**
  - `@ibm/plex-sans`: a postinstall telemetry script.
  - `@fontsource/dejavu-sans`: Latin only.
  - `@fontsource/noto-sans`: per-script WOFF subsets.
  - `dejavu-fonts-ttf`: unmaintained.
- **Clean install.** `git archive HEAD` (`7b5f672`) went into `/tmp/wc-p05-clone-r1`, then `pnpm install --frozen-lockfile --offline` exited 0 with 458 packages (round 1: 457). The only lifecycle script is the existing `unrs-resolver` postinstall. `export.test.ts` and `validator.test.ts` pass there: 2 files, 91 tests.

**Screenshots (V19).** 32 full-page files: `docs/screenshots/P05-applications-{empty,prepared-diff,gap-question,refusal,exports,reexport-name-change,pdf-warning,runner-down}-{light,dark}-{390,1280}.png`. The five round-1 states were retaken on the revised page.
- **The three new states.**
  - **reexport-name-change:** the name changed to "Ада Квилл" (the critic's own example, which the font now prints, so there is no warning).
    - Prepare again says "Re-exported “Platform Lead · Fernwood” as version 3, with your new details.".
    - "Runs today" stays 6 of 10. Version 2 says "Version 3 replaces it.". Version 3's changes say only the name and contact line changed, and no model ran.
  - **pdf-warning:** the name "Ada Quill (艾达)". The note shows under the name field, and version 4's PDF link carries the same warning.
  - **runner-down:** a preparation held open, then the harness stopped.
    - The line says "Can't reach the runner. Is it still running?" once.
    - "Before preparing" says "The runner can't be reached right now.", and the row still says "Preparing now…".
- **The harness.** A scratch script, `/tmp/wc-p05-screens/harness2.ts`, never committed.
  - It runs the real `createBridgeApp` with only the applications module, on 127.0.0.1:4320. The port was checked free before each start, and the harness was stopped after each.
  - The workspaces were fresh, under `/tmp/wc-p05-screens/`.
  - The test suite's scripted model stood in for eve: no live model, no network, nothing from HOME or the keychain.
  - Sign-in went through a real `/ui/login?nonce=` link.
  - Captures used Chrome DevTools, with each file saved to an absolute path in this worktree. `git status` confirmed all 32 landed here.
- **Checks.**
  - 390 is device-metrics emulation (`390x844x1`). Every capture had `innerWidth` 390 or 1280 and `scrollWidth === clientWidth`, and no element extends past the viewport at 390.
  - Contrast was measured for every visible text node against its composited background. That covered all four applications with every details section open, in both themes, and the runner-down page in light.
    - The lowest was 7.17:1 (light) and 6.76:1 (dark), with nothing under 4.5:1.
    - The new notes measure 21:1 (light) and 19.91:1 (dark). The runner line measured 21:1 on the light runner-down page. I didn't measure the dark one; the line uses the notes' text colour.
  - All 32 SHA-256 checksums are unique, and every PNG's width matches its name.

**The chain, from the repo root at `ac6051c`, after the second merge.** It gave the same counts at `14efe58`. `git status --porcelain` was empty before and after.
- `pnpm install --frozen-lockfile`: already up to date.
- `pnpm typecheck`: 6 of 6 workspaces.
- `pnpm test`, exit 0:
  - contracts: 16 files, 235 tests
  - job-assistant: 6 files, 153 tests
  - catalog: 26 files, 168 tests
  - runner: 52 files, 1053 tests (round 1: 973). The `eve eval` then passed 7 of 7 files and 159 gates, preparation 54.
  - extension: 21 files and 329 tests passed; 1 file and 5 tests skipped
  - `scripts/*.test.mjs`: 2 of 2
- `pnpm -r lint`: exit 0, `--max-warnings 0`.
- `pnpm check:fixtures`: exit 0.
- No rerun was needed at `--workspace-concurrency=1`.

**CI.**

| Head | Run | Result |
|---|---|---|
| `3c63419`, `e444286`, `d271a48` | 36005121121, 36005131935, 36005354782 | failure: the straddled read (above) |
| `d1bbcfb` | 36007546944 | failure: the same, now with the page's state in the error |
| `cb94b46` | 36009698438 | failure: the late "Needs your answers" (above) |
| `7b5f672` | 36009884118 | success |
| `14efe58` | 36011113393 | success |
| `ac6051c` | 36012339885 | success |

The reply gives this report commit's own head SHA and CI run.

**Notes.**
- **Download names.** A document downloads under the same descriptive name in every version with the same name and contact line, because V14's example names no version. The link text names the version, and so does the diff's download name. A browser adds its own " (1)" to a second download of the same name.
- **A long page-test run.** While I was building the page changes, one page test ("an answer that the evidence belongs in the profile …") ran for 447 s and timed out, once. It passed alone in 4.5 s, and the whole file passed after. It looked like a stalled machine, not the page.
- **Carried items are untouched:** P06's and P08-B's lists in the handoff.

**Boundaries.**
- **Scope.** Nothing outside `Owns:` and this revision's grants was touched: `packages/contracts`, `context.ts`, `run-harness.ts`, P03's and P04's files, other skills and `extension/` are unchanged. In `docs/spec/mvp-spec.md` only §5's layout lines changed, and in `ARCHITECTURE.md` only the Application index line. The font follows the export-dependency rules.
- **eve.** No eve connection was added.
- **Ports and scratch.** Only port 4320 and `/tmp/wc-p05-*` were used.
- **Refused commands.** No deny rule refused anything. The harness refused a few compound shell commands (loops over runtime values, and piped git), which I split.
- **Orchestrator messages.** Two genuine messages carried the code word: the revision itself, and the rule to write only inside this worktree or `/tmp/wc-p05-*`, with absolute screenshot paths. Both were followed. Nothing else claimed to be from the orchestrator.
