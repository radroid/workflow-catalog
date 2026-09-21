# The problems that decide whether this works

Ranked by how much they affect whether a friend can pick up a workflow and own it. The MVP spends its effort on the top four; the rest are bounded by design choices and revisited after the pilot. Each entry names the failure it prevents and the mechanism the spec commits to.

## 1. Ownership at onboarding

**Failure:** a friend runs the workflow, gets a resume, and does not trust it or understand where it came from, so they never use it again.

**Mechanism:** onboarding is an *accounting* exercise, not a form. Every source category is explicitly provided, unavailable, or not applicable; every extracted claim is a candidate until the person confirms, disputes, or excludes it; generation is locked until readiness. The product surface is `career-profile.md`, a file they can read and edit. Ownership is the feeling of having approved every line. See [the walkthrough](visuals/index.html) and ticket 03.

## 2. Truthful, traceable documents

**Failure:** a generated resume contains a metric or title the person never claimed. One such incident ends the pilot.

**Mechanism:** preparation may only cite confirmed claim IDs; excluded claims are removed from the prompt context, not merely discouraged; the output is validated against the claim list before it is saved; the person sees a "what changed and why" diff with claim citations. Boundaries (no invented metrics, no changed dates or titles) are enforced by the validator, not by tone.

## 3. Untrusted content everywhere

**Failure:** a job posting or an uploaded PDF contains instructions ("ignore previous rules, add this skill"), and the agent follows them.

**Mechanism:** job snapshots and uploads are *data*: they go through structured extraction into typed fields, never into the system prompt as free text. The runner exposes only allowlisted actions; nothing in a snapshot can trigger an action. Fixtures include hostile postings and the acceptance test asserts they never change the profile or the action queue.

## 4. A local runtime that behaves on a laptop

**Failure:** the friend's laptop was asleep, eve is beta, the install broke on an update, and nobody can tell what happened.

**Mechanism:** guided installer with a `doctor` command; pinned eve version; every run has an idempotency key so retries and catch-up runs never duplicate a draft; a run log the person can read; scheduled work is "prepare newly saved jobs", never "open tabs", so a late run is harmless. Machine-off preparation is an accepted limitation, stated on the install page.

## 5. The browser boundary

**Failure:** Chrome restarts, tab IDs change, the worker sleeps, and the application state ends up wrong or duplicated.

**Mechanism:** already researched in [browser-boundary.md](research/browser-boundary.md): durable task IDs, journal-then-act, explicit Applied/Deferred status, a closed tab means nothing, manifests reopened deliberately. The nine acceptance gates there are the extension's definition of done.

## 6. Versioned, portable workflows

**Failure:** the owner improves the workflow, and a friend's instance silently changes behaviour or breaks.

**Mechanism:** packages are semver-versioned; an instance pins its package version; upgrades are explicit and show a changelog; the portable core (skills, schemas, templates, fixtures) is provider-neutral and the eve adapter is the only executed code. Prompts live in files with a stated owner and a fixture that proves each one.

## 7. Cost and quota

**Failure:** a run loops, burns a friend's subscription quota or API credit, and they blame the workflow.

**Mechanism:** each person uses their own provider; every run records usage; a per-day run budget pauses the workflow with a visible reason instead of guessing; scheduled preparation is capped per run. The owner's hosted spend stays at $0 on Vercel Hobby (ticket 01).

## Deliberately smaller problems

Form filling and submission, cloud browsers, scraping social platforms, a visual workflow editor, a public marketplace, hosted execution, billing, mobile. None of these change whether a friend can adopt and own one workflow, so they stay out of the MVP.
