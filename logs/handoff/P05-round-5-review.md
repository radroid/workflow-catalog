# P05 (#16): round-5 review of head 451398e (iter 007)

Revision 4 was done by the same Opus escalation, with Z1–Z4 from `logs/handoff/P05-round-4-review.md`. CI 36100537630 on 451398e is green, including the extension e2e. Round 5 was narrow, with the same reviewer and critic. Only an undone Z item, a regression against 00ff33e, or a weakened or unlisted test edit counted.

## UI critic (Opus): APPROVE

Scratch: `/tmp/wc-ui13-p05-scratch/r5/`.
- **Z1:** after a failed letter attempt, and after an interrupted one, Prepare again retries with that attempt's letter choice and runs a model turn, and the note clears.
- Y5 and Y7 still hold.
- The report's scale wording is corrected.
- **The sweep is clean:** axe finds no violations in six states, each in light and dark at 390 and 1280, and the lowest contrast is 6.76:1.
- **Polish (already carried to P06):** the combined line's mid-word cut.

## Reviewer (Opus): REVISE, 3 issues

Scratch:
- probes, including the new `validator-probe-r5.ts`, `-r5b.ts` and `-r5c.ts`: `/tmp/wc-rev-p05-r5-probes/`;
- logs, mutations and 00ff33e's validator: `-logs/`, `-mutations/` and `-base/`;
- patched copies that confirm each cause: `-cause-{a,b,c}/`.

The merge clone is at `095821f`.

**Done:**
- **Z1–Z4:** every round-4 failing input is refused, and every honest control in the decisions passes. The r2–r3d corpora are unchanged. Every changed verdict in r4, r4b and r4c is one a Z asked for.
- **Tests:** 19 removed lines, all listed, none weakened.
- **Mutations:** all 21 fail tests.
- **Chain and CI:** green, merged and unmerged (runner 1345, 161 gates). CI is green.

**Issues (regressions against 00ff33e):**
1. **Z3: after "was", a name followed by a role word used as a describing word is read as a title.** These honest sentences are now refused:
   - "The ledger redesign was a Northwind Labs executive priority [C1]." reads "northwind labs executive";
   - "…was the Ledgerkit developer preview…";
   - four more like them.
   The cause is `facts.ts:881`: the capitalised-phrase path accepts "was" through `inTitleContext` without `namesRole` and `wasIntroduces`.
2. **Z2: a bracket that joins the title drops any other title inside it.** Against a claim with "(Senior)", these pass:
   - "(Senior, then CTO)";
   - "(Senior; later Head of Platform)";
   - "(Senior, promoted to Director in 2021)".
   The cause is `facts.ts:984`, which filters every title inside the bracket, not only those in the joined parts.
3. **Z4(b): "scores of" after a determiner is no longer counted.** "Mentored the scores of engineers who joined … [C14].", and the same with "their", "our" or "these", passes. The cause is `facts.ts:156`, where `SCORE_DETERMINERS` makes "scores" a noun. The ruling exempts only a noun before "scores".

**Costs of the rulings (not counted):**
- **Z2:** against a claim with a bracket, the title cited without its bracket is refused.
- **Z2's splitter:** "(etc.) shipped" rides along.
- **Z3:** "I was the engineer on call", "My role was on-call lead" and "I was a developer advocate at Harbor" are refused, as "as" already did.
- **Z4(c):** a sentence repeating its own "today" claim is refused.
- **Z4(a):** all-caps "SALES REP." rides along.
- **Z4(b):** "Harbor's scores of new engineers" passes.

**Findings for P05.1 (00ff33e behaves the same):**
- Seniority after a title in other shapes: "Platform Engineer, Fernwood Labs (Staff)", "— Staff —", ", Staff,", "(promoted to Staff in 2020)" and "(Staff level on the payments team)".
- "Then was engineering manager overseeing payments …" passes.
- "I am engineering manager at Fernwood Labs [C9]." passes. This is a revision-3 regression against 1a0f854.
- "I was Harbor's platform engineer" passes.
- "Shipped the ledger redesign as a Northwind Labs executive priority [C1]." is refused.

## Decisions for revision 5 (Z5–Z8)

The same escalation does these.
- **Z5 (issue 1).** In the capitalised-phrase path, "was" introduces a title only through `wasIntroduces`, with `namesRole`, as in the lower-case path. So:
  - the six honest "was a Northwind Labs executive priority" sentences pass;
  - "I was a Payments engineer at …" is still read as a title.
- **Z6 (issue 2).** Only the titles inside the joined parts of a bracket are dropped. Any other title in the bracket is read and compared. The three probes are refused, and Z2's honest controls still pass.
- **Z7 (issue 3).** "scores of" after a determiner or a possessive pronoun ("the", "their", "our", "these", "its" and so on) counts as a quantity. Only a noun, or a word with "'s", before "scores" makes it a noun ("credit scores of", "onboarding scores of", "Harbor's scores of risk"). The probes are refused, and "the many scores of" too, while "credit scores of" and the other honest noun cases pass.
- **Z8 (a finding, taken now because it's the same path as Z5).** "I am" followed by a role phrase is a title context, under the same rules as "I was". So "I am engineering manager at Fernwood Labs [C9]." is refused, and "I am a Platform Engineer at …" passes against C9.
- **The corpus check, before you report.** Rerun every reviewer probe set, r2 to r5c (`/tmp/wc-rev-p05-r{2,3,4,5}-probes/`), at 451398e and at your head. List every verdict that changed. Each must be one a Z5–Z8 decision asks for. A change nobody asked for is a regression: fix it before you report.
- Draft-level tests, mutation proofs, the full chain after merging integration, CI green, and the list of edited assertions, as before.

**Round 6** is narrow, with the same reviewer only; the critic approved, and Z5–Z8 don't touch the page. Only these count:
- a Z5–Z8 item not done;
- a regression against 451398e;
- a weakened or unlisted test edit.

Everything else goes to P05.1, whose packet lists these findings.
