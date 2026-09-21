# Can the hosted pilot fit the operating budget?

Type: research
Label: wayfinder:research
Status: resolved
Assignee: orchestrator (Claude, 2026-09-20)
Blocked by: none
Parent: ../map.md
Context branch: research/workflow-runtime-budget
Asset: ../research/runtime-budget.md

## Question

What supported eve/Vercel deployment, scheduler, database, model billing, and usage limits can support a small private pilot within $25/month? Distinguish Codex subscription development usage from hosted runtime inference, including eve's ChatGPT model integration if documented. Establish constraints and measurable costing inputs from primary sources; do not promise that estimated use guarantees a billing ceiling.

## Comments

- 2026-09-20: the original research subagent died with the planning session (Codex usage limit). Re-run under the "guided local path first" decision (ticket 05), which moves inference onto each person's own subscription or key.

## Answer

Yes, with margin to spare: the hosted pilot costs **$0/month** on Vercel Hobby (noncommercial, no cron, no collaborators needed; over-limit pauses rather than bills), Neon's free Postgres via the Marketplace for invites, and GitHub Releases for package tarballs. Optional domain ~$1/month amortised; Chrome Web Store registration is a one-time fee (reported $5, unverified in the docs). Inference is not the owner's cost: $0 extra on a ChatGPT Plus subscription through eve's `chatgpt()`, or roughly $0.50–$9 per person per month on an API key depending on model. Full model, assumptions, and the honest risk list in [runtime-budget.md](../research/runtime-budget.md); eve platform facts in [eve-runtime.md](../research/eve-runtime.md).

Two findings change the build, not the budget: eve's `chatgpt()` sign-in is TUI-only and its behaviour under `eve start` (the only mode that fires cron) is undocumented, so packet P02 opens with a spike; and an unattended overnight build on the $20 Plus plan will hit the five-hour window, so the loop is packet-bounded and treats "usage limit reached" as pause-until-reset.
