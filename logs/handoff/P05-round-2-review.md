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

## Reviewer (Opus): REVISE, 5 issues

Scratch folders:
- `/tmp/wc-rev-p05-r2-logs/`: the validator probes r2 to r2d, the route and PDF probes, and the merge runs;
- `/tmp/wc-rev-p05-r2-probes/`;
- `/tmp/wc-rev-p05-r2-mutations/`;
- `/tmp/wc-rev-p05-r2-merge` (at 380cffd).

**What holds:**
- CI on both heads is green, and Playwright passes 37.
- 33 of round 1's probes are now refused. The rest are honest controls, plus issue 1's case.
- **Honest drafts pass:**
  - EC2, K8s, P99 and Q3;
  - "3.5 years";
  - e.g., i.e., U.S., Inc., etc., vs. and approx. mid-sentence;
  - "since 2022", "2022–present" and "Currently … since 2022" citing an open claim;
  - exact titles;
  - "from 2019 to 2021";
  - Node.js;
  - a realistic resume and cover letter.
- **V5:** the test asserts all five things, and the run-log failure too.
- **V6:** the positive controls run before both absence loops. M10 fails 12 tests and M12 fails 4.
- **V7:** a 409 names the file.
- **V8:** all four checks hold, including a name change mid-run. The header is read at export.
- **V9:** 3 lines in §5 and 1 in ARCHITECTURE.md.
- **V10:** excluded labels, ids and wording read as never-issued.
- **V16:**
  - `@expo-google-fonts/noto-sans` 0.4.2 is the latest release, MIT and OFL-1.1, with no scripts, dependencies, native code or network.
  - Its lockfile change is purely additive.
  - It resolves reliably from an installed runner.
  - Outside its coverage it prints U+FFFD, never "?", and both warnings show.
  - 18 styles ship and 2 are used (1.26 MB). That's acceptable; a subset can come later.
- **Nits c, d and g** are fixed.
- **The CI fixes weaken nothing.** V4's changed expectation is stricter.
- **Scope:** clean.
- **Merges:**
  - onto 9afdbd7: green;
  - with P03.2 on top: green;
  - onto integration at 292baef (P03.2 merged, 380cffd): clean and green, with runner 1092 and 161 gates.

**Issues:**
1. **Titles, V2 partial** (`facts.ts:375-447`).
   - The lower-case pass skips a capitalised first word. The left extension absorbs "became" and "named". The "of X" rule stops at an article.
   - These pass against C9 "Platform Engineer at Fernwood Labs, 2019–2021.":
     - "Senior platform engineer", "Staff engineer", "Principal engineer", "Lead platform engineer";
     - "Engineering manager", "VP engineering", "Head of platform", "Chief architect";
     - "…, and became engineering manager there", "…, later named platform architect", "…, and named engineer of the year";
     - "director of the platform group…";
     - "Staff engineer at Northwind Labs since 2022 [C8][C7]".
   - **The other way:** a claim in sentence case yields no title, so "Staff Engineer at Harbor, 2021–2023 [C11]." and "Founding Engineer at Harbor [C12]." are refused.
2. **The splitter refuses honest sentences at abbreviations it doesn't know** (`text.ts:27-29`, `:32`, `:146-151`, a side effect of V4).
   - "B.Eng. Software Engineering, Fernwood University, 2019 [C14]." (the claim's own wording), "incl." and "esp." are all refused.
   - Writing "Bachelor of Engineering" draws a credential refusal, so the model has no obvious way out.
   - The fix loosens specific cases, which needs the orchestrator's ruling.
3. **Number words aren't read** (`facts.ts:26-31`, `:40-43`).
   - "zero-downtime", "tenfold", "threefold", "twofold", "by half", "in half", "helped double" and "by a third" pass.
   - `numbersIn('zero tenfold half double a third first')` returns `[]`.
4. **Dates.**
   - **(a) Open ends that pass:** "…, 2019–2021, and still there", "from 2019 to this day" and "from 2019 onward".
   - **(b) A false refusal forced by V3 as written:** "Built the billing pipeline at Fernwood Labs [C13]." states no date, yet it is refused because C13 ends in 2021 (`validator.ts:274-277`).
5. **Switching the name back, V8 partial.** `preparedWith` (`routes/applications.ts:287-289`) matches any version, while the notice looks only at the newest.
   - Ada, then Zoe, then Ada gives "Already prepared … matches version 1".
   - The notice never clears, and the newest documents keep Zoe.
   - This is the same as the critic's new issue 1.

**Nits:**
- "2019–21" is refused, with a clear message.
- "Owner of …" counts as a title, as ruled.
- A lower-case word right after a full stop with no space passes, which keeps "Node.js" working.
- A re-export doesn't run `validateDraft` again.
- After a cover-letter switch, "the same sentences as version N" can sit above a diff against another version.
- Devanagari is inside the font's coverage, but complex letter forms weren't checked.

**Mutations:** the implementer's 11 all fail tests, and the reviewer's counts match.

## Decisions for the escalation (X1–X10)

Both reviewers returned REVISE twice, so a fresh Opus agent takes over `packet/P05` at 6a4354d. V1–V20 still stand, except where an X amends them. Validator changes are stricter, except where X2 and X4(b) rule a false refusal away. Each probe gets a draft-level test.

- **X1. Titles (reviewer 1).**
  - Read the first word regardless of case, in drafts and in claims, so a claim in sentence case yields its title.
  - Count an opening phrase that ends in a role word before "at", "of", "for" or a comma. "Lead the…" and "Head the…" still don't count.
  - Stop the left extension at a context word ("became", "named", "promoted to").
  - Let "of" take an article.
  - Test every probe above, and the honest controls: "Staff Engineer at Harbor" against "Staff engineer at Harbor…", and a title differing only in case or a hyphen.
- **X2. Abbreviations (reviewer 2), ruled a false-refusal fix.** The guarantee that every sentence carries a citation is unchanged: an abbreviation is simply no longer mistaken for a sentence end. The validator never judged qualitative wording inside a cited sentence anyway.
  - DOTTED takes longer parts: `/^[A-Za-z]{1,2}\.(?:[A-Za-z]{1,5}\.)*$/`.
  - The list gains incl, esp, excl, yrs, avg, intl, univ, govt, mgmt, assoc, al and cf.
  - Tests:
    - a degree cited verbatim from its claim passes;
    - B.Tech., M.Phil. and D.Phil. pass;
    - an uncited sentence after an ordinary full stop is still refused, including right after a sentence that contains an abbreviation.
- **X3. Number words (reviewer 3).**
  - Read zero.
  - Read N-fold as N×.
  - Read "half" like "halved", and read "a third" and "a quarter".
  - Read double, triple and quadruple as whole words, but not in compounds such as "double-entry".
  - "first" is optional.
- **X4. Dates (reviewer 4).**
  - **(a) Open ends.** "still", "to this day", "onward(s)" and "and counting" are open ends. So is a start marker ("from", "since", "starting") with no end. Each is refused unless a cited claim is itself open.
  - **(b) V3 amended.** The end-year rule applies only when the sentence itself states a year, a month or an open end. A sentence with no date isn't refused for leaving out the range. The test that pins the old behaviour changes by this ruling; report it.
- **X5. Switching the name back (reviewer 5, critic 1).** Answer "Already prepared" only when the newest version carries the current key. Otherwise re-export, as a new version that replaces the newest, and the notice clears. Test Ada, then Zoe, then Ada: v3 carries Ada.
- **X6. Outcomes in one refresh (critic 2).** Every outcome that settles in one refresh is announced in one message, each once. Test it.
- **X7. Re-export safety (reviewer nit).** A re-export runs `validateDraft` on the stored draft before exporting, and refuses plainly if the draft fails. Test it.
- **X8. The documents' wording (critic polish 2, reviewer nit).**
  - The re-export note fits the document: a cover letter's name and contact close the letter.
  - A re-export keeps the letter's original date.
  - "The same sentences as version N" names the version the diff is actually against.
- **X9. Warnings and limits (critic polish 1 and 3).**
  - The PDF warning joins the save announcement.
  - The PDF link points to its note with `aria-describedby`.
  - Characters in the contact line are warned about too.
  - At the daily run limit, Prepare refuses up front and names the limit.
- **X10. Finishing.**
  - Screenshots for the changed states (the name revert, the combined announcement, the save with a PDF warning), at a true 390 and at 1280, in light and dark, by absolute path inside your worktree.
  - Mutation proofs for X1–X7.
  - The full chain, and CI green including the e2e.

**Carried:**
- **To P06**, on the Applications page, which P06 extends:
  - the page's requests have no timeout, so a hung runner is never noticed (reuse the Jobs page's timeout);
  - focus drops when the runner line is replaced while it has focus;
  - long titles are left out of download names, so names can collide.
- **To P10 part A**, known limitations: the PDF font covers Latin, Greek, Cyrillic and Vietnamese. Complex scripts such as Devanagari are unverified, and other scripts print "�" with a warning.
