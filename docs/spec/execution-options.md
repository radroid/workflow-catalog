# Execution options under discussion

Status: proposed; not a finalized architecture. Updated 2026-09-20 after the user introduced downloadable workflows.

## The choice

The reusable product is a workflow someone can adopt and own. Hosting its catalog, executing its instructions, storing a user's private career context, and controlling Chrome are separate responsibilities. A Vercel-hosted catalog can remain while execution and personal files move to each user's machine.

| Dimension | Hosted execution | Download into an existing harness | Guided local eve runner |
|---|---|---|---|
| Friend's first setup | Sign in and complete onboarding | Install bundle in an agent they already use | Install/configure a local application |
| Inference bill | Operator's API budget | User's supported subscription/API/provider | User's supported local subscription or API/provider |
| Runs while user's machine is off | Server prepares work; Chrome still waits | Only if their harness runs elsewhere | Only if user deploys runner to an always-on host |
| Personal context storage | Operator-managed private storage | User-owned local workspace | User-owned local workspace |
| Browser integration | Extension paired to service | Manual structured-file exchange initially | Extension plus local bridge |
| Reliability burden | Service operator | User and chosen harness | User plus our supported installer/adapter |
| Portability | Export must be built explicitly | Highest for text/data; execution varies | Provider choice inside eve; other harnesses need adapters |

## Recommended first experiment

For an audience already using coding agents, try a downloadable workflow with one supported harness before committing to a hosted execution service. For nontechnical friends, a hosted service may still deliver a better adoption experience despite model cost. A guided local installer is a separate engineering commitment, not a free shortcut.

Package reusable instructions as Agent Skills plus a manifest describing required capabilities, onboarding sources, artifact schemas, and workflow version. The standard supports portable instruction/script bundles across compatible clients; it does not standardize every client's scheduler, tools, permissions, or persistence. See [Agent Skills overview](https://agentskills.io/home) and [specification](https://agentskills.io/specification).

Keep user files separate from distributable templates:

```text
workflow-package/                 # shareable, versioned
  workflow.json                  # our manifest, not a claimed universal standard
  skills/                        # portable procedures
  schemas/                       # career profile, jobs, application session
  templates/                     # resume and career-profile formats
  fixtures/                      # fictional acceptance examples
  adapters/eve/                  # supported execution adapter
user-workspace/                  # private; never included in package export
  sources/
  career-profile.md
  career-profile.json
  jobs/
  applications/
```

The exact initial harness should follow the user's audience decision. Do not build multiple complete runtime adapters in the first overnight implementation.

## Browser portability without a companion daemon

A narrow first experiment can exchange files: the extension exports a captured job description; the harness reads it, completes onboarding and prepares documents; the harness outputs an application-session JSON file; the user imports it into the extension and opens the group. The extension can export completion events. This is a proposal, not implemented functionality.

The local workspace owns canonical application IDs/state. The extension stores a snapshot and exports idempotent completion events for explicit reconciliation. Importing a stale snapshot must never reset a completed task. Display when data was last exchanged. No automatic synchronization is implied.

This avoids pretending every harness can directly control Chrome. A local bridge or MCP tool can remove manual exchange later, after a real user proves it is the bottleneck. File import must still validate schemas, size limits, URL schemes, and permissible actions; importing a workflow must not execute arbitrary browser JavaScript.

## Onboarding remains mandatory

Download/install → check harness capabilities and credentials → explain private workspace → account for applicable source categories → extract candidate claims with sources → ask focused questions → resolve/exclude uncertain claims → user approves career profile → enable application generation.

Full career context means deliberate coverage of applicable experience, not mandatory access to every social platform. A user may state that a source is unavailable or not applicable; that status remains visible. This definition is proposed for review, not an excuse for a one-resume fast path that the user rejected.

## Cost and capability caveats

A small noncommercial catalog can target Vercel Hobby's $0 base tier, subject to its current limits. This does not make inference or each user's always-on hosting free. [Vercel pricing](https://vercel.com/pricing).

eve supports direct providers and documents local ChatGPT subscription access through `chatgpt()`; its docs explicitly exclude that path from deployments. Local eligibility/limits must be checked for the user's actual account, and no unlimited overnight usage is promised. [eve model configuration](https://github.com/vercel/eve/blob/main/docs/agent-config.md).

eve also documents self-hosted Node execution, persistent local workflow storage, and scheduling in the standard build/start path. Users must supply and operate the running host. [eve self-hosting](https://github.com/vercel/eve/blob/main/docs/guides/deployment/self-hosting.md).

Local storage does not imply that data never leaves the machine: selected material is sent to the configured remote model unless the chosen model itself runs locally. Surface this before the first inference call.

## Before implementation

Resolve [Should friends download workflows or run them on our service?](issues/05-portable-or-hosted-execution.md). The requested visual walkthrough, HTML teaching materials, and detailed implementation packets remain part of the destination. Their runtime-specific portions should follow this decision.
