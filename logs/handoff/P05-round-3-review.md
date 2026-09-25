# P05 (#16): round-3 review of head 1a0f854 (iter 007)

Revision 2 was done by two Opus escalations: ce49ca9 (X5, X7), then, after the orchestrator's session died, a fresh one for the rest, through 1a0f854. CI 36083736390 is green on 1a0f854, including the extension e2e. Round 2's reviewer and critic died with the session, so round 3 used fresh ones (prompts: `P05-round-3-prompts.md`).

## Reviewer (Opus): REVISE, 4 issues

Scratch: `/tmp/wc-rev-p05-r3-probes/`, `/tmp/wc-rev-p05-r3-logs/`, `/tmp/wc-rev-p05-r3-mutations/`, and `/tmp/wc-rev-p05-r3-base/` (6a4354d's validator, to tell regressions from old gaps). The merge clone is `/tmp/wc-rev-p05-r3-merge`, at `a43fcaa`.

**What holds:**
- **X1–X4:** every round-2 probe is refused (titles, numbers, dates). The only leftovers are the ruled ones: "first" isn't read, "Owner of …" and "2019–21" are refused, and a lower-case word right after a full stop with no space passes.
- **Honest controls all pass,** including sentence-case claims written in title case, "between 2019 and 2021", B.S. and B.Eng. cited verbatim, and a dated fact stated with no date. The reviewer's own realistic resume and cover letter pass.
- **X5 and X7:** Ada, Zoe, Ada, Zoe, Ada gives versions 2–5, each with the current name. A tampered draft gets a 409 `reexport_refused`, and all 14 workspace files are byte-identical before and after.
- **X6, X8, X9:** tested, and each mutation is caught.
- **Existing tests:** no unlisted or weakened assertion. The two listed edits are exact.
- **Mutations:** all 18 fail tests.
- **Chain:** green at the head, and merged onto integration at a170ffb (runner 1193, evals 7/7 with 161 gates). CI green.
- **Scope:** clean. All 93 files are in the Owns or its grants.

**Issues:**
1. **Open ends and relative dates in words pass when a sentence gives no year** (new in revision 2; all refused at 6a4354d).
   - Against C9 "Platform Engineer at Fernwood Labs, 2019–2021.":
     - "Now a …", "Presently a …" and "Nowadays a …";
     - "… to date" and "… as of now";
     - "…, where I now own the billing pipeline [C9][C10]."
   - Against a closed billing claim: "last year", "this year", "Recently built …" and "Built and now run …".
   - **Cause:** only "currently" counts as an open end (`facts.ts:285`), and "to date" and "now" count only after a year (`:346-351`). So `validator.ts:277` skips the end-year rule.
2. **The one-part dotted-word rule refuses honest text** (new in revision 2).
   - A claim with "Mt. Hood" and "Ft. Worth", cited verbatim, is refused twice as uncited. "Lt." and "Mx." are refused too.
   - **Cause:** `text.ts:136`, and there's no mt, ft, lt or mx in the list. The model is told only "uncited", the same dead end as round 2's B.Eng. case.
3. **Inflated or changed titles still pass** (an older gap; all pass at 6a4354d too). Against C9:
   - "Engineering manager — Fernwood Labs, …";
   - "Engineering manager on (or with) the payments team at …";
   - "Security engineer (Fernwood Labs), …";
   - "Platform Engineer and team lead at …";
   - "Platform Engineer, then engineering manager, at …" and "…, later platform architect";
   - "Took on the engineering manager role at …".
   - **Cause:** an opening title counts only before "at", "of", "for" or a comma (`facts.ts:416`, `:595`).
4. **Some quantities in words pass** (an older gap): "by an order of magnitude" and "single-digit milliseconds".

**Nits:**
- X1's first-word reading refuses "Lead developer experience work…", "Senior engineer feedback shaped…" and "Head engineering hiring…". This is as ruled, and the refusal names the title it read.
- X2's wider dotted pattern lets "Won the hackathon run by x.com. Shipped … [C3]." through.
- "As Senior Platform Engineer at Northwind Labs, I led … [C8][C1]." is refused; "As a …" passes.
- Word-matching limits: "Remains a …", "2019–2021 and beyond", "quintupled", "a couple of" and "scores of" pass.
- Switching back when the newest same-input version is tampered with is refused, even if an older one is intact. That's acceptable.

## UI critic (Opus): REVISE, 2 issues

Scratch: `/tmp/wc-ui13-p05-scratch/` (the scripts `r3-s1` to `r3-s9`, `out-r3-*`, `shots/R3-*`, `downloads/`, `log-r3.json`). The harness adds a movable clock.

**Fixed:**
- **X5:** the revert re-exports version 3 with 0 model turns, and the note clears.
- **X6:** r2-s12's case gives one line, once in 14 s. It also works with two and three outcomes.
- **X8:** the re-export note fits a letter. The letter keeps its first date 3 days later in all three formats. The note names the version it's against.
- **X9:** the save line carries the PDF warning. Both PDF links have `aria-describedby`. The contact line has its own note. At the daily limit, Prepare refuses up front and names the limit.
- **The 12 new screenshots are right.**
- **The regression sweep passes:**
  - one live region, and each outcome announced once;
  - focus kept;
  - `aria-disabled` within 120 ms;
  - 117 tab stops in order;
  - axe 0 violations in 32 audits;
  - the lowest contrast 6.76:1;
  - no sideways scroll;
  - amber only for an open question.

**Issues:**
1. **"Prepare again" flips the cover letter back.** `application.js:764` sends the last model attempt's letter choice, not the newest version's. Since X5, the two can disagree.
   - Steps:
     1. Prepare with no letter (v1).
     2. Prepare with a letter (v2).
     3. Prepare from the form with no letter: v3 re-exports v1.
     4. Press Prepare again with nothing changed.
   - Result: "Re-exported … as version 4, from version 2's sentences", with a letter. It also happened on its own three more times.
   - Shots: `shots/R3-N1-*`.
2. **The documents are dated in UTC, and the page in local time.** `letterDate` (`export/document.ts:86`) dates the letter and the diff's "Prepared" line. At 22:09 EDT on Sep 24, the page said Sep 24 and the letter said September 25. It dates from `60894de`; the critic counts it because X8 made the letter's date binding.

**Polish:**
- The combined line cuts names mid-word, even at 1280, and its counted form names none, not even the failure.
- X7's refusal is a loop. The note keeps saying "Prepare again to put it on your documents", and every press repeats "Not re-exported…" with no way forward. Issue 1 caused this case.
- Revision 1's 32 V19 screenshots all show the details card's old hint, "…at the top of every resume and cover letter", which X8 corrected. Nothing else in them is out of date.
- A repeated identical refusal first announces the tag alone ("Refused"). This is the pattern shared with the Jobs page.

## Decisions for revision 3 (Y1–Y8)

The same escalation takes these: it's the implementer for every later REVISE. Validator changes are stricter, except where Y2 rules a false refusal away. Each probe gets a draft-level test. Keep the honest controls passing, and run the realistic resume and cover letter again.

- **Y1. Present time and relative dates (reviewer 1; a revision-2 regression).**
  - These count as open ends anywhere in the sentence, as "currently" and "still" do: "now", "today", "presently", "nowadays", "to date", "as of now", "at present", "these days", "remain(s)", "continue(s) to" and "and beyond". X4(a) applies: refused unless a cited claim is itself open.
  - This accepts the cost the reviewer names: "…tooling that three engineering teams now use [C3]" is refused unless C3 is open, just as "still used by" is.
  - Relative dates state a date no claim can: "recently", "lately", "last year", "this year", "last month", "this month", "N years ago". A sentence with one is refused, unless a cited claim's own text has the same phrase. The refusal says to use the claim's years.
  - Test every issue-1 probe, and the nit's "Remains a …" and "2019–2021 and beyond". "Staff Engineer at Northwind Labs since 2022, where I now lead … [C8]" still passes, because C8 is open.
- **Y2. One-part dotted words (reviewer 2; a revision-2 regression, ruled a false-refusal fix).**
  - Keep the one-part rule: "it." and "UK." still end a sentence.
  - The list gains mt, ft, pt, lt, mx and rd. It also gains the common longer title abbreviations, which were already sentence ends before revision 2: sgt, capt, cpl, pvt, col, gen, maj, adm, cmdr, rev, hon, gov, sen, rep, supt, ave, blvd.
  - When a fragment that ends in an unlisted one-part dotted word is refused as uncited, the refusal adds: "This sentence seems to end at “Xx.”. If that's an abbreviation, write the word out." So the model always has a way out.
  - Tests:
    - the three probes pass;
    - "… for it. Shipped …" and "… in the UK. Won …" still split;
    - the hint shows for an unlisted one.
- **Y3. Titles, part 2 (reviewer 3; an older gap in X1's area).**
  - An opening role phrase counts as a title whatever follows it: "at", "of", "for", a comma, a dash, a parenthesis, a colon, "on", "with", "in", or the end of the sentence. "Lead the…" and "Head the…" still don't count.
  - A role phrase directly after "and", "then" or "later", or after "as" (with or without "a" or "an"), counts too. So does one directly before "role", "position" or "title".
  - Every counted title must equal a cited claim's title, ignoring case and hyphens.
  - Test every issue-3 probe. The honest controls must pass: the exact title in each of those positions, and "As Senior Platform Engineer at Northwind Labs, I led … [C8][C1]." (the reviewer's nit, a false refusal).
- **Y4. Quantities in words (reviewer 4 and the nit; an older gap in X3's area).**
  - Read "single-digit" as "double-digit" and "triple-digit" are read.
  - Read "an order of magnitude" and "orders of magnitude" as 10×.
  - Read "quintuple(d)" and "sextuple(d)" as "double" is read.
  - Read these as quantities too, where they aren't already: "a couple of", "a dozen", "dozens", "scores of", "hundreds", "thousands", "millions" and "billions". A draft may use one only if a cited claim uses the same word. Accepting a claim number that the word covers is optional.
  - Test the probes, and the honest control: a claim's own quantity word, cited verbatim, passes.
- **Y5. Prepare again keeps the newest version's letter choice (critic 1).**
  - The detail's Prepare again uses the newest version's cover-letter choice, unless it is continuing a parked attempt.
  - Test the critic's steps (r3-s7), and the other direction: a letter switched on from the form.
- **Y6. Local dates (critic 2).**
  - The letter's date and the diff's "Prepared" line use the runner machine's local time zone, which is the person's. The page and the documents then agree.
  - Tests pin the zone, and include an evening case that UTC would date as the next day.
  - X8's rule holds: a re-export keeps the letter's first date.
- **Y7. A refused re-export has a way forward (critic polish, ruled in).**
  - The documents' own checks, or a stricter validator after an upgrade, can refuse a re-export. After that, the note and the refusal say that the documents no longer pass the checks and must be prepared fresh. The next Prepare runs a fresh preparation (a new model run) instead of repeating the refused re-export.
  - Test it: tamper with the draft, see the refusal, then Prepare runs fresh and the new version passes.
- **Y8. Finishing.**
  - Screenshots, at a true 390 and at 1280, in light and dark, by absolute path inside your worktree:
    - Y5, before and after;
    - Y7's refusal and its way forward;
    - a validator refusal that shows Y2's hint, if the page shows it.
  - Retake the V19 screenshots that show the details card's old hint.
  - Mutation proofs for Y1–Y7.
  - List every edited existing assertion, with file:line, old → new, and the Y that justifies it.
  - The full chain, and CI green including the e2e.

**Round 4** is narrow, with the same reviewer and critic. It counts as issues only:
- a Y item not done;
- a regression against 1a0f854;
- a weakened or unlisted test edit.
A new word-matching gap of an older kind (a title, number, date or splitting pattern that 1a0f854 also passes) is recorded as a finding for a validator follow-up packet (P05.1), not counted. The loop's history shows that a word-matching validator always has another edge, and P05 is on the critical path.

**Carried:**
- **To P06,** on the Applications page:
  - the combined line cuts names mid-word, and its counted form names nothing (cut at a word, and name at least the failure);
  - a repeated identical refusal first announces the tag alone.
- **To P06.1:** the same repeated-refusal pattern on the Jobs page.
- **To P05.1, if round 4 creates it:** X2's "x.com." case, and any gaps round 4 records.
