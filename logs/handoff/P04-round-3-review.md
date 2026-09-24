# P04 (#14): round-3 review of head ffc4a0a (iter 006)

Revision 2 was done by the Opus escalation implementer, with T1–T21 from `logs/handoff/P04-round-2-review.md`. CI run 35968469459 is green, with Playwright 37/37.

## Reviewer (Opus): pending

## UI critic (Opus): APPROVE

Scratch: `/tmp/wc-ui10-p04-scratch/r3/`. It holds `stage-*.txt`, `committed.txt`, `shots/`, `sheets/` and `crops/`. The fake model is scripted by `r3/turn.json`.

**Fixed, all of round 2:**
- **2:** "Extracting “X”…" shows within 60 ms and replaces the old line. The result is announced once.
- **4a: refresh.**
  - It runs every 2 s while a job is active, and every 5 s otherwise. It stops while the page is hidden.
  - Extension captures are listed within 4.3 s, with no announcement.
- **4b: wording.** The no-model text is right. A paused budget or a rate limit links to Settings' Budget section.
- **6:** the size check uses the contract's JSON measure.
- **Field errors** (J4 and J6.3).
- **Borders:** 7.81:1 light and 7.99:1 dark; the invalid border wins.
- **Refresh keeps state:** open diffs and the full text stay open, and scroll position is kept.
- **The posting-text region** is focusable and labelled; axe is clean.
- **Line messages:** at most 87 characters, with no sliver of a third line.
- **The screenshots:** all 41 are at true widths, with the pinned line at the top.
- **All of T19's polish.**
- **The new states:** running, paused and unreadable.

**Polish, not counted:**
- **P1.** If a job's only file becomes unreadable while focus is on its Re-extract button, the old "What the runner found" section stays under the new message, even after focus leaves. The fix: move focus to the heading, then drop the section.
- **P2.** When two extractions the page started finish in the same refresh, the first message is replaced before it's ever shown. A combined line would fix it.
- **P3.** The 80-character name cap cuts mid-word ("Staff Platform Engin…"). Cut at a word instead.
- **P4.** A job whose latest file is damaged is listed by its URL path, per T6, but its detail heading uses the title. The "(latest revision)" toggle label then shows revision 1.
- **Out of the Jobs page's scope:** the shared secondary button's border (`#detail-retry`) is 1.27:1, from `runner.css`.
