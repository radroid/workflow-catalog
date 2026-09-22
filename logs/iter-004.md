# iter 004 — P03 ∥ P07-B ∥ P09.1 ∥ P02.1

Date: 2026-09-22 · Phase 2 · Wave plan iteration 4. P04 waits for P03, so P02.1 and P09.1 were pulled forward.

## What ran
- **P02.1** (Sonnet, PR #9):
  - HEAD `/ui/login` no longer spends the sign-in link.
  - A new test covers an error inside the `/pair` queue. Both come with mutation proofs.
  - Round 1: REVISE (1). The HEAD answer lacked CSP and CORP.
  - Round 2: APPROVE. Merged d9454f2.
- **P09.1** (Sonnet, PR #10):
  - Install commands follow `runner/README.md`, with a drift test.
  - The checksum fetch stops at 4 KB.
  - A refusal-nonce test and the UI notes.
  - Round 1: reviewer REVISE (3). Next's fetch tees the body, so the cap never stopped the download. UI critic REVISE (7).
  - Round 2: reviewer REVISE (3). Errors were cached for an hour. UI critic REVISE (1): a non-policy name appeared in the screenshots. An Opus implementer took over.
  - Round 3: both APPROVE. Merged 61f0e2d.
- **P03** (Sonnet, PR #11): profile store and reducer, the extraction and follow-up tools, the eval, and the Onboarding and Profile pages.
  - Reviewer REVISE (11): reused approval versions, silent approved-content changes, `ok` on failed turns, an eval that ran copies of the tools, and no `career-profile.md`.
  - UI critic REVISE (10). Revision 1 is running.
- **P07-B** (Sonnet, PR #12): real pairing, `/status` states, a `job_capture` outbox with alarm retry, and a CI extension step.
  - Reviewer REVISE (6): the tests need port 4310, a flush race drops captures, and there is no timeout.
  - UI critic REVISE (10). Revision 1 is running.

## Orchestrator decisions (blocks.md)
- **P03, D1–D7:**
  - Owns additions are approved.
  - `route-modules.test.ts` becomes readdir-based, so later route packets never edit it.
  - TXT/MD upload, reasons and preferences land now. PDF/DOCX, archives, URL import and the GitHub token move to the new **P03.1**, which runs after P03 and P04.
  - Deferring HITL is accepted, and contracts stay untouched.
- **P04 packet:** owns the shared safe-fetch and readable-text. Its URL route refuses loopback and private addresses after DNS and on every redirect, and it handles `job_capture`.
- **P07-B, E1–E4:** the file export is a fallback, an unpaired capture is queued, the label names `npm run pair`, and quitting Chrome unpairs.
- **eve:** `eve-runtime.md` §8 item 14 now says directives compile per app root. The reviewer's probes proved it.

## Incidents
- A provider session limit (429) at about 09:20 stopped three implementers. The owner re-kicked at 09:52, and all three resumed with SendMessage, context intact.
- The reviewer's and UI critic's harnesses collided on port 4310. That exposed P07-B issue B1: its suite needs 4310 free.

## Smoke test (integrated branch 5e5c8d5)
All exit 0:
- `pnpm install --frozen-lockfile` and `pnpm typecheck`.
- `pnpm test`: contracts 235, job-assistant 151, extension 130 (+2 that need a build), runner 155 plus eval 4/4 (20 gates), catalog 168, scripts 2.
- `pnpm -r lint` and `pnpm check:fixtures`. The tree is clean afterwards.

## PRs
#9 and #10 merged. #11 and #12 are in revision. #2 updated.

## Blocks
Owner-gated: the catalog deploy, the first release tag, and the tag-push deny rule. Nothing blocks iter-005. New backlog item: GOALS P2.G, which is P03.1.
