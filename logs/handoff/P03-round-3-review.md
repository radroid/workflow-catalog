# P03 (#11): round-3 review of head bbfa00e (iter 005)

Revision 2 was done by a fresh Opus escalation implementer. A REVISE goes back to that **same Opus implementer**; its worktree is kept. The reviewer's section is added when its verdict lands.

## UI critic (Opus): REVISE — 3 issues

Scratch: `/tmp/wc-ui6-p03-scratch/`:
- `harness.ts` (port 4350), `seed.ts` (note, damage and md operations), and the stage scripts `a`–`j`;
- `log.json`;
- `ws/`, and the pre-damage copies of `career-profile.md`;
- `shots/`: 116 files.

The clone is `/tmp/wc-ui6-p03`, at bbfa00e.

**What holds:** round-2 issues 1, 2 (for ordinary messages), 4, 5, 6 (apart from Profile Discard), 7, 8 and 9, and D11, D13 and D16.
- Focus always rests on a planned control.
- One "Last action" line is written once and stays pinned in view.
- Readiness is right in every state.
- Drafts survive re-renders, and saved text loads raw.
- Withdrawal is explained, with no Accept or Reject while unapproved.
- The excluded badge is 6.47:1.
- axe is clean across 98 variants, and nothing scrolls sideways at 390.
- Almost all of the polish is done.

1. **D9 refusals aren't plain, and they leave errors behind.**
   - Every refused write returns a 313-character paragraph, containing the damaged marker's full UUID and "add them on the Onboarding page". It shows three times: in the problem card, in the pinned line (139 px at 390), and as a red field error on whichever control was used, with a false `aria-invalid`.
   - After Save & extract it says "Nothing was saved", but the source text *was* saved: `/content` returned 200.
   - After Discard on Onboarding, the preference field keeps the red D9 error and `aria-invalid`.
   - Discard on Profile silently throws away unsaved editor text.
   - Fix:
     - while `markdownError` is set, refuse with one short line ("Not saved: career-profile.md has an edit the runner can't read. See the note at the top."), with no field error;
     - name an unknown marker by its line, not its UUID;
     - after Save & extract, say the text was saved and extraction waits for the file;
     - clear the D9 field errors on Discard, and keep, or warn about, the Profile editor's unsaved text.
   - Evidence: `log.json` `G:steps` (G2a–G2d, G3, G4) and `H:390` (h7b, h9); `shots/viewport-g-d9-*`, `shots/viewport-h7b-*`, `shots/viewport-h9-*`, `shots/g1-onboarding-d9-*` and `shots/g2-profile-d9-*`.
2. **Screen readers hear field errors and questions twice, and the focused control is re-announced after every action.**
   - A refusal is announced in the line, then focus lands on a field whose description repeats it: the empty Save & extract, an empty preference, an empty reason, a .pdf, and D9.
   - Confirm on a metric announces the question, then focuses the answer box, whose description is the same question.
   - After every action the focused control is replaced by a rebuilt copy. Focus drops to `<body>` for about 15–20 ms, then lands on the new node, so a screen reader re-reads the control and can cut the outcome off. This was measured in the DOM and the AX tree.
   - Fix:
     - never replace the focused node: update rows in place, or reuse the focused element;
     - when a refusal focuses a field that describes the error, don't also announce it in the line, or keep focus on the button;
     - when a question opens, the line only says an answer is needed.
   - Evidence: `log.json` `B:steps`, `C:steps`, `G:steps` and `J:measurements`.
3. **The pinned line isn't compact at 390, and can cover a focused control.**
   - It grows to 121 px (6 lines) after a question, and 139 px (7 lines) for a D9 refusal.
   - Tab to the Profile editor at 390 leaves its top 43 px under the line.
   - Fix: at 640 px and below, clamp the line to two lines, keeping the full text in its accessible text; or keep messages short. A focused control must scroll fully clear of the line.

**Polish:**
1. "Working… up to a minute and a half" flashes for 17 ms. Show it only after about 300 ms.
2. `npm run runner` in the eve error is prose, not `<code>`.
3. Stale field errors stay red and `aria-invalid` across later, unrelated actions.
4. "is a fact claim, so it needs your answer" gives the wrong reason; the trigger is the always-ask word.
5. The summary reads "Not yet: Not ready: generation locked" and "Done: Ready: generation unlocked" to assistive tech.
6. On Profile at 390, the error after a refused save pushes the focused Save button to the viewport edge.
7. In the D9 state, the editor labelled "The file's text" shows the runner's render, not the damaged file, and Save stays offered though every save is refused.
8. The withdrawal card says "the open question below", about 2,000 px down at 390; link it to the claim.
9. Evidence refs show raw paths like `sources/previousCoverLetters/pasted.txt#L2` and break at 390. Consider "pasted.txt, line 2". The extraction prompt names the raw category key.
10. The four `P03-profile-question-open-*` shots show no open question: it sits below the editor's fold.
11. One moment appears as "9/23/2026, 4:16:29 PM" on the page and "23 September 2026 at 20:16 UTC" in the file.
