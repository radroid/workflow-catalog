# A shared workflow becomes a friend's browser to-do list

Label: wayfinder:map
Status: charted; build handoff ready. One HITL ticket stays open (the onboarding walkthrough reaction) and does not block the build.
Tracker: local Markdown; child decisions live in `issues/`.

## Destination

A reviewed, implementation-ready MVP specification and bounded agent work packets for a workflow-sharing platform: an invite-only **catalog** hosted on Vercel in the tweakcn Vercel theme, a **guided local runner** on eve that each person installs and runs with their own model access, and a Chrome extension that turns prepared applications into a browser tab group. A friend adopts the job-application workflow, accounts for their sources, approves an evidence-backed career profile, prepares a resume, and opens an application tab group in their own Chrome. Alongside: the visual walkthrough, the cost model, the teaching workspace for reviewing the repo and maintaining eve prompts, and one overnight-agent prompt.

## Notes

- Confirmed by the owner: $25/month hosted ceiling (USD before tax, target $0) excluding an existing $20 Codex subscription; Vercel hosting and tweakcn's Vercel theme; browser task groups; reusable skills and scripts; onboarding is central; five people, personal/noncommercial; full career context before generation; capture/prepare/open tabs first with manual submission; **guided local path first** (friends are mixed on installing into an existing harness).
- This is a planning effort inside mission-control. The build itself is a fleet spawn: the intake brief is at `intake/inbox/workflow-catalog.md` and `bin/spawn-app.md` takes it from there after the owner kicks it. Do not start an implementation loop from this map.
- Skills: `/wayfinder`, `/domain-modeling`, `/grilling`, `/research`, `/prototype`, `/teach`, frontend-design. Keep decisions distinct from implementation tickets.
- Local tracker semantics follow `issue-tracker-local.md` from the owner's `setup-matt-pocock-skills` skill (a local file, not in this repo).
- Human decisions and prototype feedback stay visibly open until the owner answers; proposed defaults are not approvals. Every proposed default is labelled as such in its ticket.
- Currency: costs are modelled in USD before tax. Nothing paid is provisioned until the owner confirms the currency reading.

## Decisions so far

- [What can the workflow reliably do in a friend's browser?](issues/02-browser-execution-boundary.md) — packaged capture and tab-group actions, durable task IDs, explicit Applied/Deferred status, journal-then-act; loopback or native-messaging bridge rules; manual file exchange stays as the harness-agnostic fallback.
- [Should friends download workflows or run them on our service?](issues/05-portable-or-hosted-execution.md) — guided local path first: hosted catalog + local eve runner on the person's own provider + extension paired over loopback; one executed runtime adapter; hosted execution deferred, not rejected.
- [Which limits make the first build small and complete?](issues/04-pilot-scope-and-handoff.md) — five-person noncommercial pilot; USD-before-tax ceiling with a $0 hosted target; capture/prepare/open/explicit-status browser scope; upload, paste, URL and GitHub connections; the success test is the definition of complete.
- [Can the hosted pilot fit the operating budget?](issues/01-hosted-runtime-and-budget.md) — yes: $0/month hosted on Vercel Hobby + Neon free + GitHub Releases; inference is each person's own subscription or key ($0 extra on ChatGPT Plus via `chatgpt()`, ~$0.50–$9/month on an API key); `chatgpt()` under `eve start` is a day-one spike; the overnight loop must be packet-bounded because Plus limits will interrupt it.
- [How does a friend make a workflow their own?](issues/03-first-result-onboarding.md) — proposed default recorded (sources accounting, claim states, readiness lock, editable profile); walkthrough built; **owner reaction pending**.

## Not yet specified

- Nothing that blocks the build. Post-pilot fog, in scope for a later map only if the pilot demands it: hardening the loopback bridge into a native-messaging companion; catalog-side telemetry that respects the "no personal data hosted" rule; a second workflow template to prove the package format generalises.

## Out of scope

- Public marketplace, billing customers, arbitrary third-party executable code, automatic form filling or submission, scraping every social platform, mobile.
- Hosted execution and always-on host provisioning (deferred by ticket 05; returns as a fresh effort, not a resumption).
- Universal harness support: the package is portable, the runtime adapter is eve only.
- Production deployment, account provisioning, and running the build in this planning effort.
