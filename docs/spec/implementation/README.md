# Implementation packets (the backlog)

Bounded work packets for the MVP in [../mvp-spec.md](../mvp-spec.md). Each packet is one agent session's work: it names the paths it owns, the acceptance tests it must make pass, and the report it must leave behind. The owner spawns sessions against packets. Two overnight prompts exist: [OVERNIGHT-PROMPT.md](OVERNIGHT-PROMPT.md) for a single agent walking the packets in order, and [OVERNIGHT-OPUS-PROMPT.md](OVERNIGHT-OPUS-PROMPT.md) for an Opus orchestrator running up to seven subagents in waves through the fleet's autonomous-build-loop.

## Rules every session follows

1. **Claim before work.** Set `Status: claimed` and `Assignee:` in the packet file and commit that change first. `Status` values: `open` → `claimed` → `done` (or `blocked` with a reason).
2. **Stay inside `Owns:`.** Touch other paths only when a listed acceptance test needs it, and say so in the report. Scope creep is reverted at review (see `docs/learn`, lesson 0001).
3. **Fictional fixtures only.** No real names, employers, postings, or documents in the repo. Hostile fixtures are mandatory where the packet says so.
4. **Never weaken a validator or schema to pass a test.** Fix the fixture or report the conflict.
5. **One packet, one iteration, one commit series.** Commit at every green step; the loop may be interrupted by a provider usage limit at any time. On "usage limit reached": commit what is green, write the report with `Status: claimed (paused)`, and stop.
6. **Report format** (append to the packet under `## Report`, newest first): date, what was done, tests run with their real output summary, what was skipped and why, assumptions made, and the one thing to sharpen in this packet next time.
7. **Prompts are plain files** under `runner/agent/` and `packages/job-assistant/skills/`; every prompt change ships with the fixture that proves it.
8. **Nothing merges to `main` unattended.** Packets land as pull requests; the owner reviews with the twenty-minute loop.

## Order and parallelism

| Packet | Blocked by | Can run alongside |
|---|---|---|
| [P00 scaffold and loop](P00-scaffold-and-loop.md) | — | — |
| [P01 workflow package and contracts](P01-workflow-package-and-contracts.md) | P00 | P09 |
| [P01.1 contracts follow-ups](P01.1-contracts-followups.md) | P01 | P02, P07, P09 (must land before P03) |
| [P02 runner spike and skeleton](P02-runner-spike-and-skeleton.md) | P01 | P09 |
| [P03 onboarding and career profile](P03-onboarding-and-career-profile.md) | P02 | P09, P07 (pairing part) |
| [P04 job capture](P04-job-capture.md) | P03 | P09 |
| [P05 preparation and validator](P05-preparation-and-validator.md) | P04 | P09 |
| [P06 board and sessions](P06-board-and-sessions.md) | P05 | P09 |
| [P07 extension](P07-extension.md) | P02 (pairing), P06 (manifests) | P08, P09 |
| [P08 schedules, runs, budget](P08-schedules-runs-budget.md) | P05 | P07, P09 |
| [P09 catalog site](P09-catalog-site.md) | P00, P01 | everything from P02 on |
| [P10 versioning and pilot readiness](P10-versioning-and-pilot-readiness.md) | all | — |

## Definition of done for the MVP

The success test in spec §10, the nine browser gates, the hostile fixtures, the catalog live on Hobby at $0, and `docs/learn` reachable from the catalog.
