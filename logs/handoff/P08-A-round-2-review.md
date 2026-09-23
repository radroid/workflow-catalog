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
