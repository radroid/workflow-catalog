# P03 (#11): round-3 review of head bbfa00e (iter 005)

Revision 2 was done by a fresh Opus escalation implementer. Both reviewers returned REVISE, so revision 3 goes back to that **same Opus implementer** (its worktree is kept), with decisions J1–J8 below.

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

## Reviewer (Opus): REVISE — 1 issue

Scratch: `/tmp/p03-r3-review/`:
- chain logs `head-*`, `merge-*` and `combo-*`, and the clones `merge-clone/` and `combo-clone/`;
- `mut/`: `specs.mjs`, `run.mjs`, `mutations.log`, `out/` and `backup/`;
- the probes `zz-reviewer-probe*.test.ts`, with `probe-evidence.txt` and `probe-g1-evidence.txt`.

**What holds:**
- **Chain:** green at the head, and on the merge onto 5f14eed with no conflicts. Runner 28 files / 374 tests; agent evals 5 of 5, 85 gates.
- **P08-A overlap:** only `runner/test/route-modules.test.ts` conflicts. Take P03's `readdir` version: P03 + P08-A gives 464/464.
- **Probes:** 25 cases, all pass. Every profile write goes through the lock helper, the eve tool steps included.
- **Mutations:** 31 of the implementer's 43 re-run and killed; 12 of the reviewer's 15 killed (the 3 survivors are N2–N4).
- **Checklist:** V1–V6, VN1–VN11, D8, D10, D11 and D13–D16 are verified; D12 and the visuals are the UI critic's. The normal `turn.completed → session.waiting` turn is read as finished. Scope is clean: all 94 files are allowed.

**Issue 1. A cancelled extraction turn counts as a success.**
- `interpretExtractionTurn` (`runner/server/routes/onboarding.ts:105-114`) has no `turn.cancelled` rule. eve's `isTurnFailureEvent` doesn't include it, and eve always follows it with `session.waiting`.
- Probe G1 (real `Client`), stream `… extract_claims persisted → turn.cancelled → session.waiting`:
  - the route answers 200 `ok:true` and records the content hash;
  - the next extract of the same text answers "unchanged" and opens no session;
  - with nothing persisted, it says "The model finished without saving any claims".

**Nits:**
- **N1.** The D8 wait compounds for queued requests: `profile-writes.ts:161` sets the deadline only when a request reaches the head of the in-process chain. Three queued requests got their 503s at 5, 10 and 15 s.
- **N2.** No test pins the 5 s default (`profile-writes.ts:34`).
- **N3.** The extraction route's 409 on an unreadable file isn't tested (`onboarding.ts:310`).
- **N4.** The D10 notes in the page view aren't tested (`onboarding.ts:193`).
- **N5.** Item 15's boundary rule is tested only with a fake gateway. The reviewer thought the real client could also end a turn quietly once its idle reconnects run out. See J2: it can't on this path.
- **N6.** Marker-shaped text breaks the runner's own file.
  - A claim whose earlier line ends in `` `[x]` `` confuses the reader (`profile-markdown.ts:92-98`, `:270-273`).
  - An unchanged Profile save is then refused (422), and any hand edit locks every write until a discard.
  - Claim text comes from the model, so a hostile source could cause it.
- **N7.** `GET /readiness` (`onboarding.ts:230`) doesn't reconcile hand edits.

## Orchestrator decisions for revision 3 (J1–J8)

- **J1. `turn.cancelled` is not ok (issue 1).**
  - Rule: `interpretExtractionTurn` treats `turn.cancelled` as not ok, with a plain reason ("The extraction was stopped before it finished. Try again.").
  - Then: no hash is recorded, and the next extract of the same text runs again.
  - Claims persisted before the cancel are handled as on the timeout path.
  - Tests, both with the real `Client`:
    - that sequence gives not ok, no hash, and a new session on re-extract;
    - the spike's normal sequence stays the ok control.
- **J2. N5 is not needed.**
  - A turn response (`MessageResponse`: `result()`, or iterating it) follows its stream with `keepAlive`, so eve reopens a silent stream without limit.
  - If that stream ends before the boundary without an abort, eve throws "The response stream ended before the accepted message reached its turn boundary." (`dist/src/client/session.js`).
  - Only a manually opened `session.stream()` gives up quietly: after five empty reopens, each after 15 s of silence.
  - So on this path the only quiet end is the abort, which is already tested with the real `Client`. `eve-runtime.md` §8 item 15 now says this.
- **J3. D9 refusals (UI 1, polish 7).**
  - **The refusal:** while `markdownError` is set, every refused write shows one short line: "Not saved: career-profile.md has an edit the runner can't read. See the note at the top." There is no field error and no `aria-invalid`.
  - **The problem card:** it names the problem by line number ("Line 14: …"). A marker's UUID never reaches visible text.
  - **Save & extract:** the text is saved and the extraction does not run. The message says both, and says what to do next.
  - **Discard:** it clears every field error on both pages.
  - **Typed text is never lost silently.** Discard keeps the Profile editor's unsaved text, since its base is the render that the discard restores; if a case can't keep it, Discard asks first.
  - **The Profile editor while D9 holds:** it shows the file as it is on disk (the damaged text) unless it holds unsaved text, and "Save edits" isn't offered.
- **J4. Announcements and focus (UI 2).**
  - Never replace the focused element. Update rows in place, keyed by id, or reuse the focused node, so focus never passes through `<body>`. Prove it with a test.
  - Each outcome is announced once. When an action moves focus to a field whose description carries the error or the question, the line says only the short outcome ("Not saved." or "An answer is needed."). The field carries the detail.
- **J5. The pinned line (UI 3).**
  - Messages are one short sentence, aiming at 90 characters or fewer. Details live in cards and fields.
  - At 640 px and below, the line clamps to two lines, and the full text stays in its accessible text.
  - `scroll-padding-top` tracks the line's real height, so a focused control, including the Profile editor at 390, scrolls fully clear.
- **J6. Polish 1–11 (7 is covered by J3):**
  1. "Working…" appears only after about 300 ms.
  2. `npm run runner` goes in `<code>`.
  3. A field error clears when its field changes, or when the next action on its row succeeds. No error outlives a later unrelated action.
  4. The reason names the real trigger: fact claim, metric, or the always-ask word, quoted.
  5. The summary's accessible text is one phrase, with no doubled prefix.
  6. No layout shift under a focused control at 390.
  8. The withdrawal card links to the open question and moves focus to it.
  9. Evidence refs read like "pasted.txt, line 2", with the full path in `title`. Leave the model-facing extraction prompt as it is; if you change it, its fixture ships with it.
  10. The open question is in view in the `P03-profile-question-open-*` shots.
  11. The page uses the file's wording ("23 September 2026 at 16:16") in local time, with the zone named.
- **J7. The reviewer's nits.**
  - **N1:** set the D8 deadline before joining the in-process chain. Test that three queued writers all get their 503 within about 5 s.
  - **N2:** time the 503 test so it pins the default.
  - **N3:** add the extract route to the D9 loop.
  - **N4:** test the D10 notes in the page view.
  - **N6:** neutralise marker-shaped tokens in claim text when rendering. Add a property-test case with hostile claim text, and check that an unchanged save round-trips.
  - **N7:** `GET /readiness` reads through `load()`, with a test.
- **J8. Screenshots.** Retake every affected shot:
  - the D9 states at 390 and 1280;
  - the question-open shots;
  - the pinned line at 390, after a question and after a refusal.
