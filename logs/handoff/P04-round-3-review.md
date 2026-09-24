# P04 (#14): round-3 review of head ffc4a0a (iter 006)

Revision 2 was done by the Opus escalation implementer, with T1–T21 from `logs/handoff/P04-round-2-review.md`. CI run 35968469459 is green, with Playwright 37/37.

## Reviewer (Opus): APPROVE

Scratch:
- `/tmp/wc-rev-p04-r3-probes/`: the queue, hostile and permissions probes, and the real-transport probe;
- `/tmp/wc-rev-p04-r3-mutations/`: `mutate.mjs`, the backups, the per-mutation logs, and the `node:dns` stub with its call log;
- `/tmp/wc-rev-p04-r3-work/`: the chain, flake, both-variables and merge logs, and the CI log.

**Fixed, all six round-2 issues:**
- **T1: fields.** A turn that calls `extract_job` and then fails keeps the old fields. Fields are saved only after the turn ends ok. The check never writes.
- **T2: stale state.** A stale `waiting` or `running` state, owned by another process or by no one, reads interrupted, and a retry completes.
- **T3: budget.** A provider limit on the first turn stops the second and third, which read "not run, budget paused".
- **T4: body errors.** Over the real TLS transport:
  - a slow drip, a stall or DNS that never answers gives `timeout`;
  - a reset or a short body gives `request_failed`;
  - an endless body gives `too_large`.
- **T5: one text rule.** Four Northwind whitespace variants on three paths give one hash.
- **T6: damaged data** is listed and named. A damaged extraction state reads interrupted, and a recapture lands in the same job.

**Fixed, all of the nits:**
- M6b for DNS names fails 5 of 92 tests.
- Timing tests have at least 4× headroom.
- T8's both-variables case passes 105/105 gates.
- Whitespace-only text gets 400 on paste and 422 `rejected` on the event path.
- Concurrent Re-extracts queue one turn.
- 20 addresses are blocked, and 14 neighbours allowed.

**Mutations:**
- M3a, M6b, M6b-ii and M8 all fail tests.
- Seven of the implementer's T21 proofs were spot-checked, and all fail tests.
- **M7 is proven without real DNS:** a vitest setup stubs `node:dns`, and with the pin removed, 5 of 92 tests fail.

**Regressions: none.**
- Queue concurrency, write failures, snapshots damaged mid-turn, shutdown and restart, and the hostile posting all hold.
- **Flakiness: none.** Six runs all passed 830 runner tests and 105/105 gates. The implementer's silent gate exit didn't reproduce.

**Scope, chain, merge and CI:**
- Scope is clean.
- The chain at the head is green.
- The merge onto 4beaf42 is green: 852 tests and 105/105 gates.
- CI 35968469459: Playwright 37/37.

**Nits** (beyond T6's file-level wording):
- A Re-extract whose waiting-state write fails, for example when `extraction-1.json` is a directory, gives a generic 500.
- A job directory that can't be read (chmod 000) drops out of the list, and its detail says 404.

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
