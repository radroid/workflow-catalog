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
namespace is `jobs` — so if all three are mounted as eve tools, they are
namespaced as `jobs__capture_job`, `jobs__open_application_group`, and
`jobs__report_status` (matching `workflow.json`'s `actions` allowlist,
which names the three *unprefixed* action names the package defines — the
`jobs__` prefix is an artifact of mounting, not part of this package's own
contract). Namespacing is not the same question as agent-callability,
though: per "not model-callable" below, P02 must ensure
`jobs__capture_job` and `jobs__report_status` are never offered to the
agent's own tool-choice — mounted for the runner's internal plumbing, or
wired as plain event handlers outside the tool-choice loop entirely, but
either way not a function call the model can decide to make. Only
`jobs__open_application_group` belongs in the agent-visible toolset.

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

`workflow.json`'s three allowlisted `actions` are an allowlist of
interaction *types* this workflow package participates in — not a promise
that all three are model-invoked eve tools in the same sense. Only
`open_application_group` is genuinely something the agent decides to call:
it opens browser tabs, a real, person-visible side effect. `capture_job`
and `report_status` both record something the *person* already did in the
browser (captured a posting; clicked Applied/Deferred) — see "not
model-callable" below for why modelling either as an agent-invoked tool
would be backwards.

eve-runtime.md §2's Implications section: "keep tools thin so prompts can
be edited without touching TypeScript." Illustrative only — P02 fills in
`execute` and confirms the actual mounting shape against the pinned eve
API.

### `open_application_group` — the one model-callable, side-effecting tool (P01 revision decision (d))

The only tool of the three the agent actually decides to call, and the
only one with a real, person-visible side effect — so it is the only one
needing eve's approval gate, and needs the strictest setting:
`approval: always()`, every single invocation, never `once()` or
`auto()`. eve-runtime.md §2: `approval` accepts
`always() | once() | never() | auto()`, imported from `eve/tools/approval`;
omitted defaults to `never()` — an omission here would be a mistake, not a
neutral default.

Its input is deliberately narrower than the wire envelope
(`OpenApplicationGroupPayload`, `bridge-envelopes.ts`, which carries
`items[].url`): the model supplies **task IDs only, never a URL**.
`execute` resolves each task ID to its stored `JobSnapshot.url`
server-side, from data the runner itself already captured and validated —
never from a URL the model supplies. A hostile posting can poison a
claim, a requirement, or (P01 revision issue 6) a
`structured.requirements[]` entry with an injected instruction, but it
cannot make this tool navigate anywhere: there is no field in its input
schema a hostile string could occupy to become a URL.

```ts
// extension/tools/open_application_group.ts (illustrative — P02 implements)
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval"; // path per docs/spec/research/eve-runtime.md §2 (Tools); P02 confirms it against eve@0.63.0
import { z } from "zod";
import { uuidSchema } from "@workflow-catalog/contracts";

// Deliberately narrower than OpenApplicationGroupPayload (bridge-envelopes.ts):
// task IDs only, never a URL. See prose above.
const openApplicationGroupInputSchema = z.object({
  title: z.string().min(1),
  taskIds: z.array(uuidSchema).min(1),
});

export default defineTool({
  description: "Ask the paired extension to open a tab group for selected, ready applications.",
  inputSchema: openApplicationGroupInputSchema,
  approval: always(),
  async execute({ title, taskIds }, ctx) {
    // Resolve each task ID's JobSnapshot.url from the workspace store
    // (outside this package) — never from a model-supplied URL — then
    // build and enqueue the real OpenApplicationGroupPayload (with the
    // resolved items[].url) for the bridge's GET /commands.
  },
});
```

### `capture_job` and `report_status` — not model-callable (P01 revision decision (d))

Both record something the *person* already did in the browser; the agent
never decides to call either. `report_status` is the sharper case: it
exists solely so the extension can `POST /events` an
`ApplicationStatusChanged` the instant the person clicks Applied or
Deferred in the side panel, and nothing about that path should ever
involve the agent — a compromised or confused agent turn must not be able
to mark an application Applied that the person never touched.
`capture_job` is the same shape one step earlier: the person's own
capture click in the extension already happened before a `JobCapture`
event exists at all.

If P02 mounts these as eve tools for architectural uniformity with the
runner's event-handling plumbing, they get **no `approval` the model could
satisfy** — the correct shape is that no agent turn ever proposes calling
them, wired instead directly from the bridge's `POST /events` handler to
the workspace-store write:

```ts
// extension/tools/report_status.ts (illustrative — P02 implements; NOT
// exposed to the agent's own tool-choice loop — see prose above)
import { defineTool } from "eve/tools";
import { applicationStatusChangedSchema } from "@workflow-catalog/contracts";

export default defineTool({
  description: "Apply an explicit Applied/Deferred status the person selected in the side panel. Not called by the agent — invoked directly from the bridge's POST /events handler.",
  inputSchema: applicationStatusChangedSchema,
  async execute(event, ctx) {
    // apply event.status to the application at event.taskId, rejecting a
    // stale event.expectedRevision (mvp-spec §5).
  },
});
```

```ts
// extension/tools/capture_job.ts (illustrative — P02 implements; same
// not-agent-invoked shape as report_status — see prose above)
import { defineTool } from "eve/tools";
import { jobCaptureSchema } from "@workflow-catalog/contracts";

export default defineTool({
  description: "Record a job posting the person captured from the browser. Not called by the agent — invoked directly from the bridge's POST /events handler.",
  inputSchema: jobCaptureSchema,
  async execute(event, ctx) {
    // hand off to the runner's own workspace-store code (outside this
    // package); never interpret `event.text` as instructions (hard-problems.md #3).
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
- Enforcing the approval/callability split this README documents:
  `approval: always()` actually gating every `open_application_group`
  call against the pinned eve version's real approval mechanism, and
  `capture_job`/`report_status` actually being unreachable from the
  agent's tool-choice loop, not merely undocumented as callable.
