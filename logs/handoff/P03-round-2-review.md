# P03 (#11): round-2 review of head 9584e93 (iter 005)

Revision 1 was the implementer's one revision round. A REVISE in round 2 therefore goes to a fresh **Opus escalation implementer**, with this file as its combined list. The reviewer's section is added when its verdict lands.

## UI critic (Opus): REVISE — 9 issues

Its scratch is `/tmp/wc-ui5-p03-scratch/`:
- `harness.ts` (port 4340), the seed, login and stage scripts;
- `log.json`, with a focus trail and live-region text for every step;
- `shots/`: state sets `a1`–`f3`, one per theme and width, plus `zoom-*` and `viewport-*` shots.

The clone is `/tmp/wc-ui5-p03`, at 9584e93.

**Overall:** revision 1 brought the pages much closer to the walkthrough.
- Readiness has the four ●/○ lines.
- Only Unaccounted sources are amber, and "question open" replaces "disputed".
- Evidence is shown.
- Source controls are grouped and labelled.
- At 390 nothing scrolls sideways, and the error text passes contrast.
- Approve is busy-guarded and inert once approved.

The walkthrough's central promise is still unmet. In the walkthrough, one sticky "Last action" line stays in view. Here that line is usually off-screen, carries UUIDs and raw keys, and is announced two or three times. Focus drops to `<body>` after claim and revision actions, and re-renders discard typed text.

1. **Focus is still lost after most actions (C1).**
   - Focus drops to `<body>` after every claim Confirm, Exclude, Yes or No (11 of 11 presses), after revision Accept and Reject, and after the "Add / edit source text" toggle.
   - Cause: `captureFocus` matches `[id^='claim-']`/`[id^='revision-']`, but the pressed button's own id (`claim-confirm-…`, `revision-accept-…`) also matches. So the card fallback is never recorded. The toggle has no id.
   - A successful Save & extract moves focus to the row container rather than the button.
   - Fix: look for the container from the button's parent, or give containers their own id prefix. Then focus the claim card or the next claim's first action, and the next revision or the revisions heading. Give the toggle a stable id and restore focus to it.
   - Evidence: `log.json` `C:steps`, `E:steps` (E2, E4, E6), `F:same-session` (F3a), `B:steps` (B7).
2. **Announcements carry full UUIDs and raw keys (C6).**
   - Examples: "355b9193-… confirmed.", "previousCoverLetters marked provided.", "previousCoverLetters's source content is unchanged…".
   - Pressing Yes with no text records "your own statement — "Confirmed by the person, without further detail."".
   - Cause: reducer messages (`profile-reducer.ts` lines 262–263, 297, 309, 315, 328, 350 and 365) and route messages (`onboarding.ts` lines 232, 237 and 248) pass through to the page.
   - Fix: use source labels and the claim text (or a short id). Replace the placeholder with something like "You confirmed it without adding detail."
3. **One outcome is announced two or three times, and feedback is usually off-screen (C2).**
   - Every outcome goes to `#live-region` (polite) and to `#last-action` (`role=status`). Errors also go to `#page-error` (`role=alert`).
   - The visible `#last-action` line sits at the top of a long page, so it is off-screen:
     - at 390: the empty Save & extract, the .pdf refusal and the empty preference Add;
     - at 1280: Save & extract, claim decisions and preferences.
4. **Readiness is wrong in three cases (C3).**
   - With zero claims it shows "● Every claim decided"; it should be ○.
   - ●/○ are hidden from assistive tech and unmet lines use the same words as met ones, so a screen reader hears "…Every claim decided Profile approved Not ready…" on an empty profile. The Approve description has the same ambiguity.
   - After approval is withdrawn, `#approve-result` still says "Career profile v3 approved. Generation is now unlocked." under "○ Not ready: generation locked".
5. **The "excluded" badge fails contrast (new in revision 1).**
   - Light: white on #e54b4f is 3.85:1. Dark: white on #ff5b5b is 3.04:1.
   - axe reports `color-contrast` (serious) in every state with an excluded claim.
   - Fix: a darker fill (#b91c1c with white is about 6.5:1), or an outlined badge with red text at 4.5:1 or better, scoped in the page CSS like the C8 fix.
6. **Typed, uploaded and saved source text disappears.**
   - Any re-render rebuilds every text box empty: after a status press (B6c), the toggle (B7b), or a successful Save & extract (B13b).
   - A typed answer is wiped when another claim is decided (C3b).
   - The "show saved source text" fix doesn't work. On a fresh visit the box is empty although the API returns the text (B14). When the text does load, it includes an internal "## pasted.txt" header that would be saved back.
   - Fix: keep drafts in page state keyed by category or claim, or re-render only the changed row. Fetch the saved text when a panel opens, without the header.
7. **The reason for Unavailable / Not applicable isn't reliably kept (D3).**
   - It is saved only if typed before pressing the status. Typed after, which is the natural order, it is silently dropped (B9b).
   - The only visible label is a placeholder, and the field sits after the buttons it must be filled before.
   - At 390 both the placeholder and a saved reason are cut off.
   - Fix: save the reason on its own, or reveal a labelled field after the choice. Show the recorded reason as wrapping text.
8. **The withdrawn state isn't explained, and Profile offers an Accept that can only fail.**
   - After a dispute withdraws approval, neither page says so; Profile says "Not yet approved".
   - Profile still offers Accept on the pending revision, which returns "…nothing to accept a revision against." The committed `P03-profile-*.png` shots show exactly this state.
   - Fix: explain the withdrawal (which version, which claim, "review and approve again"). Hide or explain Accept while unapproved, or reject pending revisions when approval is withdrawn.
9. **Screenshots: 9 of the 48 requested exist.**
   - Missing for Onboarding: empty, in-progress and ready (×4 each), and approved in dark 1280, light 390 and dark 390.
   - Missing for Profile: empty, in-progress, question-open, ready and approved (×4 each).
   - The critic's `a1`–`f3` set is a template.

**Polish** (not counted):
- The eve error still has literal backticks.
- Row buttons don't line up: the first button sits anywhere from x=480 to x=642 at 1280.
- The answer box's only label is its placeholder; the implementer declined this item.
- Save messages mislead:
  - a no-change save while approved says revisions were "proposed above";
  - "Saved. 7 claim(s)" counts excluded claims;
  - "(s)" wording;
  - the Save result line stays visible after Accept or Reject;
  - rejecting a boundary says "The claim keeps its current text."
- Result lines take focus with Chrome's blue ring instead of the theme's `--ring`, and the approval message appears twice.
- At 390 the file input pokes 8 px past the Sources card.
- Enter does nothing in the preference, boundary and presentation fields.
- Revision Accept and Reject lack context in their accessible names.
- Uploads are always saved as `pasted.txt`.
- Onboarding gives no hint that a revision is pending.
- `career-profile.md` shows a raw ISO timestamp.

**Verified:**

| Item | What was checked |
|---|---|
| C4 | Busy and inert behaviour |
| C5 | Amber placement |
| C7 | Layout at 390 |
| C8 | Error contrast: 6.31:1 light, 7.59:1 dark |
| C9 | Source controls |
| C10 | Evidence |
| D3 | Preferences |
| Polish | The markers, Save after the text box, no empty `<p>`, claims as a list, Approve linked to its reasons |
| axe | Clean apart from issue 5 |
| 390 | Page width is 390 in every state |

**Partial:** C1, C2, C3, D3 upload, D3 reason. **Not fixed:** C6.
