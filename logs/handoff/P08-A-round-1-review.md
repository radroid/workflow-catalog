# P08-A (#13): round-1 review of head 0af2945 (iter 005)

A REVISE goes back to the **same Sonnet implementer** once, via SendMessage; its worktree is kept. This file is the combined list. The reviewer's section is added when its verdict lands.

## UI critic (Opus): REVISE — 9 issues

Scratch:
- `/tmp/wc-ui5-p08a-scratch/`: harness, seed and stage scripts, and `log.json`;
- the workspaces `ws/{empty,invalid,main}`;
- `shots/`: `a1` (empty), `b1` (invalid only), `c1` (records), `d*` (settings), `e*` (corrupt and daily limit), `f1` (API 500).

The clone is `/tmp/wc-ui5-p08a`, at 0af2945.

**Overall:** the pages follow the house style well, and the core mechanics work:
- newest first, and the exact cap note;
- a keyboard-operable JSON view;
- `aria-disabled` while busy;
- inert hostile error text;
- the correct decision-2 corrupt-file behaviour.

1. **The `failure` pill fails contrast** (axe serious, both themes). White on #e54b4f is 3.85:1 in light, and white on #ff5b5b is 3.04:1 in dark. The style is P02's `.badge.fail` in `runner.css`. Fix: dark text on the red fill, like `.badge.warn` (about 4.7:1 light, 5.9:1 dark).
2. **Error text fails contrast** (light, 3.75:1). `.status-message.error` in `runs.css` and `settings.css` uses `var(--destructive)` text. Fix: foreground text with a destructive marker (a left border, "Error:"), or a red that measures at least 4.5:1.
3. **Resume loses focus.** The button sits inside `#budget-pause`, which is hidden on success, so focus falls to `<body>`. Fix: move focus to a stable element first, for example `#budget-title` with `tabindex="-1"` or the first input.
4. **Out-of-range input shows no page error.** Tried: 0, 51, 21, 2.5 and empty.
   - Only the native tooltip appears. There is no live-region message, no `aria-invalid`, no inline text, and the bounds are shown nowhere.
   - A server 400 would show raw ("Invalid request body at dailyRunLimit: Too big…").
   - Fix: bounds as hint text linked with `aria-describedby`; on an invalid submit, one plain sentence in the live region ("Daily run limit must be a whole number from 1 to 50."), `aria-invalid`, and focus kept; never the raw 400 text.
5. **Horizontal scroll at 390 from long unhyphenated model ids.** Measured `scrollWidth` 515–794. Fix: `overflow-wrap: anywhere` and `min-width: 0` on `.run-meta` or its `code`.
6. **The empty state repeats itself.**
   - "No runs yet." (the live region) is followed by "No runs yet…", and there is an empty `<ul>`.
   - With only an invalid file, the same sentence shows twice plus an amber note.
   Fix: one empty-state message, not echoed into the live region on load, and the empty list hidden.
7. **Full UUIDs and raw internal names are visible.**
   - Each card shows the full `runs/<date>/<uuid>.json`.
   - `Model n/a` (the NO_MODEL placeholder) appears on paused, interrupted and thrown records.
   - `MODEL_CALL_FAILED: …` appears in a reason.
8. **Amber is used for things that aren't decisions.**
   - The catch-up mark is `badge warn`.
   - The skipped-file note uses `notice decision` but doesn't name the file (the API returns only a count).
   - Every past `paused` pill is amber.
   Settings' current-pause notice uses amber correctly.
9. **Corrupt budget.**
   - The reason's path isn't in `<code>`.
   - The inputs show the defaults without saying so.
   - After Save the page says "Saved." while still showing "Paused: budget settings unreadable…", although the file is now valid.
   - Resume silently writes the defaults and says only "Resumed.".

**Polish:**
- **P1.** "Exceeding either pauses runs…" is untrue: the item cap never pauses, and at the daily limit there is no "new runs wait until tomorrow" line.
- **P2.** The Settings intro promises sections that don't exist; pairing is on Status.
- **P3.** A record with no `finishedAt` reads "failure — interrupted", which will also describe a run still in progress. It also shows "0 ms · 0 · 0 · n/a".
- **P4.** Put the reason next to the outcome pill.
- **P5.** Token counts have no thousands separators.
- **P6.** The "View JSON" controls share one name, and they use the browser's focus ring rather than `--ring`.
- **P7.** The trailing ellipsis in "No runs yet…" reads like loading.
- **P8.** The Resume button touches "Runs used today", and Resume and Save are both primary.
- **P9.** The first "Saved." pushes the card 40px under the pointer. "Saved." and "Resumed." will be ambiguous once more sections join, and a repeated "Saved." may not be re-announced.
- **P10.** "Failed to fetch" should read "Can't reach the runner. Is it still running?"
- **P11.** Input borders are 1.27:1 against the card; WCAG 1.4.11 asks 3:1.

**Verified:**
- newest first; runs used today; `aria-disabled`; focus on Save and the JSON view; inert HTML in errors;
- the decision-2 behaviour;
- all 16 committed screenshots, correctly named, at true width and full page, covering the prompt's list. They show issues 1 and 6, so they need retaking.

## Reviewer (Opus): REVISE — 5 issues

Scratch: `/tmp/p08a-review/`:
- the probe results `probe-notes.txt`, `probe-edges.txt`, `probe-more.txt` and `probe-stall.txt`;
- the probe tests in `in-tree-probes/`;
- `backup/` and the merge-check logs.

**What holds:**
- **Chain:** green at the head and on the merge onto 2fde932. Runner 217 tests plus the eval with 20 gates; the counts match the report. CI passes (run 35774073883).
- **Mutation proofs:** all four reproduce.
- **Time zones:** tests pass in 5 zones.
- **eve facts:** all seven are verified against the installed files.
- **Budget:** defaults and bounds, derived `runsUsedToday`, and decision 2 end to end.
- **API:** 401 and 403; 400 and 413; non-uuid gives 404 with no filesystem touch; `/status` validates.
- **Security:** no HTML sinks, and no new dependency.
- **Scope:** all 33 files are inside Owns.
- **Overlap with P03:** only `runner/test/route-modules.test.ts`. Take P03's readdir-based version.

**Issues:**
1. **A timed-out turn is recorded as a success and never cancelled (high).** `run-harness.ts:123-124` trusts `response.result()`.
   - An abort while eve's client opens or reopens its stream ends quietly as `completed`. This is now eve-runtime.md §8 item 15.
   - Probes with the real eve `Client` and a stubbed `fetch`: a mid-turn stall with a 17 s timeout, a timeout during the routine reconnect, and a timeout before the stream opens all give `ok` with no cancel. Through `withRun` the record says `success`, and the idempotency lookup then says done.
   - Deleting the cancel-on-timeout line keeps all tests green. The test at `run-harness.test.ts:157` ("…and cancels") asserts no cancel.
   - `MessageResponse.cancel()` sends nothing before the turn has started.
2. **Decision 3 is violated.** An empty error text makes `finishRun`'s schema parse throw inside the `finally` (`run-harness.ts:219, 224-226`; `runs.ts:152`). `withRun` rejects with a ZodError, and the untrue "interrupted" placeholder stays on disk. `runTurn:130` can produce an empty `detail` itself.
3. **Timeouts and failures lose usage already spent** (`run-harness.ts:128, 130`). 7 input and 3 output tokens were reported as 0/0.
4. **The idempotency lookup stops at the newest 200 records**, not the 14-day window (`runs.ts:261-262`). A success from 5 days ago behind 200 newer records reads as "not done", which means a duplicate draft.
5. **Budget writes aren't serialised** (`budget.ts:125-162`). A Save racing a provider-limit pause lost the pause in 15 of 40 trials. `withRun`'s limit check isn't held across `startRun` (`run-harness.ts:167-179`).

**Nits:**
- **Surviving mutations to pin with tests:**
  - decision 1's precedence: the regex must not apply when an unrelated `semanticErrorId` is present;
  - a pause held only in memory: assert the bytes of `runs/budget.json`;
  - UTC dates under `TZ=UTC`, which is what CI uses;
  - a run crossing local midnight;
  - a `paused` record treated as "done".
- `budget.test.ts:113` names an end-to-end test that doesn't exist.
- The parked-turn cancel sends nothing on real eve, while the fake counts one.
- eve's details carry `statusCode` and `upstreamStatusCode`. The chatgpt, openai and anthropic providers have no rate-limit semantic id.
- `/status` says `paused: false` at the daily limit.
- `getRun` doesn't check the file's `runId`, and an error listing one date directory turns into a 500.
- Report accuracy: "classifies … timeout", "never rethrows", the cancels, and two test titles.

## Orchestrator decisions for the revision (G1–G10)

- **G1. Timeouts (issues 1 and 3; eve-runtime.md §8 item 15).** `runTurn` reads the stream event by event with `for await`, summing usage and taking the model id as they arrive.
  - It is ok only with a terminal boundary event and `!signal.aborted`.
  - An abort or timeout gives `timeout`, and keeps the partial usage.
  - Timeouts and parked turns are cancelled through `created.session.cancel()`.
  - Regression tests use the real eve `Client` with a stubbed `fetch`, for the three abort points: before the stream opens, during an idle reconnect, and during the routine reconnect. The reviewer's `/tmp/p08a-review/` probes are the template.
  - Fakes count only real cancel requests.
- **G2. `withRun` never rejects (issue 2).**
  - Empty error text becomes "The run failed without an error message."
  - If the full record fails validation, `withRun` writes a minimal fixed-text failure record. If that also fails, it resolves with the in-memory record and logs it.
  - Test an empty thrown error and an empty turn detail.
- **G3. Idempotency (issue 4).** Scan the 14-day window without the 200-record cap, newest first, stopping at the first hit. Test with more than 200 newer records, and test that a `paused` record never counts as done.
- **G4. Budget writes are serialised now, not deferred to P08-B (issue 5).**
  - One in-process promise chain covers every budget write, and `withRun` holds it across the limit check and `startRun`.
  - Test that a Save racing a pause keeps both, and that two concurrent runs at one below the limit let exactly one run.
- **G5. Decision 1, extended.** When no `semanticErrorId` is present, `details.statusCode === 429` or `details.upstreamStatusCode === 429` is also a provider limit, as is the regex. Test the precedence: an unrelated id plus rate-limit text is not a limit.
- **G6. `/status` at the daily limit.**
  - `paused` keeps meaning the manual pause that needs Resume.
  - Consumers (P06, P07-C) derive "daily limit reached" from `runsUsedToday >= dailyRunLimit`; both are in the contract.
  - The README says so, and Settings shows "Daily limit reached. New runs wait until tomorrow."
- **G7. Approved edits to `runner/ui/assets/runner.css`, outside Owns**, and only these two:
  - `.badge.fail` contrast: dark text on the red fill, at least 4.5:1 in both themes;
  - form-control borders (inputs, selects, textareas) at least 3:1 against the card.
  List both in the report.
- **G8. Paths and ids (UI issue 7).**
  - Show `runs/<date>/<8 chars>….json`, with the full relative path in `title`, and a "Copy path" button that copies the absolute path. Add `absolutePath` to the local runs API only, never to `/status`.
  - Records that never called the model show no model, token or duration line.
  - Error codes such as `MODEL_CALL_FAILED:` appear only in the JSON view; the visible reason is plain language.
- **G9. Skipped files (UI issue 8).** The list API returns the skipped files' relative paths, up to 10. The note is neutral and names them in `<code>`.
- **G10. Records with no `finishedAt` (polish P3)** show "Did not finish (or still running)" in a neutral pill, without the zero line.
- **Screenshots.** Retake all 16, and add Settings Budget in the corrupt and at-daily-limit states, at 390 and 1280, light and dark. That makes 24.
