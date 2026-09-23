# iter 005 — P08-A, and P03 and P07-B finished

Dates: 2026-09-22 to 2026-09-23 · Phase 2/3 · Wave plan iteration 5. P05 waits for P04, which waits for P03, so this iteration finished the open PRs and ran P08-A.

## What ran
- **P08-A** (PR #13, run log and budget pause): merged 360ac69.
  - Round 1: REVISE 5, UI REVISE 9. The Sonnet implementer's revision 1 followed decisions G1–G10.
  - Round 2: REVISE 2. `session.waiting` was read as "parked", so every normal run failed, and the code could reject before the body. UI REVISE 3.
  - A fresh Opus escalation followed I1–I4. Round 3: both APPROVE.
- **P03** (PR #11, onboarding and career profile): merged 9821bee.
  - Round 2: REVISE 6, UI REVISE 9. An Opus escalation followed D8–D16.
  - Round 3: REVISE 1 (`turn.cancelled` counted as a success), UI REVISE 3. Revision 3 followed J1–J8.
  - Round 4: both APPROVE.
- **P07-B** (PR #12, extension pairing and capture): merged e01017c.
  - An Opus escalation took over from revision 1.
  - Round 3: REVISE 1 (README), UI REVISE 5. Revision 3 followed H1–H4.
  - Round 4: APPROVE, UI REVISE 1 (a refused pairing announced 2–3 times). Revision 4 followed K1–K4.
  - Round 5: both APPROVE.
- Each round's full findings are in `logs/handoff/<packet>-round-N-review.md`.

## Orchestrator decisions (blocks.md)
- **eve item 15** (`eve-runtime.md` §8; none of it is in eve's docs):
  - An aborted turn can end quietly as `completed`.
  - `session.waiting` is the normal end of a turn; `turn.cancelled` is not ok.
  - A turn response follows silence without limit.
  - An `authorization.required` without a `webhookUrl` can read as ok.
- **The P04 URL rule:** captured and pasted URLs follow the contract (http or https). Only the fetch path is https-only, with the SSRF rules. This keeps P07-B's e2e valid; no validator was weakened.
- **Follow-ups:**
  - P08-A's go to P08-B ("Carried into part B").
  - P07-B's go to P07-C ("Carried into part C").
  - P03's, plus one turn classifier for P03's extraction and P02's `checkModel`, go to the new **P03.2**, after P04.
- **Review rounds after the usage limits are narrow:** they check only what changed.

## Incidents
- The owner paused the loop on 9/22 at about 13:05. It resumed at 14:26.
- A session limit hit at about 14:45, then a weekly limit at about 17:05, stopping every agent. The re-kick came at 16:04 on 9/23, and every agent resumed with its context.
- One UI critic opened the orchestrator's roster and code-word file in /tmp while looking for its scratch. It used nothing. The files moved to a private folder, and prompts now limit agents to the /tmp paths they name.

## Smoke test (integrated branch e01017c)
All exit 0:
- `pnpm install --frozen-lockfile` and `pnpm typecheck`.
- `pnpm test`: contracts 235, job-assistant 151, runner 561 plus eval 5/5 (85 gates), catalog 168, extension 329 (+5 that need a build), scripts 2.
- `pnpm -r lint` and `pnpm check:fixtures`. The tree is clean.
- CI on e01017c, which includes the extension e2e, is checked at the next wake-up.

## PRs and blocks
#11, #12 and #13 merged; #2 updated. Owner-gated: the catalog deploy, the first release tag, and the tag-push deny rule. Nothing blocks iter 006.

Next: P04 (Sonnet; prompt in `logs/handoff/P04-prompt.md`). Then P05 (Opus) ∥ P03.2 (Sonnet), then P03.1, then P08-B. P06 follows P05.
