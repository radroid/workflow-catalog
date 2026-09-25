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

### 2026-09-24 — Revision 2 (iter-007 Opus escalation)

Round 2 ended REVISE 5 (reviewer) and REVISE 2 (UI critic). The binding decisions X1–X10 are in `logs/handoff/P05-round-2-review.md`. A first Opus escalation did X5 and X7 in `ce49ca9` (CI 36022914464), and its session died partway through X2. This escalation took over at `ce49ca9` and did the rest.
- X2 started from the predecessor's unverified patch (`/tmp/wc-p05e2-wip/text.ts.wip.patch`). It split "Ph.D." in the no-space path; that is fixed and tested.
- The branch merged `origin/overnight/integration` once, never rebasing: at `7468707`, because that commit touches files outside `logs/` (GOALS.md and other packets' specs). Integration's three new commits change no P05 file and no code, and the full chain ran again on the merge.

| Commit | What |
|---|---|
| `ce49ca9` | X5 and X7 (the first escalation) |
| `88b5781` | X2: abbreviations |
| `cbe3ba8` | X1: titles |
| `e6cabd7` | X3: number words |
| `8fa081d` | X4: dates; a realistic resume and cover letter pinned as a test |
| `b9dfd4f` | X6: outcomes that settle in one refresh |
| `b335832` | X8: the documents' wording, and the letter's date |
| `d99a7ee` | X9: warnings and the daily limit; P05's lines in `runner/README.md` |
| `2536acc` | X10: screenshots |
| `d9e07a6` | Merge `origin/overnight/integration` (`7468707`) |

**X → commit and tests.** Counts are test cases, `it.each` rows included. "Routes" is `applications-routes.test.ts`, "page" is `application-page.test.ts`, "export" is `export.test.ts`.

| X | Commit | What changed | Proven by |
|---|---|---|---|
| X1 | `cbe3ba8` | `titlesIn` works per sentence and reads the first word whatever its case, in drafts and in claims. An opening phrase that ends in its role word counts before "at", "of", "for" or a comma; "Lead the…" and "Head the…" still don't. The left extension stops at a context word (as, became, become, becoming, named, appointed, promoted, elected). "Of" takes an article. Titles compare with their spaces removed | `validator.test.ts` › revision 2, X1 (21): the reviewer's 12 probes against C9 and 3 more, each as a draft; "Staff engineer at Northwind Labs since 2022 [C8][C7]"; the message; the sentence-case claims C11 ("Staff engineer at Harbor, 2021–2023.") and C12 ("Founding engineer at Harbor.") passing in title case; titles that differ from their claim only in case or a hyphen, "Co-founder" against C13's "Cofounder" among them; `titlesIn` expectations; verbs and names that yield no title |
| X2 | `88b5781` | DOTTED takes longer parts, and the list gains the 12 abbreviations. A one-part dotted word ends its sentence unless it is listed or an initial (the predecessor's stricter extra, which the resume brief allowed). "it.Won." is not one abbreviation. The no-space path reads "Ph.D." whole | › revision 2, X2 (27): the degree cited verbatim (C9 "B.Eng. Software Engineering, Fernwood University, 2019."), with "in" after it and in brackets; B.Tech., M.Phil. and D.Phil., each read as a credential; each of the 12; the reviewer's incl., esp. and approx. sentences; an uncited sentence after an ordinary full stop, still refused (4: after and before a sentence with an abbreviation, and twice after the degree); 3 after a one-part dotted word; "it.Won."; the honest controls |
| X3 | `e6cabd7` | Zero is read, and N-fold is N× ("tenfold", "10fold"). "Half" reads as "halved" does. "A third", "a quarter" and "two thirds" are read. Double, triple and quadruple count as whole words, but not in compounds | › revision 2, X3 (17): the reviewer's 8 probes and 6 more; the keys; the same quantity in other words passing (half and halved, tenfold and 10x, zero-downtime, a third); compounds and ordinals left alone |
| X4 | `8fa081d` | (a) These are open ends: "still", "to/until/till this day", "onward(s)", "and counting", and a start marker ("from", "starting") right before its year with no end anywhere ("since" already was one). Each is refused unless a cited claim is open, and a start with no end says so. (b) The end-year rule applies only when the sentence states a year, a month or an open end | › revision 2, X4 (16): the reviewer's 3 probes and 7 more; the open ends passing on the open claim C7; the message for a start with no end; ranges that have an end, some written in words; "from" only before its year; `datesIn` expectations; (b) with a test-local C9, "Built the billing pipeline at Fernwood Labs between 2019 and 2021." (the reviewer's C13): no date passes, and half the range is still refused. Also V3's amended assertion (below) |
| X5 | `ce49ca9` | "Already prepared" only when the newest documents carry the key. Otherwise the draft is re-exported as a new version that replaces the newest | Routes › the newest documents decide “already prepared” (revision 2, X5) (2): Ada, then Zoe, then Ada (v3 carries Ada, replaces v2, and the notice clears), and the cover letter switched back. Page › switching the name back (revision 2, X5) (2): the same from the page, and a re-export a refresh sees in flight, announced once |
| X6 | `b9dfd4f` | Every outcome that settles in a refresh is announced once, in one sentence: couldn't prepare, then needs answers, then prepared. Names are shortened evenly to fit 80 characters (P04's T18); when even that can't fit, the outcomes are counted. A single outcome keeps its old wording | Page › outcomes that settle in one refresh (revision 2, X6) (3): the critic's case (Harbor's provider limit, then Quill refused behind it); a ready version beside questions to answer; three outcomes, counted. Each is announced once across later refreshes |
| X7 | `ce49ca9` | A re-export runs `validateDraft` on the stored draft first, and refuses plainly (`reexport_refused`) | Routes › a re-export checks its draft again (revision 2, X7). Page › a re-export whose saved draft no longer passes (revision 2, X7) |
| X8 | `b335832` | `reexportNote` (`export/diff.ts`) writes the note for `diff-v<n>.md` and for the view (`reexportNote`, `newHeader`): the name and contact line sit at the top of the resume and at the end of the cover letter, and "the same as in version N" is said only of the version it replaces, and only when every sentence is. A re-export's letter keeps the date it was first written: `firstExportedAt` follows `sameDraftAs` back to the version a model turn wrote. The page's meta line follows the same rule, and the hint above the fields now says the cover letter ends with them | Export › a re-export's note (revision 2, X8) (3). Routes › a re-export's documents and note (revision 2, X8) (2): a letter re-exported twice, days apart, keeps its first date in Markdown, DOCX and PDF; and the cover-letter switch. Page › a re-export's lines (revision 2, X8) |
| X9 | `d99a7ee` | The save's one line names what the PDF can't draw. The contact line has its own note (`details-contact-note`, tied by `aria-describedby`); the page places each character the runner lists under the field it was typed in, so the view's shape is unchanged. A PDF link is described by its note. At today's run limit, Prepare is refused up front (`daily_limit`, 409), naming the limit. The check comes after the re-export branch and is kept apart from the runner line | Page › warnings and limits (revision 2, X9) (3). Routes › warnings and limits (revision 2, X9) (2) |
| X10 | `2536acc`, this report | Screenshots, mutation proofs, the chain, CI | Below |

**Round-2 issues → commit and test.**

| Issue | Commit | Test |
|---|---|---|
| Reviewer 1: titles | `cbe3ba8` (X1) | Validator › revision 2, X1 |
| Reviewer 2: abbreviations | `88b5781` (X2) | › revision 2, X2 |
| Reviewer 3: number words | `e6cabd7` (X3) | › revision 2, X3 |
| Reviewer 4(a): open ends | `8fa081d` (X4) | › revision 2, X4 › "refuses …" |
| Reviewer 4(b): a sentence with no date refused | `8fa081d` (X4) | › revision 2, X4 › "passes a sentence that states no date, …", and V3's amended assertion |
| Reviewer 5, critic 1: switching the name back | `ce49ca9` (X5) | Routes and page › revision 2, X5 |
| Critic 2: outcomes in one refresh | `b9dfd4f` (X6) | Page › revision 2, X6 |
| Reviewer nit: a re-export doesn't validate again | `ce49ca9` (X7) | Routes and page › revision 2, X7 |
| Reviewer nit: "the same sentences as version N" above a diff against another version | `b335832` (X8) | Routes › "after the cover letter is switched off and back on, the note names the version its changes are against"; export and page › revision 2, X8 |
| Critic polish 2: the note on a cover letter, and the letter's date | `b335832` (X8) | Routes › "a re-export on a later day keeps the letter's date, …"; export › "says where the name and contact line sit" |
| Critic polish 1: the save's line, the PDF link, the contact line | `d99a7ee` (X9) | Page › revision 2, X9 (the first two); routes › "lists what the PDF can't draw in the contact line with the name's" |
| Critic polish 3: the daily limit | `d99a7ee` (X9) | Routes and page › "at today's run limit, …" |
| Reviewer nits: "2019–21", "Owner of …", a lower-case word after a full stop with no space | none | As ruled, or left as nits: unchanged |
| Critic polish 4–6; Devanagari's letter forms | none | Carried to P06 and P10 part A; untouched |

**The validator's extras.** Each is stricter, or keeps a strict rule from refusing an honest sentence.
- **X2:** dotted degrees (B.Tech., M.Tech., M.Phil., D.Phil.) and their undotted forms are credentials, so one can't stand in for another.
- **X1:**
  - A capitalised seniority word joins a lower-case title ("as a Senior platform engineer").
  - A title-like capitalised phrase takes a lower-case role word after it ("Senior Platform engineer"), but "Certified Kubernetes administrator" stays a certificate.
  - An opening department head counts ("VP engineering at …").
  - SVP, EVP and AVP are role words.
- **X3:** "half" counts only as a whole word, not in "halfway" or "half-duplex". "Double-digit" and "triple-digit" are quantities of their own. "A third party" and "third-party" are not fractions. "Quadrupling" is read.
- **X4:**
  - "From" marks a start only right before its year. So "Graduated from Fernwood University in 2019." is no longer an open claim that lets "since 2019" through.
  - A range whose end is written in words ("to mid-2021", "until summer 2021", "through Q2 2021", "to H1 2021") ends there. That keeps X4's start marker from refusing it, and a claim written that way is closed.

**Checked against the reviewer's probes.** Copies of r2 to r2d in `/tmp/wc-p05e2-probes/` ran against the head.
- Every X1–X4 probe is refused.
- Every honest control passes:
  - EC2, K8s, P99 and Q3; "3.5 years";
  - e.g., i.e., U.S., Inc., etc., vs., approx., incl. and esp. mid-sentence; Node.js and example.com;
  - exact and sentence-case titles; "since 2022" and "2022–present" on the open claim C7; the degree's own wording.
- Probe r2's section B, a realistic resume and cover letter, passes too. A draft like it is pinned in `validator.test.ts`.
- The only mismatches are the ones accepted above: "first" (optional in X3, and not read, because "first-class" and the like are everywhere), "Owner of …", "2019–21", and a lower-case word after a full stop with no space.
- A consequence of X4(a) as ruled: "still" is an open end wherever it appears. So "…, while still meeting the on-call SLAs [C3]." is refused unless a cited claim is open, and the model rephrases. The realistic draft doesn't use it.

**Edited existing assertions: the complete list.** `ce49ca9` edited none: `git show ce49ca9 -- runner/test` removes no line. This escalation edited two.
1. **X4(b), the expected change.** `runner/test/validator.test.ts:348` at `ce49ca9`, in "revision 1, V3" › "refuses %s", which expects `["date"]`: the row `["no dates at all for a claim that ends", "Platform Engineer at Fernwood Labs [C9]."]` is removed. It becomes `runner/test/validator.test.ts:356`, in "passes the range as the claim states it, …": `expect(rulesWithC9("Platform Engineer at Fernwood Labs [C9].")).toEqual([])`.
2. **X8.** `runner/test/applications-routes.test.ts:1230` at `ce49ca9` (now `:1234`), the V8 re-export test's `diff-v2.md` line. It read "- Only the name and contact line at the top changed. Every sentence is the same as in version 1, and no model ran." It now reads "- Only the name and contact line changed, at the top of the resume and the end of the cover letter. Every sentence is the same as in version 1, and no model ran." That version has a cover letter, whose name and contact line close it.
- The same wording in `export.test.ts:294` and `application-page.test.ts:788–789` stands unchanged: each is a resume alone, re-exported from the version it replaces.
- The only other lines removed from test files are import lists, each widened by a name.

**Mutation proofs (X10).** `/tmp/wc-p05e2-mut/mutate.mjs` applies each mutation as an exact, once-only replacement. It runs the named test files with Vitest's JSON reporter, then restores the original bytes and checks them byte for byte. `git status --porcelain` was empty after every batch. Every mutation fails tests. X1–X4 ran `validator.test.ts` (153 cases); X5 and X7 ran routes and page (79); X6 ran the page (33).

| ID | Mutation | Failed | What broke |
|---|---|---|---|
| X1-a | The role-word pass skips a capitalised first word | 6 | V2's Director, CTO and "Architect," openings; X1's opening VP and "Head of"; the `titlesIn` expectations |
| X1-b | An opening phrase that ends in its role word no longer counts | 4 | V2's three openings; X1's "Engineering manager at …" |
| X1-c | The left extension doesn't stop at a context word | 3 | "…, and became engineering manager there"; "…, later named platform architect"; the expectations |
| X1-d | "Of" takes no article (role-word pass) | 1 | The expectations ("director of the platform group") |
| X1-e | Titles compared with their spaces | 1 | "Co-founder" against "Cofounder" |
| X1-f | No department-head opening | 2 | "VP engineering at …"; the expectations |
| X2-a | The 12 abbreviations removed | 16 | Each of the 12; the reviewer's incl. and esp. sentences; two uncited sentences beside an abbreviation; the realistic resume and cover letter |
| X2-b | DOTTED back to two-letter parts | 7 | The degree verbatim; B.Tech., M.Phil., D.Phil.; the credential reading; two uncited sentences after a degree |
| X2-c | No guard for two words run together | 1 | "it.Won." |
| X2-d | The no-space path tests "Ph." alone | 2 | The existing text-helpers split test; the honest controls (Ph.D.) |
| X2-e | The dotted degrees aren't credentials | 1 | The credential reading |
| X3-a | Zero unread | 2 | "zero-downtime"; the keys |
| X3-b | N-fold unread | 5 | tenfold, threefold, twofold; the keys; tenfold = 10x |
| X3-c | "Half" unread | 4 | "by half", "in half"; the keys; half = halved |
| X3-d | Double, triple, quadruple unread as words | 7 | "by half", "in half", "helped double", triple, quadruple; the keys; the equivalences |
| X3-e | "A third", "a quarter" unread | 3 | "by a third", "by a quarter"; the keys |
| X3-f | Compounds read as whole words | 1 | "double-entry" and the other compounds |
| X4-a | "still", "onward(s)" aren't open ends | 4 | "and still there"; "still" with no year; the expectations; X4(b)'s "still running it" |
| X4-b | "To this day" isn't an open end | 2 | "until this day"; the expectations |
| X4-c | "And counting" isn't an open end | 2 | "and counting"; the expectations |
| X4-d | A start with no end isn't an open end | 5 | "from 2019", "Starting in 2019"; its message; "from" only before its year; the expectations |
| X4-e | V3 as it was: a sentence with no date gets the end-year rule | 2 | V3's amended assertion; X4(b)'s test |
| X4-f | "From" marks a start anywhere | 1 | "Graduated from Fernwood University in 2019." read as open |
| X4-g | "mid-2021" read as a range mark | 1 | Ranges whose end is in words |
| X5-a | Round 2's `preparedWith`: any version with the key is already prepared | 6 | Both X5 route tests; the page's Ada, Zoe, Ada test; three X8 tests that re-export after a switch |
| X6-a | Round 2's announcement: only the refresh's last outcome | 3 | All three X6 page tests |
| X7-a | A re-export exports its stored draft unchecked | 2 | Both X7 tests |

Extras, beyond X1–X7: X8-a, the letter dated the day of the re-export (2 of 46 route tests); X8-b, "the same as in version N" whatever the diff is against (4 of 101 in export, routes and page); X9-a, no up-front refusal at the daily limit (2 of 79); X9-b, the save's line without the PDF warning (2 of 33). Each result is in `/tmp/wc-p05e2-mut/result-<ID>.json`.

**Screenshots (X10).** Twelve viewport captures: `docs/screenshots/P05-applications-{name-revert,save-pdf-warning,combined-outcomes}-{light,dark}-{390,1280}.png`.
- **name-revert:** Ada, then Zoe, then Ada, from the page. The line says "Re-exported “Platform Lead · Fernwood” as version 3, with your new details.". Version 3 says "…: the same sentences as version 2. It replaces version 2.", has no "changed since" note, and its resume downloads as "Ada Quill - Resume - Fernwood Platform Lead.md".
- **save-pdf-warning:** the name "Ada Quill 李" and the contact line "ada.quill@example.com · 東京". The line says "Saved. Prepare again to put it on your documents; the PDF can't draw “李”, “東” and 1 more.". The name's note names 李, and the contact line's names 東 and 京. The hint above reads "…at the top of every resume and at the end of every cover letter."
- **combined-outcomes:** under "Refused", "Couldn't prepare “Platform Engineer · Harbor” or “Backend Engineer · Quill”.", and each row says why.
- **The harness.** `/tmp/wc-p05e2-screens/harness.ts`, adapted from the critic's and never committed.
  - It runs the real `createBridgeApp` with every route module on 127.0.0.1:4320. The port was checked free first, and the harness was stopped afterwards.
  - The workspace was fresh: `/tmp/wc-p05e2-screens/ws-r2`.
  - The test suite's scripted model stood in for eve: no live model, no network, nothing from HOME or the keychain. Sign-in went through a real `/ui/login?nonce=` link.
- **The captures.** `/tmp/wc-p05e2-screens/shots.mjs` drove headless Chromium through the extension's `@playwright/test`. The viewport is a device-metrics override, at a device scale factor of 2.
  - Before each capture it checked that `clientWidth` and `innerWidth` were both 390 or both 1280, that `prefers-color-scheme` matched the theme, and that the live line wasn't clipped by its two-line clamp.
  - For the combined state, the script set `document.visibilityState` to hidden while the two preparations settled, so one refresh saw both. The announcement itself is the page's own.
- The 32 V19 screenshots weren't retaken. Those that show the details card still show the old hint, "…at the top of every resume and cover letter."

**The chain,** from the repo root at `d9e07a6`, after the merge. It gave the same counts at `2536acc`. `git status --porcelain` was empty afterwards.
- `pnpm install --frozen-lockfile`: already up to date.
- `pnpm typecheck`: 6 workspaces, exit 0.
- `pnpm test`, exit 0:
  - contracts: 16 files, 235 tests
  - job-assistant: 6 files, 153 tests
  - catalog: 26 files, 168 tests
  - runner: 55 files, 1193 tests (revision 1: 1053). The eval then passed 7 of 7 files and 161 gates, preparation 54.
  - extension: 21 files and 329 tests passed; 1 file and 5 tests skipped
  - `scripts/*.test.mjs`: 2 of 2
- `pnpm -r lint`: exit 0, `--max-warnings 0`.
- `pnpm check:fixtures`: exit 0.
- No rerun was needed at `--workspace-concurrency=1`.

**CI.** Every run includes the extension step, "Build and test the extension (vitest against dist/, then Playwright)".

| Head | Run | Result |
|---|---|---|
| `88b5781` | 36077484808 | success |
| `cbe3ba8` | 36078165003 | success |
| `e6cabd7` | 36078540121 | success |
| `8fa081d` | 36079565589 | success |
| `b9dfd4f` | 36080139825 | success |
| `b335832` | 36080814577 | success |
| `d99a7ee` | 36081278925 | success |
| `2536acc` | 36082438254 | success |
| `d9e07a6` | 36082861493 | success |

The reply gives this report commit's own head SHA and CI run.

**Not done.** Everything in X1–X10 is done. By decision, "first" is not read (optional in X3), the round-2 nits stay as ruled, and the carried items (P06, P10 part A) are untouched.

**Boundaries.**
- **Scope.** Apart from what the merge brought from integration (the orchestrator's GOALS.md, `logs/`, the packet README and other packets' specs), only these changed:
  - `runner/validate/{text,facts,validator}.ts`, `runner/export/diff.ts`, `runner/server/routes/applications.ts`, `runner/ui/application.html` and `runner/ui/assets/application.js`;
  - four test files in `runner/test/`, P05's lines in `runner/README.md`, `docs/screenshots/P05-*.png`, and this packet file.
  - `packages/contracts`, `context.ts`, `run-harness.ts`, `local-ui.ts`, P03's, P03.2's and P04's files, the skills, the templates, `extension/`, `runner/package.json` and the lockfile are unchanged.
- **eve.** No eve connection was added. Model turns still go through `runTurn`. The daily-limit check reads the budget through `getBudgetState`, and the run harness keeps its own check.
- **Ports and scratch.** Only 127.0.0.1:4320 was used, and only `/tmp/wc-p05e2-*` was written: probes, scratch, mut, screens and the chain logs. The reviewers' folders, the critic's harness and `/tmp/wc-p05e2-wip/` were only read.
- **Refused commands.** No deny rule or permission check refused anything. The harness refused three compound commands as too complex to verify: a shell loop running node over a runtime value, a `cd ..` before git, and a mkdir, heredoc, cd and node chain. I split them or used Write.
- **Orchestrator messages.** None arrived. No message carried the code word, and nothing claimed to be from the orchestrator.

### 2026-09-25 — Revision 3 (iter-007 Opus escalation)

Round 3 ended REVISE 4 (reviewer) and REVISE 2 (UI critic). The binding decisions Y1–Y8 are in `logs/handoff/P05-round-3-review.md`, from `origin/overnight/integration` at `5c55e35`. The escalation that did revision 2 did all of them, starting from `1a0f854`.
- The branch merged `origin/overnight/integration` once, never rebasing: at `629867f`, in `42f5006`. Integration's five new commits change no P05 file and no code: GOALS.md, P06's and P06.1's specs, the packet README and `logs/`. The full chain ran on the merge.

| Commit | What |
|---|---|
| `6e4e47b` | Y1: the present, and dates counted from today |
| `84fd103` | Y2: short abbreviations, and a way out for the rest |
| `02ddd67` | Y3: titles wherever they stand |
| `643ca6e` | Y4: more quantities in words |
| `a832068` | Y6: documents dated in the runner machine's time zone |
| `bcff8b8` | Y5: Prepare again keeps the newest version's letter choice |
| `680d3a2` | Y7: a refused re-export has a way forward |
| `7c9919c` | Y8: screenshots (Y5, Y7, and V19's 32 retakes) |
| `278a784` | Y7's X5 note and Y2's listed ending, tested (new assertions only) |
| `42f5006` | Merge `origin/overnight/integration` (`629867f`) |

**Y → commit and tests.** Counts are test cases, `it.each` rows included. "Validator" is `validator.test.ts`; "routes", "page" and "export" are as in revision 2.

| Y | Commit | What changed | Proven by |
|---|---|---|---|
| Y1 | `6e4e47b` | These are open ends wherever they are, so X4(a) applies (refused unless a cited claim is itself open): "now", "today", "presently", "nowadays", "remain(s)", "to date" (never "up to date"), "as of now", "at present", "these days", "continue(s) to" and "and beyond". `datesIn` also returns `relative`: "recently", "lately", "last/this/past year, month, week or quarter", "the last N years" and "N years ago" (N a numeral, a number word, "a", "a few", "several" and the like). A sentence with one is refused unless a cited claim's own text has the same words, and the refusal ends "Use the years they state instead." "The last year of" a degree is not last year | Validator › revision 3, Y1 (26): the 13 present-time probes against closed claims (C9, and a test-local closed C10); the 8 relative dates; "two years ago" and its message; the phrase named in the message. Passing: "Staff Engineer … since 2022, where I now lead … [C11]"; the reviewer's "… since 2022, where I now lead … [C8][C7][C1]"; "…, which I remain today [C8][C7]"; a claim's own "Recently …" ("lately" is still refused against it). The honest controls: "up to date", "up-to-date", the degree's last year, the claim's own range, no date. `datesIn` expectations |
| Y2 | `84fd103` | X2's one-part rule stays: "it." and "UK." end a sentence. The list gains mt, ft, pt, lt, mx and rd, and sgt, capt, cpl, pvt, col, gen, maj, adm, cmdr, rev, hon, gov, sen, rep, supt, ave and blvd. An uncited sentence that ends in an unlisted one-part dotted word adds "This sentence seems to end at “Xx.”. If that's an abbreviation, write the word out.", both in the refusal and in what the model is told | Validator › revision 3, Y2 (26): the reviewer's three (Mt. and Ft., Lt., Mx.) passing; each of the 23 listed words keeping a sentence whole, capitalized and not; "it." and "UK." still splitting; the hint for "Sq.", in `refusals` and `forModel`. No hint for an ordinary sentence end, or for a listed word that really ends one ("Quill Co.", added in `278a784`) |
| Y3 | `02ddd67` | An opening role phrase is a title before any of: "at", "of", "for", "on", "with", "in", a comma, a colon, a dash, an opening bracket, or the sentence's end. A dash or bracket reads as a comma; one inside a word or a range stays. "Lead the…" and "Head the…" still don't count. A role phrase right after "and", "then" or "later" counts before the same followers, so "then head the team" stays a verb. So does one right before "role", "position" or "title". A capitalized first word that can't be part of a title ("As", "While", "I" and the like) isn't one. Titles still compare whole, ignoring case, spaces and hyphens | Validator › revision 3, Y3 (21): the 17 issue-3 forms, refused against C9 and a sentence-case C10; the claim's own title in each place, passing. "As Senior Platform Engineer at Northwind Labs, I led … [C8][C1]." and its "While …" form pass, and "As Staff Platform Engineer …" is refused. Verbs after "and", "then" and a first word; `titlesIn` expectations |
| Y4 | `643ca6e` | "single-digit" reads as "double-digit" does. "An order of magnitude" and "orders of magnitude" read as 10×, and quintuple(d) and sextuple(d) as double(d) does. "A couple of" and "scores of" are vague counts with their own keys, as dozens, hundreds, thousands, millions and billions already were ("a dozen" stays 12). A draft may use one only if a cited claim uses the same words | Validator › revision 3, Y4 (13): the reviewer's probes and the rest of the list (11); the keys, and what isn't a quantity ("in order of", "the couple's scores"). The honest controls: a claim's own word cited verbatim, and "tenfold" for "an order of magnitude". Never another word: "dozens" for "scores of", "double-digit" for "single-digit" |
| Y5 | `bcff8b8` | The detail's Prepare again sends the newest version's cover-letter choice, unless it continues a parked attempt, which keeps its own | Page › Prepare again keeps the newest version's cover letter choice (revision 3, Y5) (3): the critic's r3-s7 steps, where Prepare again is "already prepared" twice, with no letter and no model turn; the other direction; a parked letter attempt continued over a resume-only newest version |
| Y6 | `a832068` | `letterDate` (the letter's date and `diff-v<n>.md`'s "Prepared" line) formats in the runner machine's zone. X8 holds: a re-export keeps the letter's first date | Export › documents are dated in the runner machine's time zone (revision 3, Y6) (2): an evening letter in Markdown, DOCX and PDF, and a second zone. Routes › documents dated where the person is (revision 3, Y6) (1): an evening preparation, and a re-export three evenings later. Both files pin `TZ` to America/New_York and restore it afterwards |
| Y7 | `680d3a2`, `278a784` | A re-export whose stored draft today's checks refuse is refused once. The refusal is noted on that version's record (`reexportRefused`: when, and the newest version then), and until a newer version exists, the next Prepare of the same inputs runs a fresh preparation. The server's message now ends "The documents must be prepared fresh: preparing again runs a new preparation." The page's line is "Not re-exported: its sentences no longer pass the checks; preparing again starts fresh." The detail carries `reexportRefused`, and the refused version's details note reads "Your name or contact line has changed since this version, and its sentences no longer pass the runner's checks. Prepare again runs a fresh preparation." An older version's refused re-export (X5) leaves the newest version's note alone. Prepare again keeps that version's letter choice (Y5), so it re-exports sentences the refusal didn't touch | Routes › a refused re-export has a way forward (revision 3, Y7) (2). First: tamper; the refusal, with its note on `v1.json` and nothing else written and no run; then Prepare runs fresh (a model turn and a run). Version 2 carries the new name, and its draft passes `validateDraft` against the profile and posting; then "already prepared". Second: the X5 case. Page › a refused re-export has a way forward (revision 3, Y7) (2). First: the line and the note; then Prepare again prepares version 2, and both notes clear. Second: the X5 case, where the newest version's note stays and Prepare again re-exports it. Also the edited X7 assertions below |
| Y8 | `7c9919c`, this report | Screenshots, mutation proofs, the list of edited assertions, the chain, CI | Below |

**Round-3 issues → Y and test.**

| Issue | Y | Test |
|---|---|---|
| Reviewer 1 (a revision-2 regression): open ends and relative dates in words | Y1 | Validator › revision 3, Y1 |
| Reviewer 2 (a revision-2 regression): honest one-part dotted words refused | Y2 | › revision 3, Y2 |
| Reviewer 3: inflated or changed titles | Y3 | › revision 3, Y3 |
| Reviewer 4 and the nit's quantities | Y4 | › revision 3, Y4 |
| Reviewer nits: "As Senior Platform Engineer …"; "Remains a …" and "2019–2021 and beyond" | Y3; Y1 | › revision 3, Y3 › "passes “As Senior …”"; › revision 3, Y1 |
| Critic 1: Prepare again flips the cover letter back | Y5 | Page › revision 3, Y5 |
| Critic 2: documents dated in UTC | Y6 | Export and routes › revision 3, Y6 |
| Critic polish: X7's refusal is a loop | Y7 | Routes and page › revision 3, Y7 |
| Critic polish: V19's 32 shots show the old hint | Y8 | The 32 retakes, below |
| Critic polish: the combined line; a repeated identical refusal's tag, here and on the Jobs page | none | Carried to P06 and P06.1; untouched |
| Reviewer nits: X1's first-word readings; "x.com."; a tampered newest same-input version | none | As ruled, carried to P05.1, and acceptable (and Y7 now gives it a way forward) |

**Checked against the reviewer's probes.** Copies of r3 to r3d in `/tmp/wc-p05e2-probes/` ran against the head after the merge.
- **r3:** 5 mismatches (28 at `1a0f854`): the two findings below, and three refusals X4(a) ruled ("still" used of the tooling, "since" as a conjunction, "current" as an adjective), unchanged since `1a0f854`. Every other probe and honest control behaves as wanted.
- **r3's realistic resume and cover letter** are refused at one sentence, "Shipped the on-call rotation tooling that three engineering teams now use [C3].". This is the cost Y1 names. With that sentence worded as the draft's own cover letter words it ("…used by three engineering teams [C3]."), the whole resume and letter pass (`/tmp/wc-p05e2-scratch/realistic-r3.ts`). The realistic draft pinned in `validator.test.ts` in revision 2 passes unchanged.
- **r3b:** 0 mismatches (9 at `1a0f854`).
- **r3d:** "last year", "this year", "Recently" and "now run" are refused; all four passed at `1a0f854`. Its two controls are unchanged.
- **r3c:** X1's first-word readings are refused as ruled, unchanged.

**Findings for P05.1** (older kinds that `1a0f854` also passes, so not counted under round 4's rule):
1. "Platform Engineer at Fernwood Labs, 2019–2021, and the platform team's manager [C9]." passes. A possessive before a role word isn't among Y3's forms.
2. X2's "x.com." case, which the handoff already carries to P05.1: "Won the hackathon run by x.com. Shipped … [C3]." still passes.

**Edited existing assertions: the complete list.** `git diff 1a0f854 HEAD -- runner/test` removes five lines. Three are assertions or a test name, all for Y7; the other two are import lists.
1. **Y7.** `runner/test/applications-routes.test.ts:1438` at `1a0f854` (now `:1483–1486`), X7's refusal body.
   - Old: `{ code: "reexport_refused", message: "Version 1's sentences no longer pass the runner's checks, so they weren't exported again. Nothing was written." }`.
   - New: the same code, and the message "Version 1's sentences no longer pass the runner's checks, so they weren't exported again. The documents must be prepared fresh: preparing again runs a new preparation.".
   - Still a `toEqual`, split over lines. Y7 has the refusal say the way forward.
2. **Y7.** `runner/test/applications-routes.test.ts:1421` at `1a0f854` (now `:1466`), the same test's name: "…the re-export is refused plainly, and nothing is written" → "…, and nothing is exported".
   - The refusal now writes its note into `v1.json` (Y7). Every assertion that nothing was exported is unchanged: the application's documents, the `docs/` listing, the versions listing, one model prompt, one run.
   - The test's last step still rewrites `v1.json` from the record it read before the refusal, so the note goes with the edit, and the restored draft re-exports as before.
3. **Y7.** `runner/test/application-page.test.ts:909` at `1a0f854` (now `:997`), X7's page line: "Not re-exported: its saved sentences no longer pass the runner's checks." → "Not re-exported: its sentences no longer pass the checks; preparing again starts fresh."
- The import lists are `runner/test/applications-routes.test.ts:3` and `runner/test/export.test.ts:4`, each widened by `afterAll` and `beforeAll` for Y6's `TZ` pin.
- `278a784` added assertions only: a new page test, and one more check in Y2's hint test, which revision 3 itself added.

**Mutation proofs (Y1–Y7).** `/tmp/wc-p05e2-mut/mutate-r3.mjs` applies each mutation as an exact, once-only replacement. It runs the named test files with Vitest's JSON reporter, then restores the original bytes and checks them byte for byte. `git status --porcelain` was empty afterwards. All 40 mutations fail tests.
- Y1–Y4 ran `validator.test.ts` (239 cases).
- Y5, and Y7-e to Y7-g, ran the page (38).
- Y6 ran export and routes (73).
- Y7-a to Y7-c ran routes and page (87), and Y7-d ran routes (49).

| ID | Mutation | Failed | What broke |
|---|---|---|---|
| Y1-a | "now", "today", "presently", "nowadays", "remain(s)" aren't open ends | 8 | Now, Presently, Nowadays, today, Remains, "now" mid-sentence and beside the claim's range; the expectations |
| Y1-b | "remain(s)" alone dropped | 2 | "Remains"; the expectations |
| Y1-c | Y1's phrases unread | 6 | "to date", "these days", "continues to", "and beyond"; the message naming "as of now"; the expectations |
| Y1-d | "up to date" read as "to date" | 3 | The honest controls; V3's passing test; the expectations |
| Y1-e | Dates counted from today unread | 11 | The 8 relative dates; "two years ago" and its message; "lately" against the claim's "Recently"; the expectations |
| Y1-f | "N … ago" unread | 3 | "a few years ago"; "two years ago"; the expectations |
| Y1-g | "last/this/past year" (month, week, quarter) unread | 6 | Those five probes; the expectations |
| Y1-h | "The last year of" a degree read as last year | 2 | The honest controls; the expectations |
| Y1-i | A claim's own phrase doesn't let a sentence use it | 1 | The claim's own "Recently …" |
| Y1-j | A relative date is never refused | 10 | The 8 relative dates; "two years ago"; "lately" against "Recently" |
| Y2-a | mt, ft, pt, lt, mx, rd removed | 7 | The reviewer's three; each of the six |
| Y2-b | The longer title and address abbreviations removed | 17 | Each of the 17 |
| Y2-c | No hint | 1 | The hint test |
| Y2-d | The hint for a listed word that really ends a sentence | 1 | The hint test ("Quill Co.") |
| Y3-a | "on", "with", "in" don't end an opening title | 3 | The three probes |
| Y3-b | No bracket or dash ending | 6 | The em dash, bracket, unspaced em dash, spaced hyphen and VP probes; the expectations |
| Y3-c | The sentence's end doesn't end a title | 3 | "Engineering manager [C9]."; "…, later platform architect [C9]."; the expectations |
| Y3-d | A colon doesn't | 1 | "Engineering manager: …" |
| Y3-e | No title after "and", "then", "later" | 6 | The five probes; the expectations |
| Y3-f | No title before "role", "position", "title" | 3 | The two probes; the expectations |
| Y3-g | "As" and the like read as part of a title | 1 | "As Senior Platform Engineer …" |
| Y3-h | The phrase before a role word reaches back to such a first word | 1 | "I lead with …" (verbs left alone) |
| Y3-i | …and past "and", "then", "later" | 3 | "then engineering manager"; "later platform architect"; the expectations |
| Y3-j | A linked phrase needs no follower | 3 | V2's verb-like openings; X1's "Lead the …"; Y3's verbs |
| Y4-a | "single-digit" unread | 2 | The probe; the keys |
| Y4-b | "order(s) of magnitude" unread | 4 | Both probes; the keys; "tenfold" for it |
| Y4-c | quintupled, sextupled unread | 4 | Both probes; the keys; the claim's own "Quintupled" |
| Y4-d | quintuple, sextuple unread as whole words | 3 | Both probes; the keys |
| Y4-e | "a couple of" unread | 2 | The probe; the keys |
| Y4-f | "scores of" unread | 2 | The probe; the keys |
| Y5-a | Prepare again sends the last attempt's letter choice (`1a0f854`) | 2 | The critic's steps; the other direction |
| Y5-b | A parked attempt continues with the newest version's choice | 1 | The parked test |
| Y6-a | UTC again | 3 | Routes' evening preparation; export's evening letter and second zone |
| Y7-a | The next Prepare repeats the refused re-export | 3 | Both Y7 route tests; the first Y7 page test |
| Y7-b | The refusal isn't noted | 3 | The same three |
| Y7-c | The detail reports the refusal after a newer version | 2 | Both Y7 route tests |
| Y7-d | The server's message without the way forward | 2 | The X7 and first Y7 route tests |
| Y7-e | The refused note is never shown | 1 | The first Y7 page test |
| Y7-f | The page's line without the way forward | 3 | The X7 page test; both Y7 page tests |
| Y7-g | An older version's refusal changes the newest version's note | 1 | The X5 page test |

Each result is in `/tmp/wc-p05e2-mut/r3/result-<ID>.json`, and the list in `/tmp/wc-p05e2-mut/r3/summary.json`.

**Screenshots (Y8).** 48 files in `docs/screenshots/`, each at a true 390 and at 1280, in light and dark.
- **Y5:** `P05-applications-prepare-again-letter-{before,after}-*` (8), viewport captures at a device scale factor of 2.
  - Before: the critic's steps. Prepare with no letter (version 1), with a letter (version 2), then no letter from the form. The line says "Re-exported “Platform Lead · Fernwood” as version 3, from version 1's sentences.", and "Version 3 · resume" says "Prepared Sep 24, 2026 from version 1's sentences, exported again; no model ran. It replaces version 2."
  - After: Prepare again, nothing changed. The line says "Already prepared: “Platform Lead · Fernwood” matches version 3; nothing new." The request sent `coverLetter: false`, no model turn ran, and there are still three versions.
- **Y7:** `P05-applications-reexport-{refused,fresh}-*` (8), viewport captures at a device scale factor of 2.
  - Refused: version 1's stored draft says "five engineering teams" and the name is now Zoe Quill. Prepare again gives "Not re-exported: its sentences no longer pass the checks; preparing again starts fresh.", and version 1's note gives "…, and its sentences no longer pass the runner's checks. Prepare again runs a fresh preparation." No model turn ran; `v1.json` carries `reexportRefused` with `newest: 1`.
  - Fresh, the way forward: Prepare again gives "Prepared “Platform Lead · Fernwood”: version 2 is ready." after one model turn. Version 2's resume is headed "Zoe Quill" and says "three engineering teams". Neither details note is left; version 1 says only "Version 2 replaces it."
- **Y2's hint:** not on the page. The page shows each problem's rule words (`RULE_WORDS`), not its message, so the hint reaches the model and the stored problem only. There is no page shot of it, as Y8 allowed.
- **V19's 32 retakes:** `P05-applications-{empty,prepared-diff,gap-question,refusal,exports,reexport-name-change,pdf-warning,runner-down}-*`.
  - They are full-page captures in revision 1's states. The four `empty-*` shots are at a device scale factor of 2, because they came from the same run as Y5's; the other 28 are at 1, as revision 1 took them. (Revision 4 corrected this line, which said all 32 were at 1.) The states:
    - the empty workspace;
    - Platform Lead prepared twice, with the degree excluded;
    - Staff Software Engineer's questions;
    - Harbor's refused draft;
    - Quill with a letter, both questions left out, then "already prepared";
    - "Ада Квилл" re-exported as version 3;
    - "Ada Quill (艾达)" re-exported as version 4;
    - the runner stopped while Harbor's turn was held.
  - Each shows the corrected hint: "The runner puts these at the top of every resume and at the end of every cover letter. The model never sees them."
- **The harness.** `/tmp/wc-p05e2-screens/harness-r3.ts` (modes empty, main, down and y7) merges revision 1's `harness2.ts` scenarios with revision 2's harness, and was never committed.
  - It runs the real `createBridgeApp` with every route module on 127.0.0.1:4320, over a fresh workspace per mode (`/tmp/wc-p05e2-screens/ws-r3-*`). The port was checked free before each run, and each harness was stopped afterwards.
  - The test suite's scripted model stood in for eve: no live model, no network, nothing from HOME or the keychain. Sign-in went through real `/ui/login?nonce=` links.
- **The captures.** `/tmp/wc-p05e2-screens/shots-r3.mjs` drove headless Chromium through the extension's `@playwright/test`, with the viewport as a device-metrics override.
  - Before each capture it checked that `clientWidth` and `innerWidth` were both 390 or both 1280, that `prefers-color-scheme` matched the theme, and that nothing scrolled sideways. For Y5 and Y7, it also checked that the live line fit its clamp.
  - The log is `/tmp/wc-p05e2-screens/shots-r3-log.json`.

**`runner/README.md`.** P05's paragraph gains three lines:
- documents are dated in the runner machine's zone (Y6);
- Prepare again keeps the newest version's letter choice (Y5);
- a re-export today's checks refuse is refused once, and the next Prepare runs fresh (Y7).

**The chain,** from the repo root at `42f5006`, after the merge. `git status --porcelain` was empty afterwards.
- `pnpm install --frozen-lockfile`: already up to date.
- `pnpm typecheck`: 6 workspaces, exit 0.
- `pnpm test`, exit 0:
  - contracts: 16 files, 235 tests
  - job-assistant: 6 files, 153 tests
  - catalog: 26 files, 168 tests
  - runner: 55 files, 1289 tests (revision 2: 1193). Revision 3 adds 96: validator 86, export 2, routes 3, page 5. The eval then passed 7 of 7 files and 161 gates, preparation 54.
  - extension: 21 files and 329 tests passed; 1 file and 5 tests skipped
  - `scripts/*.test.mjs`: 2 of 2
- `pnpm -r lint`: exit 0, `--max-warnings 0`.
- `pnpm check:fixtures`: exit 0.
- No rerun was needed at `--workspace-concurrency=1`.

**CI.** Every run includes the extension step, "Build and test the extension (vitest against dist/, then Playwright)".

| Head | Run | Result |
|---|---|---|
| `6e4e47b` | 36087882400 | success |
| `84fd103` | 36088072247 | success |
| `02ddd67` | 36088437046 | success |
| `643ca6e` | 36088631942 | success |
| `a832068` | 36088973292 | success |
| `bcff8b8` | 36089190441 | success |
| `680d3a2` | 36090110468 | success |
| `7c9919c` | 36090779893 | success |
| `278a784` | 36090961334 | success |
| `42f5006` | 36092227263 | success |

The reply gives this report commit's own head SHA and CI run.

**Not done.** Everything in Y1–Y8 is done. The only thing left out is a page shot of Y2's hint, because the page doesn't show it (above). The carried items (P06, P06.1, P05.1) are untouched.

**Boundaries.**
- **Scope.** Apart from what the merge brought from integration (GOALS.md, `logs/`, the packet README, P06's and P06.1's specs), only these changed since `1a0f854`:
  - `runner/validate/{facts,text,validator}.ts`, `runner/export/document.ts`, `runner/store/applications.ts` (the version record's optional `reexportRefused`), `runner/server/routes/applications.ts` and `runner/ui/assets/application.js`;
  - four test files in `runner/test/` (new tests, and the three edits listed), P05's lines in `runner/README.md`, `docs/screenshots/P05-*.png`, and this packet file.
  - These are unchanged: `packages/contracts`, `context.ts`, `run-harness.ts`, `local-ui.ts`, P03's, P03.2's and P04's files, the skills, the templates, `extension/`, `runner/package.json`, the lockfile and the vitest config.
- **eve.** No eve connection was added. Model turns still go through `runTurn`, and the fresh preparation after a refused re-export is the ordinary preparation path. The refusal's note is written by the route through `ApplicationsStore.writeVersion`, outside any turn.
- **Ports and scratch.** Only 127.0.0.1:4320 was used, and it was free after the last harness stopped. Only `/tmp/wc-p05e2-*` was written: probes, scratch, `mut/r3/`, the screens (`harness-r3.ts`, `shots-r3.mjs`, `ws-r3-*`) and the chain logs (`/tmp/wc-p05e2-chain-r3-*.log`). The reviewer's and critic's folders were only read.
- **Refused commands.** No deny rule or permission check refused anything. The harness refused five commands as too complex to verify: a loop running gh and git, a loop running node over a runtime value, a heredoc-then-node chain, a git call inside process substitution, and a loop over `git show`. I split them or used Write.
- **Orchestrator messages.** One arrived, carrying the code word: this revision, Y1–Y8. It was followed. Nothing else claimed to be from the orchestrator.

### 2026-09-25 — Revision 4 (iter-007 Opus escalation)

Round 4 ended REVISE 2 (reviewer) and REVISE 1 (UI critic). The binding decisions Z1–Z4 are in `logs/handoff/P05-round-4-review.md`, from `origin/overnight/integration` at `230fa6a`. The escalation that did revisions 2 and 3 did all of them, starting from `00ff33e`.
- The branch merged `origin/overnight/integration` once, never rebasing: at `7ae724a`, in `dd57e5d` (git's default merge message). Integration's two new commits change no P05 file and no code: the round-4 handoff, P06.1's round-1 handoff, P06's and P06.1's specs, `logs/blocks.md` and `logs/latest.md`. The full chain ran after the merge, and again at `6c1bbb3`.

| Commit | What |
|---|---|
| `7baaa21` | Z1: Prepare again retries a failed or interrupted attempt with its own letter choice |
| `f89d4f7` | Z2–Z4: a bracket after a title, a title after "was", and the corrections to revision 3's rulings |
| `06db0d8` | The README's Prepare again line (Z1), and revision 3's "scale 1" wording |
| `dd57e5d` | Merge `origin/overnight/integration` (`7ae724a`) |
| `c30609c` | Z4(c): one more draft-level test, a claim open only by "currently" |
| `6c1bbb3` | Z3: adverbs after "was", and "was" after another subject only where the title ends (new tests only) |

**Z → commit and tests.** Counts are test cases, `it.each` rows included. "Validator" is `validator.test.ts`, "page" is `application-page.test.ts`.

| Z | Commit | What changed | Proven by |
|---|---|---|---|
| Z1 | `7baaa21` | `renderActions` sends the newest version's letter choice only when the detail's state is idle. A parked attempt continues, and a failed or interrupted one runs again, with that attempt's own choice. At `00ff33e` only a parked attempt kept its own (`application.js:775`), so a failed letter attempt was answered "Already prepared" | Page › Prepare again retries a failed or interrupted attempt as it asked (revision 4, Z1) (2). The critic's steps: Quill without a letter, both questions left out, version 1; then a letter from the form, whose model turn fails ("Couldn't prepare …", and the "Try again" note); then the detail's Prepare again sends `coverLetter: true` and runs a model turn, which asks Quill's questions again, and the note goes. Then the same with the letter's attempt interrupted (a running attempt another runner owns, written as the route test for interruptions writes one). Neither says "Already prepared". The Y5 tests (3), r3-s7 among them, pass unchanged |
| Z2 | `f89d4f7` | The title reader keeps where each round bracket is, by word, and the words each title was read from. A bracket right after a title joins it when one of its comma-separated parts is either up to four title words with a seniority word among them (an article allowed, no other joining word: "Staff", "Senior", "Staff level", "Sr.", "Staff-level", "a Staff role"), or reads alone as exactly one title ("Tech Lead", "engineering manager", "Head of Platform", "CTO"). Only those parts join, and a title read inside the bracket goes with them. Any other bracket stays a separator, and a claim is read the same way. The splitter now reads a period's word up to the closing brackets or quotes after it, so "(Sr.)" ends in the abbreviation "Sr.". Closed like that, an abbreviation ends a sentence only before a capital or a citation marker: "(Sr.) at …" goes on, and "(Inc.) Shipped …" still splits | Validator › revision 4, Z2 (19). Refused as `title`: the reviewer's four; "(Sr.)", as one sentence; "(Staff-level)"; "(a Staff role)"; "(Tech Lead)"; "(engineering manager)"; a seniority part after a company ("(Fernwood Labs, Staff)"); "(Senior)" on C10's sentence-case title (the P05.1 finding) and in place of C12's own bracket; "(Lead)" and "(Principal)", refused before too. The refusal names "platform engineer staff". Passing: "(Fernwood Labs)", "(remote)", "(2019–2021)", "Staff Engineer (Payments)" on C12 and its comma form, "(Harbor)" on C10, and "(a staff of eight)" on a claim that says so. Y3's "Security engineer (Fernwood Labs)" is still refused. A claim's own "(Staff)" passes cited as written, and "(Senior)" is refused against it. The splitter: "(Sr.) at" is one sentence; "(runbooks, alerts, etc.) used by …" passes; "(Inc.) Shipped" and "“Quill Inc.” Shipped" still split, and are refused as uncited. `titlesIn` expectations, including "(reporting to the CTO)" staying a separator |
| Z3 | `f89d4f7`, `6c1bbb3` | "was" is a title context, as "as" and "became" are, past one article: "I was engineering manager", "I was the engineering manager", "Was engineering manager". After "was", only a word that names a role counts (`namesRole`): a role word whole ("manager", "co-founder"), a compound ending in one with no joining word inside ("platform-engineer"), or one "in" something ("engineer-in-residence"); never "developer-friendly", "engineer-led" or "head-to-head". Adverbs right after "was" are no part of the title ("I was also …", "I was briefly the …"). After "I", "My title", "My role" or a sentence start, "was" introduces a title however the sentence goes on; after another subject, only where the role phrase ends ("Ada was engineering manager at …"), so "The biggest win was developer tooling" states none. "Was" joins the first words that are never part of a title. "served as" and "worked as" were already read through "as" | Validator › revision 4, Z3 (17). Refused against C9: "I was engineering manager"; "I was the …"; "I was a platform architect"; "I was platform architect"; "Was engineering manager"; "At Fernwood Labs I was engineering manager"; "Served as …"; "Worked as the …"; "I was also …"; "I was briefly the …"; "I was engineering manager overseeing …"; "My title was …"; "Ada was …". Passing: "I was Platform Engineer", "I was a Platform Engineer", "I was platform engineer" and "Was Platform Engineer" on C9; and on C10 ("Engineering manager at Harbor, 2021–2023."): "I was (the) engineering manager at Harbor", "Served as …", "Worked as the …", "I was also …", "I was briefly the …". No title in "was developer-friendly", "was engineer-led" or "was head-to-head", and a draft saying "which was developer-friendly" passes. "The biggest win was developer tooling …", "…was a partner integration" and "…was a developer preview …" pass, as at `00ff33e`. `titlesIn` expectations |
| Z4(a) | `f89d4f7` | Y2's 23 words are a list of their own, `CAPITALIZED_ABBREVIATIONS`, read as abbreviations only with a capital first letter. In lower case each ends its sentence, and an uncited one of one or two letters gets Y2's hint ("ft."). The trade, recorded: "…on Quill Rd. Shipped … [C3]." is one sentence, as "…for Quill Inc. Shipped …" is | Validator › revision 4, Z4 (5 of 18): "Worked as a sales rep. …", "…the next gen. …", "…6 ft. …" and "…Quill rd. …" refused as uncited; the reviewer's Mt., Ft., Lt. and Mx. passing; the Rd. and Inc. trade pinned. Also the edited Y2 test below (23 rows) |
| Z4(b) | `f89d4f7` | "scores of" is a count only where a count can start: at the start of a sentence or a phrase, and after a verb, a preposition or a conjunction. It is a noun right after a determiner or a possessive ("the", "its", "their" …), a scored word ("credit", "test", "risk", "high" …), a word with "'s", an acronym ("NPS"), or a word a determiner comes right before ("its onboarding scores of", "the combined scores of"), unless that word is a preposition or a conjunction ("this and scores of"). A comma, full stop, semicolon, colon or bracket right before "scores" starts a phrase: number tokens now carry `closes` | Validator › revision 4, Z4 (10 of 18). Passing on C1: "the credit scores of merchants", "test scores of the release checks", "the merchant risk scores of Northwind Labs", "its fraud scores", "its onboarding scores", "the combined scores", "the NPS scores". Still refused as `number`: after "and", after a verb, opening the sentence, after "the team,", after "the team and", after "this and", after "that", after "by". `numbersIn` expectations; a claim's own "Mentored scores of engineers" passes |
| Z4(c) | `f89d4f7`, `c30609c` | `datesIn` notes whether a marker read before revision 3 leaves the text open, wherever it stands: the open words ("present", "current(ly)", "ongoing", "since", "still", "onward(s)"); a range ending in one ("2019 to date", "2021–now", "until today"); X4's "to/until/till this day" and "and counting"; a range left open ("2021–"); a start with no end. When only revision 3's words or phrases leave it open, `DateFacts` carries `presentOnly: true`, and `isOpenEnded`, which is read for claims only, ignores that open end. A sentence's open end is read as before | Validator › revision 4, Z4 (3 of 18). Against "Built the Harbor ledger service, now retired." (and the same with 2019–2021): "Still run …", "Have run … to date", "Currently run …" and "Now run …" refused. Claims open by an older marker with a present word first, each passing its draft: "since 2021", "starting in 2022", "2021–now", "to this day", "(2021–)", "currently". C7's "…, which I remain today [C8][C7]" passes. `datesIn` expectations. Revision 3's Y1 tests pass unchanged |

**The rulings' costs, recorded.** Each is a refusal, never a pass.
- **Z4(c).** "Built the Harbor ledger service, now retired [C9]." citing that claim is refused now. The sentence's "now" says it is still going on, and the claim isn't open. This is the class of Y1's "now use" and "remain consistent"; "…, which has been retired [C9]." passes. The Z4(c) test pins it.
- **Z4(a).** The Rd. and Inc. trade above. In lower case, "moved the rack 6 ft. to the left" now ends at "ft.", and the hint says to write it out.
- **Z4(b).** A claim that uses "the scores of" as a count ("Onboarded the scores of engineers who joined …") states none, so a draft's bare "scores of" isn't among its facts.
- **Z2.** A bracket that names a team with a seniority word in it ("(Lead Generation)") joins the title. A title still compares whole, so a claim's "Platform Engineer (Staff)" matches neither a draft's "Staff Platform Engineer" nor its bare "Platform Engineer".
- **Z3.** After "I was", a role word is read wherever it stands, so "I was the only engineer on call" states "only engineer", as "joined as the only engineer" already did. "I was a developer advocate" states "developer", because "advocate" is not a role word; the same holds after "as".

**Round-4 issues → Z and test.**

| Issue | Z | Test |
|---|---|---|
| Critic 1 (a regression against `1a0f854`): after a failed attempt, Prepare again no longer retries it | Z1 | Page › revision 4, Z1 |
| Critic polish: "scale 1" for the four `empty-*` retakes | Z1's note | Revision 3's screenshots paragraph, corrected in `06db0d8` |
| Reviewer 1 (from Y3): a bracketed seniority word after the claim's title passes | Z2 | Validator › revision 4, Z2 |
| Reviewer 2 (from Y3): "I was engineering manager at …" passes | Z3 | › revision 4, Z3 |
| The reviewer's costs: "sales rep.", "next gen." and "Quill Rd."; "credit scores of"; "now retired" | Z4(a)–(c) | › revision 4, Z4 |
| P05.1 findings fixed here, as ruled: "Staff engineer (Senior) at Harbor"; "(Sr.)" refused as uncited; "I was the engineering manager" | Z2, Z3 | › revision 4, Z2 and Z3 |
| The other P05.1 findings: "…, and the platform team's manager [C9]"; "x.com."; "…through the last month of 2023" | none | Carried to P05.1; untouched |

**Checked against the reviewer's probes.** Copies of r2–r2d, r3–r3d and r4–r4c (11 files, 241 verdicts) in `/tmp/wc-p05e2-probes/` ran at the head and at `00ff33e` (that head's three validator files, in `/tmp/wc-p05e2-base-00ff33e/`).
- **15 verdicts changed, all as ruled.** The reviewer's title probes are now refused: r4's four brackets and "I was …", and r4b's "(Staff)", "(Senior)" on C10 and its three "I was" forms. r4's "credit scores of" passes, and its "sales rep." and "next gen." are refused. r4c's "Still run" and "to date" are refused. "(Sr.)" stays refused, now for its title, "platform engineer sr", rather than as uncited.
- **What r4 still shows:** "Quill Rd." passing (the recorded trade); "known today" and "remain consistent" refused (the costs Y1 keeps); "the last month of the range" refused (P05.1); and "the last quarter of a stated year" refused, because its year isn't in its claim (C11 states none; the same at `1a0f854`).
- **r2, r2b–d, r3, r3b–d:** no verdict changed.
- **The realistic resume and cover letter** (`/tmp/wc-p05e2-scratch/realistic-r3.ts`) pass whole with the "now use" line worded as the letter words it, as in revision 3. In the reviewer's r3 realistic probe, "realistic resume + cover letter" passes, and the only output that differs from `00ff33e` is `datesIn('Now a Platform Engineer')`, which now carries `presentOnly: true`. The realistic draft pinned in `validator.test.ts` passes unchanged.
- **At `00ff33e`'s validator** (swapped in, then restored byte for byte, by `/tmp/wc-p05e2-mut/revert-r4.mjs`), 57 of the 77 validator tests whose names say "revision 4" fail; 23 of the 57 are the renamed Y2 rows. The 20 that pass are controls, refused or passing at both heads:
  - "(Tech Lead)", "(Lead)" and "(Principal)", and the separators test;
  - "Was" opening a sentence, "served as", "worked as the", and "Ada was engineering manager at …". At `00ff33e`, "Was …" and "Ada was …" are refused for a title read back through "was" ("was engineering manager", "ada was engineering manager"); the head reads "engineering manager";
  - the test that "was" after another subject can introduce a thing a role word describes, and the adjective test;
  - Y2's capitalized words;
  - the eight "scores of" counts still refused;
  - the claims open by an older marker.

**Findings for P05.1** (older kinds, or new cases of a class `00ff33e` has with "as"):
1. A possessive before a role phrase after "was": "I was Harbor's platform engineer [C10]." reads no title, like revision 3's finding "…, and the platform team's manager".
2. "am", "is" and "were" are not title contexts: "I am engineering manager at Fernwood Labs [C9]." passes. Z3 names "was" only.
3. After a subject other than "I", a title that runs on is not read: "Ada was engineering manager overseeing …" passes. Resumes and letters speak in the first person or without a subject, which Z3 covers.
4. The costs above for Z2 and Z3.

**Edited existing assertions: the complete list.** `git diff 00ff33e HEAD -- runner/test` removes 19 lines. Two are one assertion and its test's name, for Z4(a). Of the other 17, 15 are the two helpers that moved unchanged and one is a widened import list. The last is the Y5 describe's opening line, which the diff shows removed above the moved helpers and added back, unchanged, below them (`:911`).
1. **Z4(a).** `runner/test/validator.test.ts:890` at `00ff33e` (now `:892`), the lower-case line of Y2's "keeps a sentence whole" test.
   - Old: ``expect(splitSentences(`Shipped the on-call rotation tooling on Quill ${abbreviation}. for three engineering teams [C3].`)).toHaveLength(1);``
   - New: the same sentence, `.toHaveLength(2)`. Z4(a) rules that a lower-case one ends its sentence.
   - Added beside it, at `:890`: the same sentence with the capitalized word, `.toHaveLength(1)`, so a capitalized word before a lower-case one stays covered.
2. **Z4(a).** The same test's name, `:886`: "keeps a sentence whole at “%s.”" → "keeps a sentence whole at a capitalized “%s.”, and ends one at the lower-case word (revision 4, Z4)". Its 23 rows are unchanged.
3. **Z1, moved, not changed.** `runner/test/application-page.test.ts:893–908` at `00ff33e`: the Y5 describe's helpers `letterChoices` and `prepareFromForm`, now at module scope (`:893–909`), so the Z1 describe shares them. Their bodies are the same code, one indent less. `letterChoices`'s comment gains "(revision 3, Y5)", and `prepareFromForm` gains one. The Y5 describe's three tests are unchanged.
- The import list at `runner/test/application-page.test.ts:8` (now `:9`) gains `INTERRUPTED_MESSAGE`, and line 1 imports `randomUUID`.
- `c30609c` and `6c1bbb3` only added to tests that revision 4 itself added. `c30609c` gave Z4(c)'s test one more claim, C14, and a check for it; the test's claim list gained C14, which is its one changed line. `6c1bbb3` added five rows and two statements to Z3's tests, and one new Z3 test.

**Mutation proofs (Z1–Z4).** `/tmp/wc-p05e2-mut/mutate-r4.mjs` applies each mutation as an exact, once-only replacement. It runs the named test files with Vitest's JSON reporter, then restores the original bytes and checks them byte for byte. `git status --porcelain` was empty afterwards. All 39 mutations fail tests, run at `6c1bbb3`.
- Z1 ran the page's Z1 and Y5 tests (5).
- Z2–Z4 ran `validator.test.ts` (293 cases).

| ID | Mutation | Failed | What broke |
|---|---|---|---|
| Z1-a | `00ff33e`'s condition: only a parked attempt keeps its own letter choice | 2 | Both Z1 tests: the failed attempt (the critic's steps) and the interrupted one |
| Z1-b | A failed attempt retried as asked, an interrupted one not | 1 | Z1's interrupted attempt |
| Z1-c | An interrupted attempt retried as asked, a failed one not | 1 | Z1's failed attempt |
| Z1-d | An idle state takes the last attempt's choice too (Y5's r3-s7 back) | 2 | Y5's critic's steps; its other direction |
| Z2-a | No bracket joins the title before it (`00ff33e`) | 14 | The reviewer's four; "(Sr.)"; "(Staff-level)"; "(a Staff role)"; "(engineering manager)"; the seniority part after a company; "(Senior)" on C10 and in place of C12's bracket; the named title; the claim's own "(Staff)" with "(Senior)" against it; the expectations |
| Z2-b | A seniority word no longer makes a bracket part of the title | 13 | The same, except "(engineering manager)" |
| Z2-c | A role phrase no longer makes a bracket part of the title | 1 | "(engineering manager)" |
| Z2-d | Every bracket joins the title before it: a company, a place, a team too | 5 | Z2's separators and expectations; Y3's claim's own title in each place, and its expectations; C13's "Staff Engineer (2021–)" in Z4(c)'s test |
| Z2-e | A title read inside a joined bracket is kept as well | 1 | Z2's expectations |
| Z2-f | A bracket part with a joining word counts ("a staff of eight") | 1 | Z2's separators |
| Z2-g | The splitter reads the word with its closing bracket again (`00ff33e`: "(Sr.)" ends a sentence) | 2 | "(Sr.)" as one sentence; Z2's splitter test |
| Z2-h | A bracketed abbreviation never ends a sentence, even before a capital | 1 | Z2's splitter test ("(Inc.) Shipped" splits) |
| Z3-a | "was" is no title context (`00ff33e`) | 9 | "I was", "I was the", "I was a", "I was platform architect", "Was …", "was" mid-sentence, the title that runs on, "My title was"; the expectations |
| Z3-b | A capitalized "Was" opening a sentence is part of a title again | 1 | The claim's own title after "was" ("Was Platform Engineer") |
| Z3-c | Any role word after "was" is a title ("was developer-friendly") | 1 | The adjective test |
| Z3-d | "engineer-in-residence" names no role | 1 | The expectations |
| Z3-e | A compound with a joining word inside names a role ("head-to-head") | 1 | The adjective test |
| Z3-f | An adverb after "was" is read into the title ("also engineering manager") | 1 | The claim's own title after "I was also" |
| Z3-g | The look-back passes no adverb, so "I was also the …" reads no title | 2 | "I was also"; "I was briefly the" |
| Z3-h | "was" introduces a title after any subject, whether the title ends or runs on | 1 | "The biggest win was developer tooling" and the other two |
| Z3-i | "I was" no longer introduces a title that runs on | 1 | "I was engineering manager overseeing …" |
| Z3-j | After another subject, a title that ends is no longer read | 2 | "Ada was engineering manager at …"; the expectations |
| Z4a-a | Y2's words count in any case (`00ff33e`: "a sales rep. Shipped …" rides along) | 27 | The 23 edited Y2 rows; "sales rep.", "next gen.", "6 ft.", "Quill rd." |
| Z4a-b | Y2's words never count (`1a0f854`: "Mt. Hood" ends a sentence) | 25 | The 23 Y2 rows; Y2's test of the reviewer's three and Mx.; Z4's capitalized test |
| Z4b-a | "scores of" is a count after any word (`00ff33e`) | 2 | The nouns test; the expectations |
| Z4b-b | "scores of" is never a count | 11 | Y4's "scores of" and its expectations; Z4's eight counts; Z4's expectations |
| Z4b-c | A comma before "scores" no longer starts a count | 1 | The count after a comma, with a determiner before ("the team, scores of") |
| Z4b-d | A determiner two words back no longer makes "scores" a noun | 1 | The nouns test ("its fraud scores of") |
| Z4b-e | A conjunction after a determiner no longer starts a count | 1 | The count after "this and" |
| Z4b-f | The scored words no longer make "scores" a noun | 2 | The nouns test; the expectations |
| Z4b-g | A possessive or an acronym no longer makes "scores" a noun | 1 | The expectations |
| Z4c-a | Revision 3's words open a claim again (`00ff33e`) | 1 | "now retired" |
| Z4c-b | The open words ("since", "still", "currently" …) no longer mark a claim open | 2 | The claims open by an older marker; the expectations |
| Z4c-c | A range ending in "now" no longer marks a claim open | 2 | The same two |
| Z4c-d | X4's "to this day" counted as revision 3's | 2 | The same two |
| Z4c-e | A range left open ("2021–") no longer marks a claim open | 2 | The same two |
| Z4c-f | A start with no end no longer marks one | 2 | X4's open ends; Z4's expectations |
| Z4c-g | Revision 3's phrases ("to date") mark a claim open | 1 | The expectations |
| Z4c-h | X4's "and counting" counted as revision 3's | 1 | The expectations |

Each result is in `/tmp/wc-p05e2-mut/r4/<ID>.json`, and the list in `/tmp/wc-p05e2-mut/r4/summary.json`.

**Screenshots.** None were retaken: no Z item changes what the page shows. Z1 changes which letter choice the detail's Prepare again sends, and the page tests follow the critic's steps.

**`runner/README.md`.** P05's line on Prepare again now says that, with nothing pending, it keeps the newest version's letter choice, and that a pending attempt keeps its own, whether it continues a parked attempt or retries a failed or interrupted one.

**The chain,** from the repo root, twice. `git status --porcelain` was empty after each run.
- **At `dd57e5d`, after the merge:** every step exited 0. The runner had 55 files and 1339 tests; the other counts were the same as below.
- **At `6c1bbb3`,** this report's parent:
  - `pnpm install --frozen-lockfile`: already up to date.
  - `pnpm typecheck`: 6 workspaces, exit 0.
  - `pnpm test`, exit 0:
    - contracts: 16 files, 235 tests
    - job-assistant: 6 files, 153 tests
    - catalog: 26 files, 168 tests
    - runner: 55 files, 1345 tests (revision 3: 1289). Revision 4 adds 56: validator 54 and page 2. The eval then passed 7 of 7 files and 161 gates, preparation 54.
    - extension: 21 files and 329 tests passed; 1 file and 5 tests skipped
    - `scripts/*.test.mjs`: 2 of 2
  - `pnpm -r lint`: exit 0, `--max-warnings 0`.
  - `pnpm check:fixtures`: exit 0.
- No rerun was needed at `--workspace-concurrency=1`.

**CI.** Every run includes the extension step, "Build and test the extension (vitest against dist/, then Playwright)".

| Head | Run | Result |
|---|---|---|
| `7baaa21` | 36096264553 | success |
| `f89d4f7` | 36097928261 | success |
| `06db0d8` | 36098032415 | success |
| `dd57e5d` | 36098055110 | success |
| `c30609c` | 36098616464 | success |
| `6c1bbb3` | 36099401520 | success |

The reply gives this report commit's own head SHA and CI run.

**Not done.** Everything in Z1–Z4 is done. No screenshots were retaken (above). The carried items (P05.1, P06, P06.1) are untouched.

**Boundaries.**
- **Scope.** Apart from what the merge brought from integration (the two handoffs, `logs/blocks.md`, `logs/latest.md`, P06's and P06.1's specs), only these changed since `00ff33e`:
  - `runner/validate/facts.ts`, `runner/validate/text.ts` and `runner/ui/assets/application.js`;
  - `runner/test/validator.test.ts` and `runner/test/application-page.test.ts` (new tests, and the edits listed), P05's line in `runner/README.md`, and this packet file.
  - These are unchanged: `packages/contracts`, `context.ts`, `run-harness.ts`, `local-ui.ts`, the routes, the store, the export, P03's, P03.2's and P04's files, the skills, the templates, `extension/`, `runner/package.json`, the lockfile and the vitest config.
- **eve.** Nothing about turns changed. Z1's retry is the ordinary preparation path. The page test's interrupted attempt is written through `ApplicationsStore`, as the route test for interruptions writes one.
- **Ports and scratch.** No server was started in this revision, so no port was bound; 127.0.0.1:4320 is free. Only `/tmp/wc-p05e2-*` was written: the probes (the r4 copies, `z3-honest.ts`, `run-all.mjs`, `compare.mjs` and their outputs), `base-00ff33e/` (that head's validator, for comparison), `mut/r4/` with `mutate-r4.mjs` and `revert-r4.mjs`, scratch, and the chain logs (`/tmp/wc-p05e2-chain-r4-*.log` at `dd57e5d`, `/tmp/wc-p05e2-chain-r4b-*.log` at `6c1bbb3`). The reviewer's and critic's folders were only read.
- **Refused commands.** No deny rule or permission check refused anything. The harness refused five commands as too complex to verify: a heredoc edit followed by a typecheck, a loop running node over a runtime value, a heredoc append followed by Vitest, a loop running `sips` over the screenshots (to read the `empty-*` scale), and a wait loop with arithmetic. I split them or used Write and Edit. It also refused writing a report-like file under `/tmp`, so this report was written here only. ESLint's `no-control-regex` rejected control characters as the bracket marks, so the marks are private-use characters.
- **Orchestrator messages.** Two arrived, both carrying the code word: Z1 at the critic's verdict, then Z2–Z4 at the reviewer's. Both were followed. Nothing else claimed to be from the orchestrator. Harness notices about other agents' background tasks (P06.1's implementer and its UI critic) also appeared; they asked nothing of this packet, and I acted on none.
