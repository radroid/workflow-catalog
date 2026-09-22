# P07-B (#12): round-2 review, interrupted by the pause (2026-09-22 ~13:05)

The round-2 review was dispatched at 12:52 on head c207783. The B5 correction (6da1a83) landed at about 13:02. Both reviewers stopped at the pause, before any verdict.

**To resume:** start a fresh Opus reviewer and a fresh UI critic on head 6da1a83, with the instructions below. Give them the partial findings so they don't redo verified work, but let them re-verify anything they doubt.

## Instructions that were given

**Reviewer (Class A, Opus).**
- Scope:
  - Review c207783 and the correction commit 6da1a83.
  - Check the packet acceptance and the round-1 issues B1–B6 item by item.
  - Check E1–E4 and the `[hidden]{display:none !important}` fix.
  - Check the new per-key outbox: ordering, the cap, dedupe, and a flush racing a pair.
  - Check the paused-queue semantics: a 401 pause lifts after re-pairing and never spins.
  - Check that nothing new reaches `storage.local` or the manifest.
- **Never bind 127.0.0.1:4310.**
  - For e2e evidence, use CI's conclusion on the final head. The extension step runs build → `EXTENSION_DIST_REQUIRED=1` vitest → the full Playwright suite on GitHub's runner.
  - For B1 (the realbridge vitest on an ephemeral port), run the suite while `lsof -nP -iTCP:4310 -sTCP:LISTEN` shows someone else holding 4310, or verify by reading the harness.
- Use scratch clones under /tmp, with no HOME override and no real keychain or model.
- End with exactly one line: `P07-B (#12) VERDICT: APPROVE | REVISE — <n> issues | BLOCK — <n> issues`.

**UI critic (Class A, Opus).**
- Verify every round-1 issue and E1–E4 against the real bridge on 4310. The critic is the only agent allowed to bind 4310 during its check.
- Use `docs/spec/visuals/theme.css` and the walkthrough `docs/spec/visuals/index.html` as the reference.
- Focus on:
  - the 401/403/timeout paths;
  - focus and announcements, checked with axe and the keyboard;
  - layouts at 390;
  - whether the committed screenshots show what they claim;
  - anything the `[hidden]` override newly exposes.
- Stop all processes before reporting.
- End with exactly one verdict line.

## UI critic partial findings (head c207783; 6da1a83 not looked at)

**Verified against the real bridge on 4310** (options page light and dark; popup light):
- **E1:** Save never downloads a file. "Save as a file" downloads exactly one file, and it is offered only on failure.
- **E2:** an unpaired Save is queued, paused and shown in Settings; pairing flushes it.
- **E3:** the label says `npm run setup` before pairing and `npm run pair` after. Commands render as `<code>`.
- **E4:** the note is present.
- **B3:**

  | Case | What the person sees | What happens to the capture |
  |---|---|---|
  | 401 | The right message; the token is cleared | Paused, delivered after re-pairing |
  | 403 | The right message, mirrored in Settings | Flag set, delivered after re-pairing |
  | Bridge down, or a real 500 | — | Delivered by the real alarm after ~28 s |
  | 409 | Shown verbatim | Not queued |

- **B4:** against a listener that never answers:
  - Pairing gives up after 5.06 s with "The runner isn't responding.", and focus returns to the field.
  - Pairing and File bridge render at once, with "Checking the runner…".
  - Popup Save gives up after 5.4 s and arms a retry.
- **B7:** a persistent live region; focus is correct after pairing, failure, Un-pair and Pair again.
- **B8:** only refused codes are marked invalid. 429 says "Try again in about 10 minutes".
- **B9:** eyebrow weight 400.
- **B10:** Check again, the re-check on focus, and the outbox line all work. Focus is a problem; see issue 2.
- **B11:** Open settings works.
- **Polish:**
  - "Pair again" really collapses the form, and the `[hidden]` fix affects only four elements, all correct.
  - A second Enter on "Saved ✓" is ignored.
  - The workspace id is shortened with a title.
- **axe:** 0 violations and 0 incomplete in 40 options runs and 9 light popup states. Nothing overflows at 390.

**Provisional issues:**
1. **Empty message areas render as a visible 16px amber-edged bar.** This shows in Settings (unpaired, checking, runner down, revoked) and in the popup before Save, and the committed screenshots show it too. The empty style should collapse padding, border and background. Don't use `display:none`, because later announcements depend on the region staying in the page.
2. **"Check again" drops focus to `<body>`,** because it rebuilds the Status section, including the focused button. Every re-check on window focus re-inserts the Status alert, so it is announced again each time.
3. **"Saved ✓" is shown after a real 409,** when nothing was sent or queued, and the button is inert.
4. **The secondary buttons look like text.** "Pair again", "Check again", "Save as a file" and "Open settings" have a transparent border. The walkthrough's ghost button keeps its 1px border (`index.html:32`).
5. **The committed `P07B-options-runner-not-responding-*` screenshots show the wrong state.** They show the "Can't reach the runner… npm run runner" message instead of the B4 timeout message.

**Polish:**
- "Paired." and "Sent to the runner." use the amber flash. The walkthrough uses a neutral `.flash.ok` for success.
- `<code>` falls back to the default monospace instead of Geist Mono.
- When unpaired, a disabled Un-pair is the first control.
- After a 401, the label reverts to `npm run setup`, and the next focus re-check replaces "expired or revoked" with "Pair this browser above…".
- "All saved jobs sent." shows on a fresh install, and it sits tight under the card.
- "The runner isn't responding." gives no next step.
- The inert "Saved ✓" still looks active.

**Not yet checked:**
- The dark popup against the real bridge, including dark axe. The dark run failed because another agent held 4310; the six committed dark popup shots do match their labels.
- Head 6da1a83.
- Settings → "Export last capture" under the new flow.

The critic's scratch is at `/tmp/wc-ui4-p07b-r2-scratch/shots/`:
- screenshots: `A-*` (options), `B-*` (popup), `cs-*` (contact sheets of the 32 committed shots);
- raw results: `A-light.json`, `A-dark.json`, `B-light.json`.

## Reviewer partial findings
Stopped with no verdict. Reviewed head 6da1a83 (including c207783), and never bound 4310.

**Issues found so far.** Each comes with a probe that fails by design, in the reviewer's scratch.
1. **A capture queued during a flush loses its retry alarm.**
   - Probe P1: capture A is flushing when the popup queues B after a network error, which sets the alarm. A is delivered, B stays queued, but the alarm is gone.
   - Cause: `outbox.ts:231-237` re-reads the queue only when some entry is still retrying. Otherwise it clears the alarm without looking, which wipes the alarm B just set.
   - Impact: the worker only wakes on onInstalled/onAlarm. B waits for another failed Save or a reload, and is lost when Chrome quits because the outbox lives in `storage.session`. The B2 race test checks that B survives, not that it gets retried.
   - Fix: decide from a fresh read in both branches (or never clear the alarm), and add an alarm assertion to the race test.
2. **A pause stays in place if the one attempt after re-pairing fails briefly.**
   - Probe P2: a `token_invalid`-paused entry, retried with `includePaused`, gets a 503. It keeps `pausedReason: "token_invalid"`, later alarm flushes send nothing, and it stays stuck until the next pairing.
   - Cause: `outbox.ts:217`, `writeEntry({ ...entry, attempts: entry.attempts + 1 })`, carries `pausedReason` forward.
   - The flush after pairing also runs in the options page, so closing it mid-flush leaves the rest of the queue paused.
   - Fix: on a successful pairing, lift every pause in storage first, set the alarm, then flush. Clear `pausedReason` in the retry branch. Test both.
3. **The background flush deletes captures that no bridge ever received.**
   - Probes P3 and P4: the real `createBridgeClient` gets `200 text/html` from another process on 4310. The capture is removed, and `delivered` is `[]`.
   - Cause: the drop branch at `outbox.ts:221-223` catches `invalid_response`. `unknown_error` is likely to land there too; that was read, not run.
   - This is the case B4 exists to prevent.
   - Fix: never delete on `invalid_response` or `unknown_error`. Pause or back off instead, and show it on the options page.
4. **A flush racing a pairing can undo the pairing (narrow).**
   - Probe P5: a worker request with the old token T1 is in flight when pairing stores T2. The pairing's flush delivers A. The stale 401 for T1 then clears the new token (`bridge-client.ts:204` clears on any 401 without comparing tokens), and A is written back as paused.
   - Fix: clear the token only if the stored one is still the token that got the 401. Treat a 401 for a replaced token as a retry, not a pause.
5. **Test gap:** the `ok: true` check is untested. Removing it keeps 21/21 green, because the wrong-body test's body also lacks `eventId`. Add a body that echoes `eventId` without `ok: true`.

**Nits:**
- "Saved ✓" appears on dropped outcomes (other 4xx, `invalid_response`).
- `findEphemeralPort` releases the probe port before binding it, a small race.
- Captures queued in the same millisecond flush in arbitrary order.

**Verified:**

| Item | Result |
|---|---|
| B1 | Passes: realbridge 11/11 twice while another process held 4310, and with the fixed port restored 11/11 fail with a clear "already in use". |
| B2 | Data race fixed (a stale write-back plant fails the test). The alarm race is issue 1. |
| B3 | Branching works: five plants each caught. Issues 2–4 remain. |
| B4 | `eventId` matching is tested. `ok: true` is issue 5; bad-response handling is issue 3. |
| B5 | The correction is right. CI on c207783 failed exactly as predicted (root Test step, manifest.test.ts, 2 failed). |
| B6 | Wired in. The revoke fix is a runtime guard, not a cast. |
| E1 and E2 | Pass, with plants caught. |
| E3 and E4 | Read only. |
| Manifest | Unchanged. |
| `storage.local` | Unused by non-test source. The new keys (`jobCaptureOutbox:<eventId>`, `pairingOriginMismatch`) are session-only. |
| Ordering | Oldest first. |
| Cap | None beyond the 10 MB session quota, about 50 captures at 200 KB each; past that Save shows "Couldn't save". |
| Dedupe | Holds (P6). |
| 401 | Never spins (P8), and re-pairing delivers exactly once (P9). |
| Scope | All 65 files are inside the allowlist. |
| Chain | Green on c207783 (extension 215 + 2 skipped). |

**Not yet checked:**
- CI on 6da1a83 (run 35758037837): dist tests with 0 skipped, and Playwright including gates 4 and 9.
- The chain on 6da1a83, and a merge onto f9e421f.
- Timeout-removal and B6 type-error plants.
- Whether any test catches removing the `[hidden]` rule, and a dist scan.
- A close read of the e2e edits.
- B7–B12 and the polish items, which belong to the UI critic.

**Scratch:**
- `/tmp/wc-rev4r2-p07b` is at c207783, clean. Chain log `/tmp/wc-rev4r2-p07b-chain.log`; the 4310 sampler log `/tmp/wc-rev4r2-4310-sampler.log`.
- `/tmp/wc-rev4r2-p07b-mut` is at 6da1a83, with untracked probe files that fail by design: `extension/src/shared/zz-review-probes.test.ts`, `extension/zz-sim-4310-busy.setup.ts`, `extension/zz-vitest.sim.config.ts`, `extension/src/zz-sim-mechanism.test.ts`. Remove them before running a chain there.
- The failed CI log for c207783 is `/tmp/wc-rev4r2-p07b-ci-c207783-failed.log`.

**Orchestrator note for the successor.**
- The one-revision rule has been spent on P07-B: revision 1 was the implementer's one round. A second REVISE therefore goes to a fresh Opus escalation implementer.
- Give it:
  - reviewer issues 1–5 and the nits above;
  - the UI critic's provisional issues 1–5 and polish;
  - whatever the resumed round 2 adds on 6da1a83.
- Start with the resumed round 2, so the verdict is complete and the escalation receives one combined list.

## CI on 6da1a83: FAILED (run 35758037837, extension step)
- The B5 correction itself works: `EXTENSION_DIST_REQUIRED=1` vitest ran 19 files and 217 tests, all passed, 0 skipped.
- Playwright had 1 failure and 22 passes:
  - `e2e/real-popup.spec.ts:140`, "captures, previews, and saves a real job posting through a genuine popup gesture (json-ld fixture)";
  - error: `P07A-popup-dark.png: pixel (159, 0) in the top-right corner is rgb(86, 86, 86), not the page's own background rgb(0, 0, 0) … looks like a DevTools viewport-size label`.
- Likely cause, not verified: revision 1 narrowed the dark-theme brightness retry to "only on matchMedia disagreement" (a round-1 reviewer nit). In CI, the size-label overlay case no longer gets the retry that P07-A's Opus escalation added (see the P07 report, "Revision 2 (iter-003, Opus escalation)", `captureInTheme()`).
- The escalation implementer must make CI green without weakening the guard. For example, keep the overlay-wait/retry path separate from the matchMedia-disagreement retry.
- **CI history on packet/P07-B,** per the implementer at the pause:
  - The last green run was 339c38d, the start-of-revision merge.
  - Every run from 7334ef0 onwards failed.
  - At c207783, the root Test step failed first: the uncorrected B5 gate reported "dist/worker.js should exist". The extension step's e2e therefore never ran there.
  - So the dark-popup screenshot failure most likely came in with revision 1, and was only exposed once B5 was corrected.
- **The implementer's stop state:** worktree clean; origin and local both at 6da1a83; no ports held.
