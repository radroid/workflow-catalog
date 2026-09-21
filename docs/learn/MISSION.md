# Mission: Reviewing agent-built code and keeping eve prompts honest

## Why
Raj is about to hand the workflow-catalog MVP to overnight coding agents, in packets, on a $20 Codex plan. The repo will outlive eve's beta. He needs to review each night's work in a short session without reading every line, and to change any prompt the runner uses and prove the change did what he meant, so the repo keeps improving instead of drifting.

## Success looks like
- In about twenty minutes, review one overnight packet: find what changed, run the checks, decide merge, push back, or revert, and write the decision down.
- Open the runner, locate every prompt it uses, change one, and prove the change with a fixture run before committing.
- Bump the pinned eve version, read the changelog against the runner's touch points, and know within an hour what broke and why.

## Constraints
- Short sessions, usually evenings; prefers doing over reading.
- Budget: the $20 ChatGPT/Codex subscription for building; hosted spend target $0.
- The reviewer is not the only author: agents write most of the code, so reviews must catch what agents typically get wrong (silent scope creep, weakened validators, untested prompt edits).

## Out of scope
- General TypeScript, Next.js, or Chrome-extension tutorials.
- eve internals beyond what the runner touches (`agent/`, skills, schedules, model config, deployment guard).
- Reviewing the friends' career data. Never in scope.
