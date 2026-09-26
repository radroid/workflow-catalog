# P05 (#16): round-4 review of head 00ff33e (iter 007)

Revision 3 was done by the same Opus escalation, with Y1–Y8 from `logs/handoff/P05-round-3-review.md`. CI 36092747011 on 00ff33e is green, including the extension e2e. Round 4 was narrow, with the round-3 reviewer and critic. Only an undone Y item, a regression against 1a0f854, or a weakened or unlisted test edit counted.

## UI critic (Opus): REVISE, 1 issue

Scratch: `/tmp/wc-ui13-p05-scratch/r4/`.

**Done:**
- **Y5:** r3-s7 and the other direction keep the newest version's letter choice, with no model turn.
- **Y6:** at 22:30 EDT, the page, the letter (in all three formats) and the diff all say Sep 25. X8 holds 3 days later.
- **Y7:** a tampered draft is refused with the new wording. The next Prepare runs fresh (v4 passes), and the one after says "already prepared", so there is no loop.
- **Y8:** all 48 screenshots are at true widths and in the right themes, and the 32 V19 retakes show the corrected hint.
- **The sweep:** clean, with axe 0 and the lowest contrast 6.76:1.

**Issue:**
1. **After a failed attempt, the detail's Prepare again no longer retries it** (a regression against 1a0f854).
   - `application.js:775` exempts only parked attempts. A failed or interrupted attempt uses the newest version's letter choice, answers "Already prepared", and leaves the "Try again" note.
   - Evidence: `r4-s5-old.json` and `r4-s5-new.json`.

**Polish:** the report's "scale 1" wording is wrong for the four `empty-*` retakes.

## Reviewer (Opus): REVISE, 2 issues

Scratch: `/tmp/wc-rev-p05-r4-probes/`, `-logs/`, `-mutations/`, `-base/` (1a0f854's validator), and `-cause-r1`/`-cause-r2` (patched copies that confirm each cause). The merge clone is at `dd645d8`.

**Done:**
- **Y1–Y4:** the r3 corpus shows 5 mismatches (28 at 1a0f854). Two are P05.1 findings, and three are ruled refusals. The r3b set shows 0 (9 before). Every r3d probe is refused.
- **Honest controls:** all pass, including Mt., Ft., Lt. and Mx.
- **The reviewer's realistic resume and letter:** refused only at "now use", the cost Y1 accepts.
- **Y2's hint:** it shows for "Quill Sq.", and never for an ordinary sentence end.
- **Y5–Y7:** tested, and working as ruled. Y6's pin takes effect on CI's UTC machine.
- **Tests:** exactly the 5 listed lines are removed, and nothing is weakened.
- **Mutations:** all 19 fail tests.
- **Chain:** green, merged and unmerged (runner 1289, 161 gates), and CI is green.
- **Scope:** clean, 109 files.

**Issues (regressions against 1a0f854, from Y3):**
1. **A bracketed seniority word after the claim's title passes:** "Platform Engineer (Staff) at Fernwood Labs, 2019–2021 [C9].", and the same with "(Senior)", "(Staff level)" and "(Distinguished)". The cause is `facts.ts:639`, which turns every "(" into ", " when reading titles.
2. **"I was engineering manager at Fernwood Labs from 2019 to 2021 [C9]." passes,** and so does "I was platform architect at …". The cause is `NOT_TITLE_OPENERS` in `extendsLeft` (`facts.ts:709`), which stops at "was". 1a0f854 refused these only by reading "i was engineering manager" as the title. That also wrongly refused the honest version.

**Costs of the rulings (not counted; flagged for the orchestrator):**
- **Y2's list and the citation guarantee:** "Worked as a sales rep. Shipped … [C3]." passes, where 1a0f854 refused it. So do "…the next gen. Shipped …" and "…on Quill Rd. Shipped …".
- **Y4's "scores of"** also refuses "…the credit scores of merchants [C1]."
- **Y1's "anywhere":**
  - "…balances remain consistent [C1]." and "…what is today Northwind Labs' billing [C1]." are refused;
  - a claim that says "now" in another sense counts as open. Against "Built the Harbor ledger service, now retired." (no years), "Still run the Harbor ledger service [C9]." passes, where 1a0f854 refused it.

**Findings for P05.1 (1a0f854 behaves the same):**
- "…, and the platform team's manager [C9]." passes.
- "x.com." passes.
- "I was the engineering manager at …" passes (with an article).
- "Staff engineer (Senior) at Harbor, 2021–2023 [C10]." passes.
- "Platform Engineer (Sr.) at …" is refused as uncited, because a closing bracket after a listed abbreviation ends the sentence.
- "…from 2021 through the last month of 2023" is refused as a start with no end.

## Decisions for revision 4 (Z1–Z4)

The same escalation does these. Z1 went out first, at the critic's verdict; Z2–Z4 follow.

- **Z1. Retry after a failed attempt (critic 1).** When the detail's state is failed or interrupted, Prepare again retries that attempt's own letter choice, as it does for a parked attempt. Only an idle state uses the newest version's choice (Y5). Test the critic's steps for failed and interrupted. Also fix the report's "scale 1" wording.
- **Z2. A bracket after a role phrase (reviewer 1).**
  - When a role phrase is followed by a bracket holding a seniority word or a role phrase ("(Staff)", "(Senior)", "(Staff level)", "(Distinguished)", "(Sr.)"), the bracket's words join the title that is compared.
  - Any other bracket (a company, a place, a team) stays a separator, so "Platform Engineer (Fernwood Labs), 2019–2021 [C9]." passes and Y3's "Security engineer (Fernwood Labs)" is still refused.
  - The same path covers the P05.1 finding "Staff engineer (Senior) at Harbor". Fix it here, and "(Sr.)" being refused as uncited too.
- **Z3. A title after "was" (reviewer 2).**
  - Read a role phrase directly after "was", "I was", "served as" or "worked as", with or without "a", "an" or "the", as a title, and compare it.
  - "I was engineering manager at Fernwood Labs … [C9]." and "I was the engineering manager at …" are refused.
  - "I was Platform Engineer at Fernwood Labs … [C9]." passes, and so does "I was engineering manager at Harbor" against a claim with that exact title.
- **Z4. Corrections to my own rulings (the reviewer's costs).**
  - **Y2, case:** the words Y2 added count as abbreviations only when capitalised ("Lt.", "Rep.", "Gen.", "Mt.", "Rd."). Lower case ("sales rep.", "next gen.", "6 ft.") ends the sentence. So "Worked as a sales rep. Shipped … [C3]." is refused again, and the reviewer's Mt./Ft./Lt./Mx. probes still pass. "Quill Rd. Shipped …" keeps riding along, the same trade the list already makes for "Inc.". Record that.
  - **Y4, "scores of":** read it as a quantity only where a quantity can start, not after a noun that makes "scores" a noun ("credit scores of", "test scores of"). "…the credit scores of merchants [C1]." passes, and "scores of engineers" is still refused.
  - **Y1, claims:** Y1's new words make a draft sentence state an open end; they never make a claim open. A claim is open only by the markers read before revision 3: a range ending in "present", "since …", "currently", and so on. So against "Built the Harbor ledger service, now retired.", "Still run … [C9]." is refused again.
  - **Y1's other costs stand:** "remain consistent" and "what is today" are refused, the same class as "now use".
- **Every Z item:**
  - a draft-level test for each probe;
  - a mutation proof;
  - the honest controls still passing, and the realistic resume and cover letter run again.
  - Then the full chain after merging integration, CI green, and every edited existing assertion listed.

**Round 5** is narrow, with the same reviewer and critic. Only these count:
- a Z item not done;
- a regression against 00ff33e;
- a weakened or unlisted test edit.
Older-kind gaps still go to P05.1.

**Carried to P05.1** (created when P05 merges): the reviewer's remaining findings above, and the implementer's two.
