# P05 (#16): round-1 review of head 3130763 (iter 007)

The Opus implementer opened #16. The code head is 7171303; the last commit is the report. CI run 35989224619 on 3130763 is green. An earlier run, 35987564075 on 20c9c8f, failed on a race that 7171303 fixes.

## UI critic (Opus): REVISE, 9 issues

Scratch: `/tmp/wc-ui11-p05-scratch/`. It holds `harness.ts`, `lib.mjs`, the `stage-*.mjs` scripts, `out/`, `log.json`, the `ws-*` workspaces and `downloads/`, plus `shots/` (132) and `sheets/`. The clone is `/tmp/wc-ui11-p05`.

**What holds:**
- The house style, and the walkthrough's copy ("Preparation is locked … The workflow will not guess.", "Already prepared … nothing new").
- axe: 0 violations of any impact in 127 audits over 33 states. Minimum contrast is 6.47:1 light and 6.76:1 dark. No sideways scroll at 390.
- The diff reads in words, without colour.
- Focus is never dropped or rebuilt, including through refreshes on five kinds of focused control.
- `aria-disabled` while busy, and a double press sends one request.
- The CI race is fixed in the browser: with the second write held for 4.5 s, the page reads "running", then announces the real outcome once.
- The exports read cleanly in Markdown, DOCX and PDF, with no markers, field names or posting text.
- All 20 committed screenshots are right.

**Issues:**
1. **A corrected name or contact line never reaches the documents.** The page says "Saved: your documents will carry this name.", but Prepare again answers "Already prepared … nothing new", because the key covers only model inputs. Evidence: `downloads/after-contact/resume-v2.md:3`.
2. **The list row and the amber block stay after every question is answered.** The row keeps "Needs your answer · Waiting for your answer to 2 questions.", which is `processing.error` frozen at park time. Build the line from the answers ("1 question left", "Ready to continue", "Waiting for the evidence you're adding"), and drop amber and the heading once no question is open.
3. **Evidence, sources and approval are sent to the Profile page.** They live on Onboarding; Profile itself says to "use the Onboarding page". Link Onboarding, and keep Profile only for the unreadable-file case.
4. **An outcome is never announced after a reload or a revisit mid-preparation.** Only preparations started by the current page load are watched (`started`). When the list loads, watch every running application and announce its outcome once.
5. **While the runner is down, the page says "Preparing now …" indefinitely.** Failed background refreshes are silent. Show and announce "Can't reach the runner. Is it still running?" once, and clear it on the next good refresh. The Jobs page has the same silence.
6. **Every download has the same anonymous name** (`resume-v1.pdf` for every job). Use a descriptive name in the `download` attribute and in `Content-Disposition`, such as "Ada Quill - Resume - Fernwood Platform Lead.pdf". Workspace file names stay as they are.
7. **Version 1 keeps saying "It cites 1 claim you have since excluded … Prepare again" after version 2 exists.** Show that note only on the latest version, and say "Version 2 replaces it." on older ones.
8. **A name outside Latin-1 prints as "??? ?????" in the PDF, with no warning.** Example: "Ада Квилл". The Markdown is right. Evidence: `shots/pdf-cyrillic-resume-v1.png`.
9. **`career-profile.md` is plain text, not `<code>`,** in "Not prepared: your career-profile.md has an edit…" and in the readiness line. Render `readiness.message` through `renderPieces`, and drop the duplicate "See the Profile page".

**Polish:**
1. Applications list in random-UUID order.
2. The job picker defaults to the newest job even when it isn't extracted, and the `not_extracted` refusal names no next step.
3. "Answer all 2 questions" should be "Answer both questions".
4. The paused-budget readiness line reuses refusal wording, and "Settings" and "the Runs page" aren't links.
5. The daily run limit isn't shown under "Before preparing".
6. With two tabs, a stale amber block stays below a focused answer button.
7. After "add your name … first", focus stays on Prepare instead of moving to the name field.
8. The DOCX Author property is "Job assistant runner".
9. At 390, `diff-v1.md` breaks mid-name.
10. Two claims join with ", " rather than "and".
11. Export links repeat their names across versions.

**Noted, not counted:** versions 1 and 2 both say "career profile version 1", because excluding a claim keeps P03's approval version.

## Reviewer (Opus): REVISE, 9 issues

Scratch folders:
- `/tmp/wc-rev-p05-r1-probes/`: the probes;
- `/tmp/wc-rev-p05-r1-logs/`: every log;
- `/tmp/wc-rev-p05-r1-mutations/`: the backups;
- `/tmp/wc-rev-p05-r1-merge`: the merge clone.

**What holds:**
- **Chain at head:** green, and three identical `pnpm test` runs: runner 973, evals 7/7 with 159 gates (preparation 54). CI 35989224619: Playwright 37/37.
- **Merges:** onto integration, clean and green. With #17 on top, clean: runner 986, and nothing to attribute to either PR.
- **Excluded claims** never reach the prompt: no text, id or label.
- **The boundary:** `DATA-` plus 16 random bytes, new per call. Forged boundaries, "SYSTEM:" lines and every line-break character stay inside.
- **The turn:**
  - It runs through `runTurn` inside `withRun`. Only the last `prepare_application` output for the task and attempt counts, and any other tool call saves nothing.
  - After the turn, the profile is re-read, the key recomputed and the draft validated again.
  - `POST /prepare` returns in about 53 ms; the turn runs in the per-workspace queue.
- **Idempotency:** two concurrent Prepares gave `already_running` and `started`, one prompt and one application. A changed profile gives v2, "replaces 1".
- **Restarts, the 7171303 race, and F8** all hold.
- **Route security:**
  - 401 without the cookie, 403 cross-site, 415 for text/plain;
  - strict zod, uuid task ids, and 10 traversal attempts all 404;
  - downloads use `attachment`, a sandbox CSP, `nosniff` and `no-store`, and serve only files the record lists.
- **Export:** markers are stripped only at export. DOCX escaping holds against injected XML, and "Zoë" survives all three formats.
- **Dependencies:** exact pins, no install scripts or native builds in 38 package versions, no reachable network paths, an additive lockfile, and a clean frozen install.
- **Skills, eval and directives:**
  - Skills and templates carry no data, and each names its fixture.
  - The eval follows the workspace rules. "Step execution already in flight" also appears on base and is benign.
  - Thin wrappers per app root.
- **Scope** is clean, and keeping the test posting out of `fixtures/` is justified.

**Issues:**
1. **Unstated numbers pass.**
   - `facts.ts:94-96` strips commas before the year check, so "1,950" and "2,000" pass as years.
   - `:111` skips digits joined to letters: "200ms", "5GB", "1e6".
   - Arabic-Indic digits pass.
2. **Inflated titles pass** against "Platform Engineer at Fernwood Labs, 2019–2021.":
   - "Sr. Platform Engineer": the period ends the phrase (`facts.ts:241`);
   - "Staff Platform-Engineer": the hyphen hides the role (`:210`);
   - "Director at…" or "CTO at…" opening a sentence (`:253`);
   - lower-case "director of platform" (`:257-268`).
3. **Open-ended dates pass against a closed range.** `validator.ts:216-222` checks only for a subset, and `datesIn` ignores "present", "since" and "current". "since 2019" and "2019–present" both pass against 2019–2021.
4. **An uncited sentence rides along with a cited one.** `text.ts:83`/`:91` need a space and an ASCII capital. These all pass:
   - "…[C3].Won …";
   - an ellipsis character;
   - "…[C3]. Élu…";
   - "…[C3]. then won…", which one test deliberately keeps.
5. **Nothing tests the server's re-validation.** M11 (`!check.ok && false` at `routes/applications.ts:511-515`) passes all 973 tests.
6. **The excluded-metric and hostile acceptance tests prove nothing for DOCX.** `docxAllText` has no positive assertion anywhere, and M12 (it returns "") passes all 973 tests.
7. **A damaged application record forks the job.** `findByJob` skips unreadable records, so Prepare creates a second application and runs a second model turn.
8. **A corrected name never reaches existing documents,** while `application.js:934` says it will (the critic's issue 1).
9. **mvp-spec §5 doesn't list** `applications/<taskId>/preparation.json`, `…/versions/v<n>.json` or `applications/details.json`, and neither does ARCHITECTURE.md. The ruling is the orchestrator's.

**Nits:**
- **a. Excluded labels are identifiable.** The refusal's `rule` tells the model `excluded_claim` rather than `unknown_citation` (`prepare-logic.ts:145`). The 4-word wording check answers the same, so the model can probe an excluded claim's wording.
- **b. The PDF silently transliterates or drops characters** Helvetica can't draw: "Lukasz", "??" for CJK, "?" for emoji.
- **c. A stop between writing the files and recording them leaves a phantom version.**
- **d. `oneLine` keeps U+0085.**
- **e. A parked preparation is recorded as `processing: failed`,** and the run log says `failure`. It needs a contracts follow-up before P06.
- **f. `authorization.required` without a `webhookUrl` reads as ok,** in P08-A's classifier.
- **g. README wording:** say "pending `ctx.ask` requests".
- **h. Until #17 merges, `extract_claims` still writes the profile** if a preparation turn calls it.
- **i. One page test flaked once,** under mutation load.
- **j. A marker inside a word is accepted.** This is harmless.
- **k. `hasSucceededWithIdempotencyKey` is not used here.**

**Mutations:**
- The implementer's M1–M7 all fail tests.
- Of the reviewer's own:
  - M8 (number words not counted) fails tests;
  - M9 (no thousands separator) is caught by one helper test only;
  - M10: with both readers returning "", the acceptance tests still pass;
  - M11 and M12 survive the whole suite.

## Decisions for revision 1 (V1–V20)

Revision 1 goes to the same Opus implementer. Every validator change needs a draft-level test, and makes the validator stricter, never looser.

**The validator:**
- **V1. Numbers (reviewer 1).**
  - Check for a year on the raw token, before commas are removed.
  - Treat a digit-first token with a unit as a quantity. Letter-first names such as EC2, K8s, P99 and Q3 stay names.
  - Normalise `\p{Nd}` digits to ASCII, or refuse them.
- **V2. Titles (reviewer 2).** Each probe must fail:
  - keep "Sr."/"Jr." inside the phrase;
  - check each hyphen part as a role word;
  - count a sentence-initial role word followed by "at", "of", "for" or a comma, except verb-like words ("lead", "head");
  - treat lower-case "<role> of X" as a title.
- **V3. Dates (reviewer 3).**
  - A sentence citing a claim that has an end year must state that end year.
  - An open end ("present", "since", "current") is refused unless a cited claim is itself open.
- **V4. Sentences (reviewer 4).** An ellipsis ends a sentence, and `\p{Lu}` counts as a capital. Split on a full stop followed directly by a capital, and before a lower-case word unless `isAbbreviation` applies.
  - The one test that fixes the current split may change, because the rule gets stricter. Report it.

**Tests that must prove their claim:**
- **V5. The server re-validates (reviewer 5).** A route test whose turn reports "accepted" for a draft the validator refuses. Assert: no document, no version, `processing` failed, the stage unchanged, and the refusal kept.
- **V6. Positive controls (reviewer 6).** In the excluded-metric and hostile tests, before the absence loop, assert that every DOCX and PDF contains a known included sentence and "Ada Quill".

**State:**
- **V7. A damaged record (reviewer 7).** While any application record for the job is unreadable, Prepare answers 409 and names the damaged file. Test it.
- **V8. Details changes (reviewer 8, critic 1).**
  - The documents' key gains a `details@<digest>` part.
  - Prepare after a name or contact change re-exports the latest validated draft with the new details, as a new version that names the old one. No model turn runs.
  - The same details give "Already prepared".
  - The saved message says what's true, for example "Saved. Prepare again to put it on your documents."
  - Test all of it.
- **V9. The spec (reviewer 9).** Granted: `docs/spec/mvp-spec.md` §5's workspace-layout lines, and the matching lines of `ARCHITECTURE.md`'s index. Add the three paths in the README's wording.
- **V10. Excluded labels (nit a).** The model gets `unknown_citation`, with the same wording, for an excluded label. That includes the 4-word wording check. The person's view may still say more. Test it.

**The page:**
- **V11. After answers (critic 2).** Build the row line from the answers: "1 question left", "Ready to continue", or "Waiting for the evidence you're adding". Drop amber and the "Needs your answer" heading once no question is open.
- **V12. Links (critic 3).** Link Onboarding for evidence, sources and approval. Keep Profile only for the unreadable-file case.
- **V13. Watching (critic 4 and 5).**
  - On list load, watch every running application and announce its outcome once.
  - While a watched preparation can't be refreshed, show and announce "Can't reach the runner. Is it still running?" once, and clear it on the next good refresh.
- **V14. Download names (critic 6).** Use a descriptive name in the `download` attribute and in `Content-Disposition`, for example "Ada Quill - Resume - Fernwood Platform Lead.pdf".
  - Sanitise it for file systems, and add `filename*` for non-ASCII.
  - Workspace file names stay as they are.
- **V15. Version notes (critic 7).** "It cites … Prepare again" shows only on the latest version. Older versions say "Version N replaces it."
- **V16. PDF characters (critic 8, nit b).**
  - Preferred: embed a Unicode-capable font covering at least Latin Extended, Greek and Cyrillic, from a maintained package under the export-dependency rules. Pin it exactly, and report its size and licence.
  - Either way, nothing is dropped silently: for anything the PDF still can't draw, show a plain warning at the name field and beside the PDF link, naming the formats that keep it.
- **V17. `<code>` (critic 9).** Render `readiness.message` through `renderPieces`, and drop the duplicate "See the Profile page".

**Small fixes, and finishing:**
- **V18. Small fixes:**
  - nit c: the start-up sweep adopts a complete version whose record wasn't written;
  - nit d: `oneLine` also collapses U+0085;
  - nit g: the README wording;
  - critic polish:
    - list applications by recent activity;
    - the picker defaults to an extracted job, and the `not_extracted` refusal names the next step;
    - "Answer both questions";
    - the paused-budget wording, with Settings and Runs as links;
    - show the daily run limit under "Before preparing";
    - after "add your name … first", focus moves to the name field;
    - the DOCX Author is the person's name;
    - two claims join with "and";
    - export links name their version.
  - Polish 6 and 9 are optional.
- **V19. Screenshots.** Retake every state the changes touch. Add the runner-down notice, a re-export after a name change, and the PDF warning, each at a true 390 and at 1280, in light and dark.
- **V20. Mutation proofs** for the new guards: M9, M11, M12, each new validator rule, V7, V8 and V10.

**Carried:**
- **To P06:**
  - a waiting value for a parked preparation, in `application.ts`'s `processing`, so the board shows "Needs your answer" rather than "failed" (nit e);
  - the nav position of Applications;
  - the Jobs page's silent runner-down;
  - two versions that share a profile version look identical ("career profile version 1") after an exclusion;
  - the rulebook's P06 row: P06 extends `routes/applications.ts`, which P05 created.
- **To P08-B:**
  - `authorization.required` without a `webhookUrl` must count as waiting on the person (nit f, eve item 15);
  - a parked preparation's run-log "failure" must not count as a failure for schedules.
