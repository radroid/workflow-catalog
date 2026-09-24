# P05 (#16): round-2 review of head 6a4354d (iter 007)

Revision 1 was done by the same Opus implementer, with V1–V20 from `logs/handoff/P05-round-1-review.md`. The code head is ac6051c, a merge of integration at 9afdbd7. CI is green on both commits: 36013286956 on 6a4354d and 36012339885 on ac6051c, each including the extension e2e.

## UI critic (Opus): REVISE, 2 issues

Scratch: `/tmp/wc-ui11-p05-scratch/` holds:
- `r2-s1.mjs` to `r2-s12.mjs`;
- `out/r2-*.json`, `log-r2.json` and `turns-r2.log`;
- `shots/R2-*.png` and `shots/pdf-r2-*.png`;
- `downloads/r2-*`;
- `sheets-r2/`.

**Round 1's nine issues are all fixed:**
- **V8.** "Saved. Prepare again to put it on your documents." Prepare again re-exports as version 2 with 0 model turns and no run. The same details then give "Already prepared".
- **V11.** The row line and the badge follow the answers.
- **V12.** Onboarding links.
- **V13.** Outcomes are announced once after a reload or a revisit. "Can't reach the runner. Is it still running?" is announced once and clears on restart.
- **V14.** Descriptive names, with `filename*` for Unicode, and sanitised.
- **V15.** Version notes.
- **V16.** Cyrillic prints correctly. Katakana warns at the name field and beside the PDF, and prints a visible "�".
- **V17.** `<code>`.

All of V18's polish is done, including the optional items. All 32 committed screenshots are right.

**The regression sweep passes:**
- one live region;
- focus kept through refreshes;
- `aria-disabled` within about 100 ms;
- tab order;
- axe finds 0 violations in 70 variants over 21 states;
- nothing under 4.5:1;
- no sideways scroll;
- amber only for open questions.

**New issues:**
1. **Changing the name back leaves a dead end.** Version 2 carries "Ada Quill", and version 3 (the latest) "Ada J. Quill". When the person switches back to "Ada Quill":
   - the save says "Prepare again…";
   - version 3 keeps its "changed since" note;
   - Prepare again always answers "Already prepared … matches version 2", and the note never clears.
   Fix: count "already prepared" only when the newest version carries the current details; otherwise re-export. Shot: `shots/R2-J1-revert-dead-end-light-1280-viewport.png`.
2. **Two watched outcomes that settle in the same refresh announce only the last.** Harbor hit a provider limit, which paused the budget; Quill, queued behind it, was then refused. Only Quill's failure was announced, never the cause. Fix: announce that refresh's outcomes as one message. Evidence: `out/r2-s12.json`.

**Polish:**
1. The PDF warning isn't in the save announcement, and the PDF link isn't tied to its note (`aria-describedby`). An undrawable character in the contact line is warned about only under Name.
2. The re-export wording "the name and contact line at the top" is wrong for a cover letter. A re-export on a later day changes the letter's date.
3. At the daily run limit, Prepare shows "Preparing…" and then fails, instead of refusing up front.
4. A hung runner is never noticed, because the page's requests have no timeout; the Jobs page has one.
5. With the budget paused and focus on the runner line's Settings link, the runner going down drops focus to the body.
6. Titles over 60 characters or 6 words are left out of download names, so two such jobs at one company collide.

## Reviewer (Opus)

Pending.
