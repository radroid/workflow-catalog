# Known limitations

Grouped by who notices first: the person running the pilot, or the owner
running the fleet. A one-line workaround follows where one exists.

## The person notices

### Machine-off: schedules only run while the runner runs

Daily-prepare (09:00 UTC) and weekly-review (Monday, 09:00 UTC) fire from
**the bridge's own clock**, not eve's cron — eve documents no catch-up for a
missed fire and no signal that a fire happened at all. A closed laptop, or a
stopped `npm run runner`, simply misses the fire. On the next start (and
every five minutes after), the runner checks whether a schedule's current
slot is overdue and, if so, claims and runs the **single latest** one once —
never a flood of replayed runs for every fire you missed. A parked
preparation (open gap questions) is not treated as a schedule failure: no
retry, no backoff, it just waits for you on the Applications page.
**Workaround:** none needed for correctness (nothing is lost or duplicated),
but if same-time delivery matters, leave the runner running near the
scheduled hour, or use the board/Applications page to prepare on demand.
Proof: `runner/README.md`'s "Schedules and catch-up" (P08-B) and
`docs/spec/research/eve-runtime.md` §4.

### MV3 service worker sleep and ephemeral tab IDs

Chrome stops the extension's service worker after about 30 s idle, a single
operation over 5 minutes, or a fetch response over 30 s. The side panel's
command poll and its 15-minute alarm re-arm on wake, never assume
persistence. Chrome's tab and tab-group IDs are unique only within a browser
session, so there is no transaction spanning tab creation and the runner's
own record — a crash between creating a tab and journaling its id can leave
a partial session. The runner never promises exactly-once tab opening;
instead it journals intent first and surfaces an unresolved partial session
for review, rather than silently retrying or guessing. **Workaround:** check
the Sessions page's "Needs your review" list if an opened group looks
incomplete. Proof: `docs/spec/research/browser-boundary.md`'s "Sleeping,
restart, and exactly-once limits", and the Sessions-page flagged-result
behaviour in `runner/README.md`'s "Extending the runner" (P06 row).

### The PDF's characters (carried from P05's round-2 review)

The PDF embeds Noto Sans, which covers Latin (with its extensions), Greek,
Cyrillic and Vietnamese. Complex scripts inside that coverage — Devanagari's
joined letter forms, for instance — were not checked. Anything outside the
font's coverage (CJK, Arabic, Hebrew, emoji) prints `�`, and the page warns
at the name field and beside the PDF. **Workaround:** download the Markdown
or Word file instead — both keep every character. Proof: the P10 packet's
"Carried into part A" note, and `runner/README.md`'s Applications-page
section.

### The preparation validator: 18 known gaps

The deterministic validator (`runner/validate/`) checks every prepared
sentence against the confirmed claims it cites. It has 18 known gaps,
carried from P05.1's review. Too-loose gaps are listed first — a passed
fabrication is a more expensive miss than a refused true sentence — each
with the example that trips it. There is no automatic workaround for a
too-loose gap; the check is reading "What changed and why" yourself. A
too-strict gap's workaround is usually rephrasing.

**Too loose — passes text the cited claim doesn't support:**

1. A possessive role phrase states an uncited title: *"Platform Engineer at
   Fernwood Labs, 2019–2021, and the platform team's manager [C9]."* passes
   though C9 never says "manager."
2. A domain-like word at a sentence's end is misread as an abbreviation, by
   part count alone: *"Won the hackathon run by x.com. Shipped the on-call
   rotation tooling used by three engineering teams [C3]."* passes.
3. A capitalized listed abbreviation ("Rd.", "Inc.") never ends a sentence —
   a deliberate trade that keeps "Mt. Hood"/"Ft. Worth" working, but also
   lets *"Worked from the office on Quill Rd. Shipped the on-call rotation
   tooling used by three engineering teams [C3]."* pass.
4. Seniority named right after a title, outside a bracket, isn't read as
   raising it: *"Platform Engineer, Fernwood Labs (Staff), 2019–2021 [C9]."*
   and three similar phrasings all pass.
5. No subject before "was" leaves the title-context rule with nothing to
   anchor on: *"Then was engineering manager overseeing payments at Fernwood
   Labs from 2019 to 2021 [C9]."* passes.
6. A possessive before a role noun after "was" isn't read as a title: *"I
   was Harbor's platform engineer from 2021 to 2023 [C10]."* passes though
   C10 states "Engineering manager."
7. An abbreviation inside a closing bracket only ends a sentence before a
   capital letter or citation, never before a lower-case word — needed for
   "(Sr.) at Fernwood Labs," but it also lets *"Won the hackathon, the demo
   day, the pitch night (etc.) shipped the on-call rotation tooling used by
   three engineering teams [C3]."* pass.
8. A possessive before "scores" is always read as a noun, regardless of
   what follows "of": *"Mentored Harbor's scores of new engineers joining
   its platform team [C14]."* passes.
9. A claim's joined bracket naming *someone else's* role is read as the
   subject's own title: *"Served as CTO at Fernwood Labs from 2019 to 2021
   [C11]."* passes, citing a claim whose bracket says "reporting to the
   CTO."

**Too strict — refuses text the cited claim does support:**

10. A present-tense verb in a revision is refused even as an ordinary verb,
    not an open-ended claim: *"Redesigned the ledger service so Northwind
    Labs' balances remain consistent [C1]."* is refused.
11. A sentence-opening word that can start a title is always read as one,
    even as a plain verb or noun-adjunct: *"Lead developer experience work
    for three engineering teams through the on-call rotation tooling
    [C3]."* is refused, along with three similar sentences.
12. The "as" analogue of the "was + Capitalized + role noun" title rule was
    never added: *"Shipped the ledger redesign as a Northwind Labs
    executive priority [C1]."* is refused.
13. A claim's own bracket, cited without it, is refused — the comparison is
    the whole title string, bracket included: *"Platform Engineer at
    Fernwood Labs, 2019–2021 [C13]."* is refused though C13 states
    "Platform Engineer (Senior) at Fernwood Labs, 2019–2021."
14. A sentence that repeats a cited claim's own present-tense wording
    verbatim is still refused as "still going on" — an accepted trade-off,
    not a new bug: *"Lead the Ledgerkit maintainers today [C16]."* is
    refused though C16 is that exact sentence.
15. A bracket naming someone *else's* role, cited beside the subject's own
    title, is refused as if it were the subject's — the flip side of
    too-loose item 9: *"Platform Engineer (Senior, reporting to the CTO) at
    Fernwood Labs, 2019–2021 [C12]."* is refused though C12 has no such
    bracket.
16. An adjective before "scores" no longer reads as a noun, so a true count
    is refused: *"Kept perfect scores of 100 on the Ledgerkit
    documentation's Lighthouse accessibility audits [C13]."* is refused —
    not a simple fix, since the same wording must stay a genuine count
    elsewhere ("top scores of engineers").
17. The same root cause as 16: every "the scores of" reads as a count,
    regardless of what follows: *"Kept the scores of each Lighthouse
    accessibility audit on the Ledgerkit documentation at 100 [C13]."* is
    refused.
18. The title-context rule can't tell "I am the engineer on call" from a
    genuine title claim: *"I am the engineer on call for the payments
    infrastructure team at Northwind Labs [C1]."* is refused.

Proof for all 18: `docs/spec/implementation/P05.1-validator-followups.md`,
"Known limitations for P10-A" (the same numbering order).

## The owner notices

### Chrome Web Store review

There is no Web Store listing yet, and this checklist doesn't wait for one:
registration is a one-time fee (Chrome's docs currently reference $5), and
review timing for a private/unlisted listing isn't something an overnight
build (or this pilot) can guarantee. **Workaround:** every install in this
pilot uses Developer Mode → **Load unpacked**, which needs no review and is
already the tested path. Proof: `docs/spec/research/browser-boundary.md`'s
"Distribution and verification".

### The `chatgpt()` unknowns, and mode A's four conditions

Mode A (`eve build && eve start`) is what the pilot runs on, decided by the
P02 spike. It holds only while four conditions do, each one the runner
enforces but none of which eve documents as a hard requirement:

- **An explicit, account-accepted model slug.** eve's own default
  (`gpt-5.6-luna-fast`) is rejected for a ChatGPT account; the accepted list
  the spike found (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`)
  came from an internal eve call, not a public one, and isn't guaranteed to
  stay the same. **Workaround:** `doctor -- --live` (or Status's "Check the
  model") is how you notice a drift, not this list.
- **`codex` on the runner's own `PATH`.** Without it, `chatgpt()` silently
  falls back to eve's own keychain entry (empty in this setup) and fails
  with a sign-in error, rather than a clear "Codex is missing" message at
  that point — setup's own check is what catches this earlier.
- **The extension builds before the agent** (`eve extension build`, then
  `eve build`). The launcher always does both in order; a hand-run `eve
  build` alone would skip the first.
- **Never alternate `eve start`/`eve dev` on one `.eve/` directory.** Each
  stamps a different internal world version, and switching quarantines the
  runs made under the other.

Beyond those four, two things remain genuinely untested: a machine with no
Codex installed at all (eve's own `/login` path, inside `eve dev`, was never
exercised by the spike — and mode A never runs `eve dev` in this repo
anyway), and whether `chatgpt()` keeps behaving the same way across a long
-running `eve start` process rather than the spike's few-minute session.
Proof: `docs/spec/research/eve-spike.md` ("Decision per spec §8" and "Risks
and surprises"), `docs/spec/mvp-spec.md` §8, and `runner/README.md`'s "Run
mode: A" section.
