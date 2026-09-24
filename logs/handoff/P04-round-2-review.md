# P04 (#14): round-2 review of head f3cdec8 (iter 006)

Revision 1 was done by the Sonnet implementer; its CI run is 35954530791, green with the extension e2e. Round 2 is a second REVISE, so **revision 2 goes to a fresh Opus escalation implementer**, with decisions T1–T21 below. Any later REVISE goes back to that same escalation implementer.

## Reviewer (Opus): REVISE — 6 issues

Scratch:
- `/tmp/wc-rev-p04-r2-probes/`
- `/tmp/wc-rev-p04-r2-mutations/`
- `/tmp/wc-rev-p04-r2-work/`

Round 1's folders are still in place.

**Fixed since round 1:**
- **1: the production transport.** It serves over TLS with a pinned lookup, with `autoSelectFamily` on and off. M7 fails a test.
- **2: IPv6.** All 13 literal forms are refused with no resolver call, and a literal connects to itself.
- **3: `readable-text`.** It is linear: every hostile shape at 2 MiB runs in 1–92 ms, with no script leak.
- **5: the event response.** Event, paste and URL answer in 21–51 ms, with a 3 s turn in flight.
- **6: stray files.** `.DS_Store` is ignored.
- **7: the three paths.** They match for the fixture, and the fetch is injectable.
- **8: M3a and M8.** Both now fail tests.
- **9: the eval workspace.**
  - The route-level hostile test exists.
  - job-extraction passes solo, 15/15, and together.
  - Discovery skips `eval-workspace.ts`.
  - An ambient `RUNNER_WORKSPACE` changes nothing.
  - A stale coordination variable fails closed.
- **L10, L11 and L14.** `run-harness.test.ts` has exactly one added block (+19/−0).

**What holds:**
- The chain at f3cdec8 is green: runner 731 tests plus 100/100 eval gates.
- The merge onto e201799 is green.
- CI 35954530791: Playwright 37/37, extension dist 334/334.
- Scope is clean.

**Issues:**
1. **A failed turn overwrites the previous fields** (L5).
   - `persistExtractedJob` writes during the turn (`extract-job-logic.ts:33`); the route never writes.
   - A Re-extract whose turn called `extract_job` and then failed kept the failed turn's fields, and they showed while the turn was running.
   - The page's "The fields already saved were kept." (`jobs.js:489`) is then false.
   - An `interrupted` revision still accepts writes.
   - The route tests' scripted turns call `recordStructured` directly, so none of them cover this.
2. **A `waiting` state left by an earlier process never clears** (L5).
   - Only `running` is read as interrupted (`captures.ts:191`), and retry returns the stale `waiting` (`:473`).
   - The page keeps Re-extract disabled and polls every 400 ms forever (`jobs.js:572`, `:597`, `:696`).
3. **A budget pause doesn't stop queued turns** (L5). The budget is checked only at queue time (`captures.ts:175`). After the first turn paused the budget, the second still ran and ended `done`.
4. **A slow page is reported as too large** (L4).
   - The real transport's mid-body deadline surfaces as `ECONNRESET` "aborted", so `readBounded` falls through to `too_large` (`safe-fetch.ts:378`). A slow-drip or reset body becomes a 413.
   - The test uses a synthetic `TimeoutError`, and the test titled "resolves request_failed" asserts `too_large` (`safe-fetch.test.ts:467`/`480`).
5. **"One rule on every path" is only `trim()`** (L7).
   - The URL path also folds CRLF, collapses spaces and tabs, and trims lines (`readable-text.ts:80`). The extension does the same; paste doesn't.
   - The Northwind text with a double space, trailing spaces and CRLF is 632 characters by paste or event, and 613 by URL, with different hashes.
   - A re-paste then makes a whitespace-only revision and a new extraction.
6. **Damaged data isn't named plainly** (L6).
   - A job whose latest revision is damaged silently disappears (`jobs.ts:163`).
   - A damaged `extraction-<rev>.json` makes detail and retry return 500 (`jobs.ts:122`).
   - Recapturing a job whose only revision is damaged creates a second job for the same URL.

**Nits:**
- M6b is covered only by the IPv6-literal test. Handing the transport the hostname for DNS names stays green.
- `safe-fetch.test.ts:530` (under 400 ms, against a 250 ms deadline) failed once in seven runs, at 551 ms.
- `openOrCreateEvalWorkspace` trusts the coordination variable and doesn't reset `RUNNER_WORKSPACE`. With both set ambiently, the fixtures and the tools split, and 10 gates failed.
- Whitespace-only text gives a 500 on the paste and event paths.
- Two concurrent Re-extracts queue two turns for one revision.
- A retry that reports `running` isn't watched by the page.
- These ranges are still allowed: `::ffff:0:0:0/96`, `64:ff9b:1::/48`, `2002::/16`, `198.18.0.0/15` and `192.0.0.0/24`.
- `stripUrlForStorage` re-serializes the whole URL in the WHATWG form. It is consistent, and it helps dedupe.

**`RUNNER_WORKSPACE` in production** (not P04's; now P02.2):
- The environment overrides `.env.local` (`settings.ts:98-108`) for `runner`, `pair`, `ui`, `doctor` and `setup -- --forget`. Only setup's own workspace choice reads the file alone (`lib/setup.ts:202-207`).
- With an ambient value that isn't a workspace, as GitHub Actions sets, the runner fails closed with a misleading message.
- With another valid workspace, it silently serves and writes that one, and `--forget` targets it.

## UI critic (Opus): REVISE — 9 issues

Scratch: `/tmp/wc-ui10-p04-scratch/r2/`. Key evidence:
- `stage-c-light-390.txt`: the background-extraction flows;
- `crops/line-clamp-long-light-390.png`: a message cut off at 390;
- `crops/committed-diff-light-390-line-midpage.png`: the screenshot defect;
- `sheets/`: contact sheets of the committed screenshots.

The clone is `/tmp/wc-ui10-p04`, at f3cdec8.

**Fixed since round 1:**
- **1:** the pinned line, with `scroll-padding-top` tracking its height.
- **3:** jobs are named from their own text.
- **5:** no focused node is rebuilt.
- **7:** the duplicate copy.
- **8:** a 175-character address fits at 390.
- **9:** screen readers hear the diff as "Removed: …" and "Added: …"; the marker glyph and spacing are right.
- **Polish:** almost all of it.

**What holds:**
- Focus never passed through `<body>`.
- All text is 4.5:1 or better, and there's no amber.
- Nothing scrolls sideways at 390.
- Paste and fetch show a real busy state.
- The event path answers in 60–180 ms, with no announcement.

**Partly fixed from round 1:**
- **2. Busy.** Try extracting again and Re-extract return in under 300 ms. Then:
  - "Extracting…" never shows;
  - the old line stays;
  - once, the line named another job's result for 2.5 s.
- **4a. Refresh.** A job whose extraction the page didn't start never refreshes. After an event capture with an 8 s turn, the job still showed "running" 11 s later, after the server had finished.
- **4b. The no-model wording.** "Set one up in Settings" points nowhere; Settings has only Budget. The runner says "Run `npm run setup` in `runner/`" elsewhere (`routes/model.ts:33`, `status.js:44`). This is the orchestrator's L12 wording, and it was wrong.
- **6. The size check.** The page counts raw bytes (`jobs.js:777`), but the contract counts `new TextEncoder().encode(JSON.stringify(text)).length` (`primitives.ts:202-207`). A 195,000-byte posting with 5,000 newlines passes the page. The server then refuses it, and the page shows "That didn't look right…" on the address field.

**New issues:**
1. **Field errors don't follow J4 and J6.3.**
   - Enter in a refused field announces only "Not saved.", and the reason isn't re-read.
   - "Can't reach the runner" and server errors are pinned to the address field, which is marked invalid (`jobs.js:790`, `:829`).
   - An address error survives a later successful paste.
2. **Field borders are 1.27:1** (WCAG 1.4.11).
   - They use the hairline `--border`, against `runner.css` G7 (lines 110–114): use `--muted-foreground`.
   - The red invalid border never shows: a more specific rule overrides it.
3. **A refresh closes the open diffs and the full posting text.** On Try extracting again, and when a background extraction finishes, the focused "Full posting text" toggle jumps 278 px at 390 (J6.6).
4. **axe serious `scrollable-region-focusable`** on the full posting-text box, in all four combinations. The box has no name, and shows Chrome's ring.
5. **J5: long messages are cut at 390.** Save messages with a not-run reason run 131–145 characters, and the two-line clamp hides the next step. A sliver of a third line shows.
6. **9 of the 29 committed screenshots don't show what they should.**
   - The four diff and four refused-private full-page shots draw the pinned line mid-page, over content.
   - The not-run viewport shot doesn't show the not-run detail.

**Polish:**
- Scroll an opened job's heading to just under the line. The heading shows Chrome's ring.
- The paused-budget message doesn't say the budget paused it, or point to Resume in Settings.
- "…or paste the text directly" appears on a pasted job.
- The paste form's optional address lacks the URL form's scheme check and its `javascript:` and `file:` wording.
- In the diff, wrapped lines and unchanged lines don't line up.
- The paste-refused shot uses the name "anchor", which isn't one of the fixture policy's companies.
- Extension captures appear only after a reload.

## Revision 2: the orchestrator's decisions (T1–T21)

For a fresh Opus escalation implementer, working on `packet/P04` from f3cdec8. Everything stays inside P04's Owns, plus the L9 grant (the workspace lines of `onboarding-extraction.eval.ts`).

You may read, and copy from, these folders, without editing them:
- `/tmp/wc-rev-p04-r1-probes/`
- `/tmp/wc-rev-p04-r2-probes/`
- `/tmp/wc-rev-p04-r2-mutations/`
- `/tmp/wc-rev-p04-r2-work/`
- `/tmp/wc-ui10-p04-scratch/`, including `r2/`

Every L decision from round 1 still stands, except where a T decision below changes it.

**Server and store (reviewer):**
- **T1. Fields are written only after an ok turn** (issue 1).
  - `extract_job` validates and returns the fields. It never writes.
  - The route writes them from that call's `action.result`, after an ok turn, and only for the exact job and revision being extracted.
  - A running Re-extract shows the previous fields until it finishes.
  - Tests drive scripted turns whose events carry a real `extract_job` action result, never a direct `recordStructured` call:
    - a turn that calls the tool, then fails, keeps the previous fields;
    - during a running Re-extract, the previous fields are shown.
- **T2. States from an earlier process read as interrupted** (issue 2).
  - `waiting` and `running` record which runner process owns them. Either state from another process reads as `interrupted`, and a retry queues it again.
  - The page stops polling once a state settles.
- **T3. The budget is checked just before each turn starts, not only at queue time** (issue 3).
  - A queued revision whose turn can't start records "not run", with the budget reason.
  - Test: the first turn pauses the budget, and the second never starts.
- **T4. Body errors are classified by cause** (issue 4).
  - The deadline gives `timeout`, a reset or abort gives `request_failed`, and only the byte cap gives `too_large`.
  - Tests use the real transport against a local TLS server: a slow-drip body gives `timeout`, and a reset mid-body gives `request_failed`.
  - Fix the mistitled test.
  - Timing tests assert the reason. Any time bound gets at least 4× headroom over its deadline, which covers the flaky test at `:530`.
- **T5. One text rule on every path** (issue 5, and the whitespace nit).
  - One exported function normalizes posting text by the URL path's rules: fold CRLF, collapse spaces and tabs, trim each line, then trim the whole.
  - The event, paste and URL paths all use it, and it is idempotent.
  - Tests:
    - the Northwind text, with a double space, trailing spaces and CRLF, gives the same text and hash on all three paths;
    - a whitespace-only re-paste creates no revision.
  - Whitespace-only text is refused plainly:
    - on paste, a 400;
    - on the event path, a `rejected` outcome through the events module's typed refusal (`events.ts:121`), never `handler_failed`.
- **T6. Damaged data is named, never a 500 and never a silent gap** (issue 6).
  - A job whose latest revision can't be read stays in the list. It is named by its URL, when any readable file of the job records it, and marked unreadable, with the bad file's path in `<code>`.
  - An unreadable extraction state reads as `interrupted`, and a retry rewrites it.
  - A recapture of the same URL lands in the same job when any readable file of that job records the URL.
  - Add a test for each.
- **T7. Security nits.**
  - A DNS-name fetch must connect to the checked address. A test fails when the transport is handed the hostname (M6b), for a DNS name as well as for an IPv6 literal.
  - Also block, with a test each:
    - `::ffff:0:0:0/96`, checked by its embedded IPv4;
    - `64:ff9b:1::/48` and `2002::/16`, blocked entirely;
    - `198.18.0.0/15` and `192.0.0.0/24`.
- **T8. The eval module keeps both variables in step.**
  - When the coordination variable is already set, the module sets `RUNNER_WORKSPACE` to that same path.
  - Test with both variables set ambiently to different values.
- **T9. A revision already waiting or running isn't queued again.** Two concurrent Re-extracts queue one turn.
- **T10. URL serialization.** The WHATWG serialization is accepted, because it is consistent across paths and helps dedupe. Say so in the report and in the README's Jobs lines.

**The Jobs page (UI critic):**
- **T11. Feedback for background extraction** (UI 2 and 4a).
  - An accepted Try extracting again or Re-extract replaces the line at once with a short "Extracting “<job>”…", and shows the job as running. Its result is announced once.
  - The page watches every job it shows that is waiting or running, whoever started it:
    - every 2 s while one is running, and every 5 s otherwise;
    - only while the page is visible;
    - updating in place.
  - The page announces only the results of extractions it started.
  - New extension captures join the list on the 5 s refresh, without an announcement.
- **T12. Wording** (UI 4b; the orchestrator's L12 wording was wrong).
  - No model: "No model is configured. Run `npm run setup` in `runner/`, then try again." This is the runner's existing wording.
  - A paused budget: say the budget is paused, and point to Resume in Settings.
  - A pasted job never offers "…or paste the text directly".
- **T13. The size check matches the contract** (UI R1-6).
  - The page measures `new TextEncoder().encode(JSON.stringify(text)).length`.
  - Every too-large refusal on the paste path shows the 200 KB sentence on the text field, never on the address field.
- **T14. Field errors** (UI new 1; J4 and J6.3).
  - When focus stays in the refused field, after Enter, the line carries the short reason: "Not saved: the address is empty."
  - "Can't reach the runner" and server errors go in the line only: never on a field, and never with `aria-invalid`.
  - A field error clears when its field changes, or when a later action succeeds.
- **T15. Field borders** (UI new 2).
  - Use `--muted-foreground`, following `runner.css` G7.
  - The invalid border must win.
  - Put the contrast measurements in the report.
- **T16. A refresh keeps state** (UI new 3; J6.6). Open diffs and the full posting text stay open, and a focused control never moves. Update only what changed.
- **T17. The posting-text box** (UI new 4). It is either not a scroll container, or it is focusable (`tabindex="0"`), a labelled region, with the theme's focus ring. axe must be clean.
- **T18. Message length** (UI new 5; J5).
  - Every line message is one sentence of about 90 characters or fewer, with the consequence first.
  - Reasons and next steps live in the job's detail.
  - The two-line clamp applies to an inner element in `jobs.css`, so no sliver of a third line shows. Don't edit P03's CSS.
- **T19. Polish.**
  - Scroll an opened job's heading to just under the line, with the theme's focus ring.
  - Give the paste form's optional address the URL form's scheme check and wording.
  - Line up wrapped and unchanged diff lines with the changed text.
- **T20. The screenshots** (UI new 6).
  - Full-page shots show the pinned line at the top, where it belongs. For example, size the viewport to the page instead of stitching.
  - The not-run viewport shot shows the not-run detail.
  - Fixture names follow the policy, so no "anchor".
  - Check every committed `P04-*.png` against its name.

**Proofs:**
- **T21. Mutation proofs.**
  - Re-run L14's.
  - Each of these must fail a test:
    - the tool writes fields during the turn (T1);
    - a `waiting` state from an earlier process stays waiting (T2);
    - the budget is checked only at queue time (T3);
    - a reset mid-body is classified `too_large` (T4);
    - paste skips the shared normalizer (T5);
    - a damaged latest revision hides the job (T6);
    - the transport is handed the hostname for a DNS name (T7).
