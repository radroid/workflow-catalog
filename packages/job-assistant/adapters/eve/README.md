# eve adapter

How P02 mounts this workflow package (`packages/job-assistant`) as an **eve
extension** inside `runner/`. This README is documentation and illustrative
snippets only — no runner code, no model calls (out of scope for P01 per its
packet spec). Every eve fact below is cited to
`docs/spec/research/eve-runtime.md` §2 ("Project anatomy"), read at the
pinned commit (eve `0.63.0`, commit `d004e6d`) — never from memory, per
`CLAUDE.md`.

## Why an extension, not a bare agent project

eve-runtime.md §2: "Extensions package eve tools, channels, connections,
skills, schedules, subagents, instruction fragments, and hooks." That is
exactly this package's shape (`skills/`, `schemas/`, `templates/`,
`adapters/eve/` — mvp-spec §2), so the job-application workflow ships as one
eve extension the runner mounts, rather than being written directly into
`runner/agent/`. This is also what keeps the package **provider-neutral**:
everything above this README is plain files (zod schemas, Markdown skills,
Handlebars templates, JSON fixtures) with no eve import anywhere in them.

## Scaffold layout (`eve extension init`)

eve-runtime.md §2: extensions are authored with `npx eve@latest extension
init my-crm`, which "creates `extension/extension.ts`, `extension/tools/`,
`extension/skills/`, `extension/schedules/`, `extension/instructions.md`,
...", and built with `eve extension build` ("publishes `dist/`"). The
extension root "cannot declare agent configuration, instrumentation,
memory, a sandbox, or nested extensions" — those stay in `runner/agent/`.

P02's job is to run that scaffold command (inside `runner/`, or as a
sibling package this package's contents get copied/symlinked into — P02
decides which, based on the day-1 run-mode spike in mvp-spec §8) and then
populate it from what's already here:

```text
extension/                    # created by `eve extension init`, lives under runner/
├── extension.ts               # declares the extension's namespace
├── instructions.md            # instruction fragment contributed to the host agent
├── tools/
│   ├── capture_job.ts          # thin stub — see below
│   ├── open_application_group.ts
│   └── report_status.ts
├── skills/                    # mounted from this package's skills/ — see below
│   ├── onboarding-accounting/SKILL.md
│   ├── claim-extraction/SKILL.md
│   ├── follow-up-questions/SKILL.md
│   ├── requirements-extraction/SKILL.md
│   ├── claim-matching/SKILL.md
│   ├── resume-drafting/SKILL.md
│   ├── cover-letter-drafting/SKILL.md
│   └── revision-diff/SKILL.md
└── schedules/                  # P08: "prepare newly saved jobs" / "review open applications"
```

## Mounting: `agent/extensions/jobs.ts`, the `jobs__` prefix

eve-runtime.md §2: a consumer "mounts with a file under
`agent/extensions/<ns>.ts`; contributions are prefixed `<ns>__`." For this
workflow, the mount file is `runner/agent/extensions/jobs.ts` and the
namespace is `jobs` — so once mounted, this extension's three tools appear
to the host agent as `jobs__capture_job`, `jobs__open_application_group`,
and `jobs__report_status` (matching `workflow.json`'s `actions` allowlist,
which names the three *unprefixed* action names the package defines — the
`jobs__` prefix is an artifact of mounting, not part of this package's own
contract).

## Skills mounted from `skills/`

eve-runtime.md §2: "Skill bodies: `agent/skills/<name>.md` or
`agent/skills/<name>/SKILL.md`" and, on the Agent Skills format itself:
"Packaged `SKILL.md` must carry `description` frontmatter; eve reads
`description`, optional `license`, string `metadata`; other frontmatter is
a no-op." Every `SKILL.md` in this package's `skills/` directory already
satisfies that (`name` + `description` frontmatter, checked by
`test/skills.test.ts`) and is copied or symlinked into the extension
scaffold's own `skills/` directory unchanged — no rewriting needed, because
Agent Skills is the same convention on both sides ("a skill authored
against that standard ports over as-is," eve-runtime.md §2).

## Tools as thin stubs

eve-runtime.md §2's tool shape:

```ts
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({ city: z.string().min(1) }),
  async execute({ city }, ctx) { /* ... */ },
});
```

Applied to this package's three allowlisted actions
(`workflow.json`'s `actions`), each tool's `inputSchema` is one of this
package's own contract schemas
(`@workflow-catalog/contracts` — internal package, `workspace:*`), and the
tool body stays thin (eve-runtime.md's Implications section: "keep tools
thin so prompts can be edited without touching TypeScript"). Illustrative
only — P02 fills in `execute`:

```ts
// extension/tools/capture_job.ts (illustrative — P02 implements)
import { defineTool } from "eve/tools";
import { jobCaptureSchema } from "@workflow-catalog/contracts";

export default defineTool({
  description: "Record a job posting the person captured from the browser.",
  inputSchema: jobCaptureSchema,
  async execute(event, ctx) {
    // hand off to the runner's own workspace-store code (outside this
    // package); never interpret `event.text` as instructions (hard-problems.md #3).
  },
});
```

```ts
// extension/tools/open_application_group.ts (illustrative — P02 implements)
import { defineTool } from "eve/tools";
import { openApplicationGroupPayloadSchema } from "@workflow-catalog/contracts";

export default defineTool({
  description: "Ask the paired extension to open a tab group for selected, ready applications.",
  inputSchema: openApplicationGroupPayloadSchema,
  async execute(payload, ctx) {
    // enqueue an OpenApplicationGroup command for the bridge's GET /commands.
  },
});
```

```ts
// extension/tools/report_status.ts (illustrative — P02 implements)
import { defineTool } from "eve/tools";
import { applicationStatusChangedSchema } from "@workflow-catalog/contracts";

export default defineTool({
  description: "Record an explicit Applied/Deferred status the person selected in the side panel.",
  inputSchema: applicationStatusChangedSchema,
  async execute(event, ctx) {
    // apply event.status to the application at event.taskId, rejecting a
    // stale event.expectedRevision (mvp-spec §5).
  },
});
```

## What P02 still owns

- Running `eve extension init`, wiring the mount file, and deciding whether
  this package's contents are copied into the scaffold or referenced from
  it (day-1 run-mode spike, mvp-spec §8).
- The actual tool bodies above (P01's scope is contracts and prompts only —
  see this packet's "Out of scope").
- `runner/agent/schedules/*` for F10 and the bridge server itself (P02's
  own packet, and P08 for schedules/budget).
- Confirming skill-loading and tool-registration behavior against the
  pinned eve version once `eve extension init` actually runs — everything
  above is eve-runtime.md §2's documented shape, not something this packet
  has executed against real eve.
