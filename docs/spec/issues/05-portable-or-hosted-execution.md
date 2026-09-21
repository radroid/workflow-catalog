# Should friends download workflows or run them on our service?

Type: grilling
Label: wayfinder:grilling
Status: resolved
Assignee: orchestrator (Claude, 2026-09-20)
Blocked by: none
Parent: ../map.md

## Question

Which execution experience should the MVP support: portable downloads for existing agent users, a guided local runner, or centrally hosted execution? Decide the supported audience, first tested harness, browser bridge, and what happens when the user's machine is off. Keep provider choice distinct from harness interoperability.

## Comments

User steering: downloadable workflows and user-selected providers/harnesses are acceptable, potentially preferred to operating hosted inference, but user wants to discuss whether this is a better experience. This reopens the earlier hosted-only preference; it is not final authorization for a local-only pivot.

Proposed direction: a Vercel-hosted catalog with versioned portable workflow bundles; one tested local execution path initially, plus documented adapters. Keep eve as a supported runtime and use provider-independent instructions, profile/artifact schemas, and test fixtures as the reusable core. Do not promise universal execution compatibility.

Sources: [Agent Skills](https://agentskills.io/home), [eve model configuration](https://github.com/vercel/eve/blob/main/docs/agent-config.md), [eve self-hosting](https://github.com/vercel/eve/blob/main/docs/guides/deployment/self-hosting.md).

Decisions awaiting discussion:
- Are the first users comfortable installing into an existing agent, or do they need a guided application?
- Can scheduled work wait for their runner to be awake, or must they provision an always-on host?
- Is one fully tested harness acceptable initially, with other harnesses marked manual/experimental?

Invariants retained: full career-context onboarding before generation; five-person private pilot; browser capture/preparation/tab groups; manual application filling/submission; tweakcn Vercel visual theme; review/teaching artifacts and small implementation work packets.

- 2026-09-20 (owner, via the planning thread): "Would your first four friends be comfortable installing a workflow into an agent they already use and keeping it running for scheduled tasks?" → **Mixed — support a guided local path first.** Earlier in the same thread: downloadable workflows on any provider/harness are acceptable, "if hosted is a better experience I am open to exploring it."

## Answer

**Guided local path first.** The MVP is three parts, and only one of them is hosted:

1. **Catalog (hosted, Vercel Hobby, tweakcn Vercel theme).** An invite-only Next.js site that lists workflow templates, serves their versioned *workflow packages*, hosts the guided install page and the teaching docs, and shows each invited person's install status. It never stores career data, job captures, or generated documents. Owner's hosted spend target: $0/month (ceiling $25, see ticket 04).
2. **Local runner (the person's own machine).** An eve project installed by a guided installer (one `npx` command plus a terminal/local-web setup wizard), running the workflow instance against the person's **own model access**: their ChatGPT/Codex subscription through eve's `chatgpt()` provider where eligible, otherwise their own API key (OpenAI, Anthropic, or AI Gateway). The *workspace* (sources, career profile, jobs, applications, run history) lives in a local directory the person can open, back up, and delete.
3. **Chrome extension paired to the local runner.** Pairing is over loopback only (127.0.0.1, paired secret, Origin check) — the *bridge*. Manual `job-capture.json` / `application-session.json` import-export stays as the fallback and as the harness-agnostic path, so the extension is useful even without the runner.

**Audience rule.** "Mixed" means the guided installer is the *supported* path and gets the acceptance tests. Installing the package into an agent the friend already uses is *documented and exported* (the package is provider-neutral Agent Skills + schemas + templates + fixtures) but labelled experimental/manual. Exactly **one** executed runtime adapter in the MVP: eve.

**Machine-off behaviour.** Accepted limitation for the pilot: scheduled daily preparation runs only while the runner is up; missed schedules become a *catch-up run* on next start, deduplicated by idempotency key so nothing is drafted twice. No always-on host is provisioned or asked of friends. **Hosted execution is deferred**, not rejected: it returns as a fresh effort if the pilot shows friends want computer-off preparation more than they want to own their data locally.

**Provider vs harness.** Model choice is a runner setting. Harness interoperability is a *package* property (portable instructions, schemas, fixtures) and is not promised beyond eve.

**Why this and not hosted.** It makes the owner's $20 Codex subscription and each friend's own subscription the inference budget (the hosted design needed a separate API budget), it removes multi-tenant storage of resumes from the pilot's threat model, and it matches the audience: people who already run coding agents and are comfortable with a guided local install.

Assets: [Execution options](../execution-options.md), [Browser boundary research](../research/browser-boundary.md), [MVP spec](../mvp-spec.md).
