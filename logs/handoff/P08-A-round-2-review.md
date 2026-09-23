# P08-A (#13): round-2 review of head 371cd63 (iter 005)

Revision 1 was the Sonnet implementer's one revision round. A REVISE in round 2 therefore goes to a fresh **Opus escalation implementer**, with this file as its combined list. The reviewer's section is added when its verdict lands.

## UI critic (Opus): REVISE — 3 issues

Scratch:
- `/tmp/wc-ui6-p08a-scratch/`: scripts, `log.json`, and the workspaces `ws/{empty,invalid,main,extra}`;
- `shots/`.

The clone is `/tmp/wc-ui6-p08a`, at 371cd63. Round 1's fake eve was rewritten to stream events and end with a boundary event, to match G1.

**What holds:**
- Round-1 issues 1–6 and 8, and P1, P3, P5, P6, P7, P8, P10, P11, G6, G7 and G10.
  - axe found nothing serious or critical in any state, both themes, 390 and 1280.
  - All text measures at least 4.5:1.
  - Busy buttons use `aria-disabled`, with one request per action.
  - Focus is never lost, and each message is announced once and re-announced when repeated.
  - Hostile HTML stays inert.
- The G7 `runner.css` edits break nothing on Runs, Settings, Status or sign-in.
- All 24 committed shots are accurate.

1. **The skipped-file note shows full UUID paths** (Runs, any state with unreadable files).
   - For example `runs/2026-09-22/38b2e543-eb78-4c6a-946d-bad36b046ee3.json`, while the cards use the short form.
   - With 12 unreadable files at 390, the note is a 337 px wall, broken mid-UUID.
   - Fix: the same `shortRunPath()` in `<code>`, with the full path in `title`, one file per line, keeping "and N more.".
   - Evidence: `shots/b1-runs-invalid-only-light-390.png`, `shots/h1b-runs-extra-first-screen-light-390.png`.
2. **Corrupt-budget recovery says untrue things after a Save.**
   - After Save (8 and 4) over a corrupt file, the notice still reads "Paused: budget settings unreadable `runs/budget.json`", although the file is now valid.
   - Resume then announces "…The default limits (10 runs a day, 5 jobs per run) were saved.", while the file keeps 8 and 4.
   - Cause: `settings-budget.js:144` keys the message on `corruptOrigin`, not on whether the file is unreadable now.
   - Fix: build the Resume message from the state the server returns, and mention defaults only when the file was unreadable at that moment. After a repairing Save, reword the notice, e.g. "The budget file was unreadable. Your limits are saved now; press Resume to restart runs."
   - Evidence: `log.json` entries `E:save-on-corrupt` and `E:resume-after-save`; `shots/e2-settings-corrupt-after-save-light-1280.png`.
3. **Copy path gives no visible result below the first screen.**
   - The right path is copied, focus stays put, and "Path copied." is announced once. But the only feedback is the live region at the top of the page: 871 px above the viewport at 1280 and 1630 px at 390 for the 7th card.
   - "Error: Couldn't copy the path." is just as invisible.
   - Fix: a visible "Copied" / "Couldn't copy" next to the pressed button (hidden from screen readers, or a temporary label change), with the live region still making the one announcement.
   - Evidence: `shots/g1-runs-copy-path-deep-light-1280.png`, `shots/g2-runs-copy-path-refused-light-390.png`.

**Polish:**
- **P2 not met:** the Settings lede still promises Provider, workspace and schedules sections.
- **P4 not met:** the reason still sits 30–51 px below the pill.
- **P9 partial:** at 390, a two-line error moves Save 27 px, and G6's limit note moves Save 56 px (35 px at 1280) under the pointer.
- **Copy path names:** all "Copy path" buttons share one accessible name; add an `aria-label` naming the kind and time.
- **Focus ring:** after Resume, the Budget heading uses the browser's default ring instead of `--ring`.
- **JSON view:** it shows `path` and `absolutePath`, which aren't in the file on disk.

## Reviewer (Opus): REVISE — 2 issues

Scratch: `/tmp/p08a-r2-review/`:
- probe results in `probe-*.txt`, including `probe-g1.txt`, `probe-prebody.txt`, `probe-store.txt`, `probe-tz.txt` and `probe-cancel-hang.txt`;
- `mutations/summary.txt` and `backup/`;
- the clones `probe-clone/` and `merge-clone/`.

**What holds:**
- **Chain:** green at 371cd63 and on the merge onto cbc6e4c (runner 245/245, eval 20 gates).
- **P03 overlap:** P03 then P08-A conflicts only in `route-modules.test.ts`. With P03's version, the runner passes 464/464.
- **Time zones and CI:** 98/98 under both Kiritimati and Pago Pago, and CI is green.
- **Round-1 probes:** every abort point now gives `timeout`, keeps partial usage and sends a real cancel. Through `withRun` the record is `failure` and idempotency says not done.
- **Races:** the Save-versus-pause race lost nothing in 40 trials, and 5 concurrent runs at limit 2 let exactly 2 run.
- **Mutations:** 27 runs; the implementer's 9 reproduce.
- **Also verified:** G3, G4, G5, G6, G8, G9 and G10; G7's exact two edits (`.badge.fail` 4.72:1 light, 5.95:1 dark; input borders 7.77:1 and 8.02:1).
- **Scope:** clean, with no new dependencies and no HTML sinks.

**Issues:**
1. **Every normal eve turn is classified `parked`, so every real run records a failure (high; a G1 regression).**
   - `run-harness.ts:166-169` treats any `session.waiting` boundary as parked. At eve@0.63.0, every conversation turn ends `turn.completed → session.waiting`; only task-mode sessions end with `session.completed`.
   - Sources: the P02 spike (`eve-spike.md:33, :44`); the eve docs (`concepts/sessions-runs-and-streaming.md:98`, `guides/client/streaming.mdx:62, :133`); P02's `eve-gateway.ts:47-48`, which already treats a waiting turn as good. `eve-runtime.md` §8 item 15 now spells this out.
   - Probe (real `Client`, the spike's exact sequence): the result is `parked`, 1 cancel sent. Through `withRun` it records a `failure` and idempotency never says done.
   - The fakes encode the wrong model: `run-harness.test.ts:27-29, 92` and `:200-206`.
2. **`withRun` still rejects before the body** (decision 3). The refusal check and `startRun` sit outside the try/finally (`run-harness.ts:220-262`), and neither `countCountableRuns` (`runs.ts:280-281`) nor `getBudgetState` (`budget.ts:120`) catches a list error.
   - With today's `runs/<date>/` unreadable:
     - `withRun` rejects with EACCES;
     - `GET /status` returns 500 (`extension-api.ts:342` has no catch);
     - `GET /api/runs/budget` returns 500.
   - An unwritable `runs/` rejects on mkdir, and an empty `idempotencyKey` rejects with a ZodError.
   - The runner has no `unhandledRejection` handler.

**Nits:**
1. `withTz` is only ever used with "UTC", so a UTC mutation passes under CI's zone. A runtime TZ switch works inside vitest's worker (`probe-tz.txt`).
2. The quiet-end abort tests don't assert the partial tokens or the model, so M05 survives.
3. The G2 fallbacks are untested, and G2b and G2c survive. `throw undefined` records the text "undefined", and a whitespace-only detail is recorded as it is.
4. `session.cancel()` is awaited without a bound. It is still pending after 5 s (`probe-cancel-hang.txt`).
5. The G4 race test asserts only the pause.
6. `runner/README.md:318` and `:330` duplicate a paragraph.
7. Report accuracy:
   - the G1 text;
   - "mutation proofs" 1–3 are tests, not mutations;
   - "keeps both" overstates the race test;
   - the cap-test description;
   - G4 part 2's failure text.
8. A timed-out turn that never saw `step.started` hides its duration line.
9. For information: a cancel on an already-waiting session is a no-op on the server.

## Orchestrator decisions for the escalation (I1–I4)

- **I1. Turn classification (issue 1), following `eve-runtime.md` §8 item 15.**
  - **ok:** a `session.waiting` or `session.completed` boundary, with no failure event, no `turn.cancelled` and no abort.
  - **Waiting on the person:** only a non-empty `input.requested` list. Cancel it through the session.
  - **Not ok:** `turn.cancelled`, a failure event, or `session.failed`.
  - **Tests:**
    - a real-`Client` test with the spike's exact normal sequence gives ok with 0 cancels;
    - through `withRun` that gives `success`, and the idempotency lookup says done;
    - the fakes' ok paths end `turn.completed → session.waiting`, keeping one `session.completed` case;
    - the park test includes `input.requested`;
    - a `turn.cancelled` case is not ok.
- **I2. Nothing before the body can reject (issue 2).**
  - `getBudgetState` never throws. An unreadable run folder for today becomes a synthetic pause, with the fixed reason `run log unreadable (runs/<date>/)` shown in Settings with the path in `<code>`. `/status` stays 200, and runs are refused with `paused` records wherever a record can be written.
  - `withRun` catches any error before the body, logs it, and resolves with an in-memory `failure` record.
  - An empty `idempotencyKey` gets a failure record with a fixed message, not a ZodError.
  - Tests: chmod 000 on today's folder, an unwritable `runs/`, and an empty key.
- **I3. Nits 1–8:**
  - add a `withTz("Pacific/Kiritimati")` case;
  - assert partial tokens and the model on the quiet-end abort paths;
  - test the G2 fallbacks, with `throw undefined` and whitespace-only details getting the fixed message;
  - bound `session.cancel()` with `AbortSignal.timeout(5000)`;
  - the race test asserts both writes;
  - remove the README duplicate;
  - correct the report;
  - a timed-out turn shows its duration and tokens, hiding only an unknown model.
- **I4. The UI critic's issues 1–3 and polish:**
  - The skipped-file note uses `shortRunPath()` in `<code>`, with the full path in `title`, one file per line, and "and N more.".
  - Corrupt-budget recovery messages are built from the state the server returns.
  - "Copy path" gets visible feedback next to the pressed button, while the live region still makes the one announcement.
  - Polish:
    - P2: the Settings lede lists only sections that exist.
    - P4: the reason goes next to the pill.
    - P9: no layout shift under the pointer; reserve the message space.
    - Unique `aria-label`s for Copy path.
    - `--ring` on the focused heading.
    - The JSON view shows the file as it is on disk, with `path` and `absolutePath` shown separately.
  - Retake every affected screenshot, and add Runs with skipped files.
