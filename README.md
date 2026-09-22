# workflow-catalog

An invite-only catalog that shares reusable agent workflow templates for a
five-person, noncommercial pilot. The first template is a job-application
assistant. Execution is never hosted: each person installs a versioned
workflow package from the catalog into a local runner on their own machine,
with their own model access. The catalog itself holds invites, template
pages, package links, the install guide, and the learning docs — never any
personal data.

Full contracts and rationale: [`ARCHITECTURE.md`](ARCHITECTURE.md) (the
canonical index) and [`docs/spec/mvp-spec.md`](docs/spec/mvp-spec.md) (the
full spec). Teaching workspace: [`docs/learn/`](docs/learn/).

## The parts

This is a pnpm workspace with four runtime parts plus a shared contracts
package:

| Part | Path | What it is | Run it today |
|---|---|---|---|
| Catalog | `apps/catalog/` | Next.js site on Vercel Hobby: invites, template pages, install guide, `docs/learn` | `pnpm --filter catalog dev` (serves on port 3000) |
| Runner | `runner/` | Local eve project the person installs; bridge server on `127.0.0.1:4310` | `cd runner && npm run setup`, then `npm run runner` (see `runner/README.md`) |
| Extension | `extension/` | Chrome MV3 extension: capture, side panel, tab groups | `pnpm --filter @workflow-catalog/extension build`, then load `extension/dist` unpacked (see `extension/README.md`) |
| Workflow package | `packages/job-assistant/` | `workflow.json`, skills, schemas, templates, fixtures for the job-application assistant | `pnpm --filter @workflow-catalog/job-assistant test` |
| Contracts | `packages/contracts/` | Shared zod schemas (career profile, job snapshot, session manifest, bridge envelopes) used by every other part | `pnpm --filter contracts build` |

## Working in this repo

```
pnpm install
pnpm typecheck   # pnpm -r typecheck
pnpm test        # pnpm -r test
pnpm lint        # pnpm -r lint
pnpm build       # pnpm -r build
pnpm check:fixtures
```

Node 24+ is required (pinned in `.nvmrc` and `engines`); pnpm is pinned via
`packageManager` in `package.json`. This repo is built by a long-horizon
autonomous build loop — see `CLAUDE.md` for the protocol and
`docs/spec/implementation/` for the packet backlog.
