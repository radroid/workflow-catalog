# Vercel `eve` as the guided local runner — primary-source research

**Research date: 2026-09-20**
**Sources read at:** `vercel/eve` `main` @ commit `d004e6d47e9d25d0380c24b5a47b65a18f8b2784` (2026-09-19 16:28 UTC, "Version Packages (#3542)"), npm registry `eve@0.63.0` (published 2026-09-19T16:38Z), eve.dev, vercel.com/eve, nitro.build.
**Method:** shallow-cloned the repo and read `docs/**`, `packages/eve/package.json`, `packages/eve/CHANGELOG.md`, `packages/eve-catalog/src/index.ts`, and the `chatgpt()` source under `packages/eve/src/public/models/openai/chatgpt/`. Nothing below is from memory. Anything not found in those sources is marked **not documented** or **UNVERIFIED**.

Citation keys like `[agent-config]` resolve to full URLs in the Sources section at the bottom.

---

## 1. What eve is, version, license, package, Node, CLI

**What it is.** "eve is a filesystem-first framework for durable AI agents. Core agent capabilities live in conventional locations, so projects are easier to inspect, extend, and operate." ([readme]) eve.dev: "A filesystem-first, Apache-2.0 framework for building durable backend AI agents that run on Vercel or your own infrastructure." ([eve-dev]) vercel.com/eve: "Like Next.js for web apps, but for agents. Markdown for instructions and skills, TypeScript for tools. Durable by default." ([vercel-eve]) Every session is a durable workflow on the open-source Workflow SDK; on Vercel it runs on Vercel Workflow, elsewhere on the SDK's local world. ([durability])

**Beta status.** README: "eve is currently in beta and subject to the Vercel beta terms; the framework, APIs, documentation, and behavior may change before general availability." ([readme]) eve.dev: "eve is currently in beta." ([eve-dev]) docs/README: "eve is in preview; the framework, APIs, documentation, and behavior may change before general availability." ([docs-readme]) The linked Vercel Public Beta Agreement says the product "may be incomplete and may contain errors or inaccuracies that could cause failures, corruption and/or loss of data", that Vercel has "no express or implied obligation ... to continue to offer or support the Product in the future", and prohibits publishing "the results of any benchmarking of the Product" without written permission. ([beta-terms])

**Version.** npm `latest` = `0.63.0` (2026-09-19); `dist-tags: { beta: '0.6.0-beta.20', latest: '0.63.0' }`. ([npm]) GitHub latest release tag `eve@0.63.0`. ([gh-releases])

**License.** `Apache-2.0` in `packages/eve/package.json` and on npm. ([pkg-json], [npm])

**npm package name(s).** The runtime + CLI is a single package: `"name": "eve"`, `"bin": { "eve": "./bin/eve.js" }`. Sub-entrypoints are exports of that one package (`eve/tools`, `eve/skills`, `eve/schedules`, `eve/connections`, `eve/channels/eve`, `eve/channels/auth`, `eve/models/openai`, `eve/models/anthropic`, `eve/evals`, `eve/client`, `eve/react`, `eve/next`, `eve/sandbox/*`, `eve/extension`, ...). ([pkg-json]) Runtime peer deps installed by `eve init`: `eve`, `ai`, `zod`. ([getting-started]) Other workspace packages in the monorepo (`@eve/catalog`, `eve-buzz-acp-adapter`, `eve-self-modification`) are not needed by app authors. ([pkg-json])

**Node requirement.** `"engines": { "node": ">=24" }`; `.nvmrc` = `24`; docs: "Node.js 24 or newer" and "npm, which Node.js includes". ([pkg-json], [getting-started])

**CLI (create / dev / build / start).** ([cli], [getting-started], [readme])

```bash
npx eve@latest init my-agent            # scaffold, npm install, git init, opens TUI (interactive TTY only)
npx eve@latest init my-agent --model openai/gpt-5.6-terra --reasoning high
npx eve@latest init .                   # add agent/ to an existing package.json project
cd my-agent && npm run dev              # = eve dev: local server on :2000 + terminal UI
eve dev --no-ui --host 127.0.0.1 --port 2000
eve build                               # compiles .eve/ artifacts, writes Nitro server to .output/
PORT=3000 eve start --host 127.0.0.1    # serves .output/; port from --port, $PORT, then 3000
eve info                                # prints discovered files, routes, diagnostics
eve eval                                # runs evals/*.eval.ts against a booted local server
eve invoke "prompt"                     # one turn without the TUI, JSON result
eve add <item> / eve registry search    # install channels/extensions/skills from the registry
eve set --model <id> --reasoning <lvl>  # edit agent/agent.ts model without the TUI (no credentials)
```

Notes: "Noninteractive and coding-agent invocations return without starting an interactive session." ([cli]) There is **no `eve login` CLI command**; model sign-in is the TUI's `/login` (or `/model`) slash command. ([cli], [dev-tui]) The package ships its docs: "the `eve` package includes its full documentation, so coding agents can read it locally from `node_modules/eve/docs`." ([readme])

---

## 2. Project anatomy — where agents, skills, tools, MCP, workflows, and prompts live

Everything is path-derived under `agent/` (single-agent project) or `agents/<name>/agent/` (workspace). ([project-structure], [agent-files])

```text
agent/
├── agent.ts              # optional; defineAgent({ model, reasoning, limits, compaction, experimental })
├── instructions.md       # REQUIRED on root: the always-on system prompt (or instructions.ts / instructions/)
├── tools/                # defineTool / defineWorkflowTool; filename = tool name (get_weather.ts -> get_weather)
├── skills/               # SKILL.md packages or flat .md; loaded on demand via built-in load_skill
├── connections/          # defineMcpClientConnection / defineOpenAPIConnection; filename = connection name
├── channels/             # eve.ts (HTTP API + route auth), slack.ts, github.ts, custom defineChannel
├── schedules/            # defineSchedule modules or .md with `cron` frontmatter (root only)
├── subagents/<name>/     # agent.ts (description required) + own instructions/tools/skills
├── extensions/           # mounts of npm/workspace extension packages (namespace = filename)
├── hooks/                # lifecycle subscribers (defineHook)
├── memory/  memory.ts    # cross-session memory provider slots
├── sandbox/  sandbox.ts  # sandbox backend + sandbox/workspace/** seeded into /workspace
├── instrumentation/      # telemetry destinations
└── lib/                  # shared helper code (import-only)
evals/                    # *.eval.ts + evals.config.ts — beside agent/, not inside it
```
([agent-files], [readme])

**Prompts (for a maintainer to find and edit).**
- System prompt: `agent/instructions.md` ("Whatever you write is the prompt"). Split across `agent/instructions/*.md|*.ts` (non-recursive, alphabetical). `agent/instructions.ts` uses `defineInstructions({ content, role: "system" | "user" })`; user-role instructions are appended once to a new session's history. Root `instructions.md` + `instructions.ts` together is a build error. ([instructions])
- Skill bodies: `agent/skills/<name>.md` or `agent/skills/<name>/SKILL.md` (+ `references/`, `assets/`, `scripts/`). ([skills])
- Schedule prompts: `agent/schedules/<name>.md` body (frontmatter: `cron` only) or `markdown:` in `defineSchedule`. ([schedules])
- Subagent prompts: `agent/subagents/<name>/instructions.md`. ([agent-files])
- Tool descriptions: the `description` field in each `agent/tools/*.ts`. ([tools])

**Agents.** `agent/agent.ts`:
```ts
import { defineAgent } from "eve";
export default defineAgent({ model: "anthropic/claude-opus-4.8" });
```
`agent.ts` may be omitted (default model `openai/gpt-5.6-luna-fast`); "When `agent.ts` is present, `model` is required." Other fields: `reasoning`, `modelOptions`, `limits` (`maxInputTokensPerSession` default 40,000,000, `maxTokenCostUsdPerSession`, `sessionTimeoutMs` default 30 days), `compaction.thresholdPercent` (default 0.9), `outputSchema`, `tool`, `build.externalDependencies`, `experimental.workflow.{world,modelCallsPerStep,retention}`. ([agent-config])

**Skills — yes, Agent Skills / SKILL.md is supported.** "A skill is a model-loadable procedure that follows the `SKILL.md` convention ... the same model the broader Agent Skills standard uses, so a skill authored against that standard ports over as-is." Packaged `SKILL.md` must carry `description` frontmatter; eve reads `description`, optional `license`, string `metadata`; other frontmatter is a no-op. Flat `.md` skills may omit frontmatter (first non-empty line becomes the description). `defineSkill` from `eve/skills` for TypeScript-authored skills. Community skills: `eve registry search react --registry @skills` / `eve add @skills/vercel-labs/agent-skills/vercel-react-best-practices` (skills.sh). Supporting files land in the sandbox at `$HOME/.agents/skills/<skill>/`; "Static skills do not require a sandbox". Skills are scoped per agent; share via extensions. ([skills])

**Tools.** `agent/tools/<name>.ts`:
```ts
import { defineTool } from "eve/tools";
import { z } from "zod";
export default defineTool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({ city: z.string().min(1) }),
  async execute({ city }, ctx) { return { city, condition: "Sunny", temperatureF: 72 }; },
});
```
"Authored tools run in your app runtime with full access to `process.env`, not in the sandbox." `ctx` exposes `session`, `callId`, `toolName`, `abortSignal`, `getSandbox()`, `getSkill(id)`, `getToken(provider)`, `requireAuth(provider)`. Approval gating: `approval: always() | once() | never() | auto() | policyFn` from `eve/tools/approval`; omitted = `never()`. ([tools], [hitl])

**Workflows.** There is no `workflows/` directory. A "workflow" is a tool: `defineWorkflowTool` from `eve/tools` under `agent/tools/`, with `"use workflow"` as the executor's first statement, `"use step"` helpers for side effects, and durable waits via `ctx.ask(...)` (human question), `createHook`/`createWebhook`/`sleep` from `workflow`, plus `ctx.agent(name, ...)` for delegation. `execution: "background"` returns `{ status: "working", taskId }` immediately. As of 0.63.0: "Require durable background tools to use `defineWorkflowTool`. Remove background execution from `defineTool`". ([workflows], [changelog])

**MCP / OpenAPI connections.** `agent/connections/<name>.ts`; tools appear as `<connection>__<tool>` via the built-in `connection_search` tool; "The model never sees a connection's URL or credentials." ([connections]) Details in section 6.

**Extensions (the packaging unit for a shareable workflow).** "Extensions package eve tools, channels, connections, skills, schedules, subagents, instruction fragments, and hooks." Author with `npx eve@latest extension init my-crm` (creates `extension/extension.ts`, `extension/tools/`, `extension/skills/`, `extension/schedules/`, `extension/instructions.md`, ...), build with `eve extension build` (publishes `dist/`), consumer mounts with a file under `agent/extensions/<ns>.ts`; contributions are prefixed `<ns>__`. The extension root "cannot declare agent configuration, instrumentation, memory, a sandbox, or nested extensions." Registry items use the shadcn registry JSON format and install with `eve add <url>` or `eve add @ns/item`. ([extensions], [install-integrations])

---

## 3. Model providers, `chatgpt()`, and its local-only restriction

**How models are configured.** `defineAgent({ model })` accepts (a) a Vercel AI Gateway model-id string (`"openai/gpt-5.6-luna-fast"`, needs Vercel project OIDC or `AI_GATEWAY_API_KEY`), (b) a provider-authored AI SDK `LanguageModel`, (c) eve's helpers `openai()` / `anthropic()` / `chatgpt()`, (d) `defineDynamic({ events })` per session/turn/step, (e) `auto` from `eve/models` (evaluation-model routing), (f) `mockModel` from `eve/evals` for tests. ([agent-config], [ts-api], [evals-overview])

**Direct providers.** `openai()` from `eve/models/openai` (default `gpt-5.6-luna-fast`, uses `OPENAI_API_KEY`) and `anthropic()` from `eve/models/anthropic` (default `claude-sonnet-5`, uses `ANTHROPIC_API_KEY`). "During local development they can also use credentials saved through `/login`. Deployments require their API key in the server environment." Any AI SDK provider package can be installed and its `LanguageModel` passed. ([agent-config])

**Login options in the TUI (`/login`).** "1. Vercel Account 2. Vercel AI Gateway API Key 3. ChatGPT Subscription 4. OpenAI API Key 5. Anthropic API Key". API keys and eve-owned OAuth refresh credentials go to the OS secret store via just-secrets; non-secret connection metadata goes to `.eve/provider.json`; "Newly entered keys are never written into project files." ([dev-tui])

**`chatgpt()` — exactly what it uses.**
```ts
import { defineAgent } from "eve";
import { chatgpt } from "eve/models/openai";
export default defineAgent({ model: chatgpt() });   // defaults to gpt-5.6-luna-fast
```
- Docs: "`chatgpt()` from `eve/models/openai` serves an OpenAI model through your local ChatGPT login and bills the ChatGPT subscription." "Pass another bare OpenAI model slug to override the default." "`chatgpt()` uses stateless requests (`store: false`)." ([ts-api])
- Two credential owners: "If `codex` is on `PATH`, eve uses `codex app-server` and launches `codex login` when sign-in is needed. Codex owns credential storage and refresh." Otherwise "eve falls back to direct browser sign-in and owns the saved session and refresh." ([ts-api])
- Source confirms the mechanism: requests to `/v1/responses` are rewritten to `https://chatgpt.com/backend-api/codex/responses` with `authorization: Bearer <token>`, `originator: eve`, `ChatGPT-Account-Id`. ([src-transport]) The eve-owned OAuth flow is PKCE against `https://auth.openai.com/oauth/authorize` with `client_id = app_EMoamEEZ73f0CkXaXp7hrann` (comment: "OpenAI's public OAuth client, also used by fx and opencode; no client secret"), `redirect_uri = http://localhost:1455/auth/callback`, scope `openid profile email offline_access`, params `codex_cli_simplified_flow=true`, `originator=eve`; device-code fallback when headless or port 1455 is busy. ([src-oauth], [src-chatgpt-auth])
- Credential storage (eve-owned path): OS secret store, service `eve` / name `chatgpt` ("the login Keychain on macOS, Credential Manager on Windows, or Secret Service on Linux"); access tokens stay in memory; legacy plaintext `~/.eve/auth/chatgpt.json` is deleted on first successful save; "eve does not fall back to file storage if the OS credential store is unavailable." ([ts-api], [src-credential-store])
- Device sign-in "requires enabling device code authorization in ChatGPT Settings → Security"; sign-in times out after five minutes. ([ts-api])

**Documented limits of `chatgpt()`.**
- Model scope: "the Codex backend serves OpenAI models only, so any other provider-qualified id is rejected. Model availability is enforced by the Codex backend per account at call time, not at compile time." ([src-openai-index]) Troubleshooting: "Model rejected by the backend: model availability depends on the signed-in ChatGPT account." ([ts-api])
- Rate limits / quotas / OpenAI terms for third-party subscription use: **not documented** in eve. (Whether OpenAI's ChatGPT/Codex terms permit a third-party runner to bill a user's subscription this way is **UNVERIFIED** here — it is a legal/ToS question for OpenAI's terms, not eve's docs.)
- Codex CLI presence changes behavior: "App-server errors other than a missing binary are reported instead of silently switching credential owners." ([ts-api])

**Exact wording of the local-only restriction.**
- agent-config: "For a local ChatGPT subscription, use `chatgpt()` from `eve/models/openai` and sign in with `/login`. It defaults to `gpt-5.6-luna-fast` and cannot run in a deployment." ([agent-config])
- dev-tui: "Local discovery runs only in development. Deployments need explicitly provisioned `AI_GATEWAY_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or supported project OIDC credentials. ChatGPT subscription models are local-only." ([dev-tui])
- ts-api: "ChatGPT subscription credentials are local user credentials. `eve deploy` blocks agents whose active model is `chatgpt()` because those credentials are not uploaded to a deployment. Use an environment branch with a deployable model, or switch to an AI Gateway model before deploying." ([ts-api])
- Source JSDoc: "This model works in local dev and fails in a deployment. Branch on environment for production", with the example `model: process.env.NODE_ENV === "production" ? "anthropic/claude-sonnet-4.6" : chatgpt()`. ([src-openai-index]) The deploy flow returns `{ kind: "local-model" }` when the compiled model routing is `provider: "codex"`. ([src-deploy])
- Tutorial: "If you used a local ChatGPT subscription, switch `agent/agent.ts` to an AI Gateway model and configure `AI_GATEWAY_API_KEY` ... Subscription credentials stay on your laptop." ([ship-it])

**Does `chatgpt()` work under a self-hosted `eve start` on the same laptop?** **UNVERIFIED / not documented.** The docs only say "local dev" vs "deployment". In source, the transport first tries the dev credential broker (only when `EVE_DEV=1` and `EVE_DEV_CONTROL_URL` are set, i.e. inside `eve dev`), and otherwise falls back to `getDefaultCodexTokenBroker().getToken()`, which reads Codex app-server or the OS secret store directly. So a built `eve start` process on the machine where the user already signed in has a code path to the credentials, but no doc promises this and there is no test cited for it. Treat as a day-1 spike. ([src-transport], [src-broker-client], [src-token-broker])

**Safety identifier.** For OpenAI/Anthropic calls eve fills `providerOptions.openai.safetyIdentifier` / `providerOptions.anthropic.metadata.userId` from a SHA-256 fingerprint of the route-auth principal when `auth.current` is non-null. ([agent-config])

---

## 4. Durable execution and scheduling

**Execution model.** session → turn → step. "Every session runs as one durable workflow, built on the open-source Workflow SDK." "By default, eve commits a durable Workflow step after every model call and its inline tool calls." ([durability], [agent-config])

**Persistence when self-hosted.** "In local development and in a self-deployed `eve start` process, eve uses the SDK's local world by default; that world persists workflow runs on disk under `.eve/.workflow-data`." Self-hosting guide: "Mount that directory on persistent storage so runs survive process and container replacement." On-disk format of the local world (SQLite vs files): **not documented** in eve; the npm package `@workflow/world-local` only describes itself as "Local development World implementation for Workflow SDK". ([durability], [self-hosting], [npm-world-local]) Optional Postgres: `experimental.workflow.world: "@workflow/world-postgres"` pinned to the `5.0.0-beta` line (`pnpm add @workflow/world-postgres@5.0.0-beta.x`); "The npm `latest` tag can lag behind that line, so an unpinned install may pull an incompatible protocol version." eve 0.63.0 vendors `@workflow/core@5.0.0-beta.53`, `@workflow/world-local@5.0.0-beta.45`. ([agent-config], [pkg-json])

**Restart / crash behavior.** "An eve session is a durable conversation. It can run for days and survives process restarts and redeploys without any work on your part." "Crash the process, hit a timeout, or redeploy mid-turn, and the run picks up from the last completed step rather than replaying the whole turn. Completed steps never re-run; eve replays the recorded result. A step interrupted mid-execution re-runs, so make non-idempotent side effects like charges or emails idempotent, or gate them with approval." "eve runs each durable step up to four times." Parked work (HITL approval, `ask_question`, OAuth) "suspends and holds no compute until the input it's waiting on arrives, even if that's much later." ([durability], [sessions], [hitl]) Caveat for `eve dev`: superseded runtime generations are pruned after ~30 min / 5 generations, and "A turn that remains unfinished beyond the automatic retention window can no longer resume after its generation is pruned." ([cli])

**Schedules — definition.** `agent/schedules/<name>.ts` or `.md`; name is path-derived; root agent only. `cron` is "a standard 5-field string ... with minute granularity"; exactly one of `markdown` (fire-and-forget "task mode": "cannot park to wait for a person or an OAuth sign-in") or `run({ to, waitUntil, appAuth })` (can park, sends to a channel target). "Markdown schedules start a new session on every fire." ([schedules])
```ts
import { defineSchedule } from "eve/schedules";
export default defineSchedule({ cron: "*/5 * * * *", markdown: "Pull open items and summarize." });
```
```md
---
cron: "0 0 * * 0"
---
Sweep stale workflow state.
```

**When schedules fire.** "`eve dev` never fires schedules on their cron cadence. A built app served with `eve start` does run production scheduled tasks." "Outside Vercel, the standard `eve build && eve start` path serves Nitro's Node output and starts Nitro's schedule runner, so the tasks fire on their cron cadence while that process is running." Custom hosting that only serves HTTP will not fire them. Dev-only manual trigger: `curl -X POST http://localhost:2000/eve/v1/dev/schedules/<id>` → `{ "scheduleId", "sessionIds": [...] }`; "Production builds never mount it, and it needs no auth since the dev server is local-only." ([schedules]) In source, eve sets `nitro.options.experimental.tasks = true` and writes one `nitro.options.scheduledTasks[cron]` entry per schedule. ([src-schedule-routes]) Nitro's own docs: scheduled tasks are experimental, Node presets are "Powered by the croner engine" in-process, and "Task runs are deduplicated by task name: each task can have at most one running instance per server instance." ([nitro-tasks])

**Missed schedules when the process is stopped.** **Not documented** by eve, and the Nitro tasks doc "does not address missed runs or catch-up behavior for downtime scenarios." Because the runner is an in-process cron engine, assume no catch-up: a laptop asleep at 09:00 does not fire the 09:00 job later. Use the documented "dynamic scheduling" pattern (one `* * * * *` dispatcher schedule that atomically claims due rows from your own store, "Delivery is at least once") if catch-up matters. ([nitro-tasks], [dynamic-scheduling])

**Time zone.** On Vercel cron is evaluated in UTC. For self-hosted Nitro/croner: **not documented** by eve. ([schedules])

**Session-scoped state vs long-term memory.** `defineState(name, initial)` from `eve/context` is per-session, survives step boundaries, never shared with subagents. Cross-session memory uses a provider slot; the built-in `fileMemory()` is provisioned by `eve add memory/file` onto a **Vercel Blob store** (env `EVE_MEMORY_BLOB_STORE_ID`); a purely local file backend for it is **not documented**. ([state], [memory-file])

---

## 5. Self-hosting: build/start output, HTTP surface, auth, local UI, env vars

**Build/start.** "The build writes the Nitro server under `.output/`. `eve start` serves that output and accepts either `PORT` or the `--port` flag." `eve build` also "always writes compiler artifacts under `.eve/`" (`.eve/discovery/*.json`, `.eve/compile/compiled-agent-manifest.json`, `.eve/compile/module-map.mjs`). The server entry is `.output/server/index.mjs` (referenced by the Next.js integration). "For self-hosted deployments, copy the app source, `.output/`, and installed dependencies together." `eve start` calls `loadDevelopmentEnvironmentFiles(root)` before booting, i.e. it loads the project's env files the same way `eve dev` does (`.env.local` is the documented file). ([self-hosting], [cli], [nextjs], [src-cli-run])

**Defaults to watch.** `eve start` and `eve dev` both bind "all interfaces" by default (`--host` to change); dev port default 2000, start port default `$PORT` then 3000. ([cli]) For a local runner always pass `--host 127.0.0.1`.

**HTTP surface (the default `eve` channel, `/eve/v1`).** ([eve-channel], [sessions])
- `GET /eve/v1/health` → `{ ok: true, status: "ready", workflowId }` (public, no auth)
- `GET /eve/v1/info` → agent-info v4 (route auth applies)
- `POST /eve/v1/session` (body optional `{ message, operationId?, clientContext?, outputSchema? }`) → `202 { ok, sessionId: "wrun_…", status: "accepted" }` + `x-eve-session-id` header
- `POST /eve/v1/session/:sessionId` with `{ message }` **or** `{ inputResponses: [{ requestId, optionId }] }` (answer HITL)
- `POST /eve/v1/session/:sessionId/{cancel,clear,compact,reset}`
- `GET /eve/v1/session/:sessionId/stream` → NDJSON, one event per line (`session.started`, `turn.started`, `message.appended`, `message.completed`, `actions.requested`, `action.result`, `input.requested`, `authorization.required`, `turn.completed`, `session.waiting`, ...); reconnect with a cursor; `x-eve-stream-version` header; `includeTailIndex=1` for catch-up reads
- `GET /` and `HEAD /` default home page (`channels/home.ts`)
- `/.well-known/workflow/` receives workflow callbacks — "A proxy restricted to `/eve/` lets a session start, but the run stalls when its callback can't reach eve." ([self-hosting])
- Dev-only: `POST /eve/v1/dev/schedules/:id` ([schedules])
- `409 session_not_active` / `409 session_not_ready` on follow-ups; retry `session_not_ready` with backoff. ([eve-channel])

**Auth (fails closed).** Route auth lives in `agent/channels/eve.ts`: `eveChannel({ auth: [...] })`. "eve fails closed by default: production traffic is rejected unless you configure an authenticator that accepts it, and anonymous access requires an explicit `none()`." Helpers from `eve/channels/auth`: `localDev()`, `vercelOidc()`, `none()`, `httpBasic(credentials, { realm })`, `jwtHmac()`, `jwtEcdsa()`, `oidc()`, custom `AuthFn`, `placeholderAuth()`. **`localDev()` only authenticates under `eve dev` (`EVE_DEV=1`) or `vercel dev`; "A production deployment (`eve start`, a Vercel deployment, or any container host) sets neither flag, so `localDev()` authenticates nothing there."** The scaffold's `placeholderAuth()` "returns a structured `401`" in production. Route-auth secrets belong in env (`ROUTE_AUTH_BASIC_PASSWORD` is the documented example name). ([auth], [src-auth-localdev])
```ts
// agent/channels/eve.ts — example for a local runner served by `eve start`
import { eveChannel } from "eve/channels/eve";
import { httpBasic, localDev } from "eve/channels/auth";
export default eveChannel({
  auth: [httpBasic({ username: "runner", password: process.env.RUNNER_TOKEN! }), localDev()],
  cors: { origin: "<extension origin>", methods: ["GET", "POST"], allowedHeaders: ["authorization", "content-type"] },
});
```
(`httpBasic` argument shape is documented as `httpBasic(credentials, { realm })`; the exact `credentials` object keys are **not shown** in the docs I read — check the type in `eve/channels/auth` before use.) ([auth])

**Can a browser extension on 127.0.0.1 call it?** Yes in principle: "The eve channel leaves CORS untouched by default. Pass `cors: true` to enable permissive browser CORS with preflight handling, or pass an options object to narrow origins, methods, and headers. Route auth still runs on the actual session requests." ([eve-channel]) Handling of `chrome-extension://<id>` origins specifically is **not documented** — treat as a spike. The `Client` from `eve/client` (`new Client({ host: "http://127.0.0.1:2000", auth: { bearer | basic } })`, `client.sessions.create({ message })`, `session.stream()`) wraps the protocol; the React hook `useEveAgent({ host, auth, headers })` does the same for UI. ([client], [frontend])

**Local UI / chat surfaces.** (1) The terminal UI (`eve dev`; `/login`, `/model`, `/add`, `/deploy`, `/traces`, `/info`, approvals and questions answered inline; `eve dev <url>` attaches the TUI to any running server, including `eve start`). (2) `eve add channel/web` (or `eve init --channel-web-nextjs`) generates a Next.js Web Chat app with `withEve()` and routes `/`, `/s`, `/s/[sessionId]` on same-origin `/eve/v1/*`; "Before accepting production browser traffic, replace the generated placeholder authorization policy." (3) `eve invoke "…"` for scripted turns. There is no built-in standalone web UI served by `eve start` beyond the `GET /` home/status page. ([dev-tui], [nextjs], [cli], [eve-channel])

**Sandbox backend (affects a non-developer install).** `defaultBackend()` order: Vercel Sandbox (on Vercel) → Docker (if a docker CLI/daemon is reachable) → microsandbox (macOS Apple Silicon or Linux+KVM) → just-bash (pure-JS simulated bash, "no real binaries ... and no network isolation"). Both `microsandbox` and `just-bash` are optional peers that "`eve dev` installs ... automatically when missing"; "production processes fail with actionable install errors instead." Built-in `bash`/`read_file`/`write_file` tools proxy into the sandbox. ([sandbox], [security-model])

**Environment variables (documented).** Model: `AI_GATEWAY_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `VERCEL_OIDC_TOKEN` (via `eve link`). Server: `PORT`, `EVE_PUBLIC_ROUTE_PREFIX` (path-prefix mounts), `EVE_DEV` (internal, set by `eve dev`), `NODE_ENV` (used in the documented env-branch example). Sandbox: `EVE_DOCKER_PATH`, `EVE_SANDBOX_IMAGE_TAG`. Telemetry/traces: `EVE_TELEMETRY_DISABLED=1` ("eve collects CLI telemetry by default"), `EVE_TELEMETRY_DEBUG`, `EVE_TRACES`, `EVE_TRACES_CONTENT`, `EVE_TRACES_MAX_AGE_MS`, `EVE_TRACES_MAX_TOTAL_BYTES`, `EVE_TRACES_RETAIN_COUNT`. Evals: `EVE_EVAL_AUTH_TOKEN`, `VERCEL_AUTOMATION_BYPASS_SECRET`. Next.js integration: `EVE_NEXT_PRODUCTION_PORT` (default 4274). Memory: `EVE_MEMORY_BLOB_STORE_ID`, `EVE_MEMORY_BLOB_WEBHOOK_PUBLIC_KEY`. TUI: `EVE_TUI_RENDER_MARKDOWN`. ([self-hosting], [cli], [dev-tui], [sandbox], [nextjs], [memory-file], [evals-targets])

---

## 6. Service connections / integrations

**Mechanisms.** ([connections], [auth])
- Static token: `auth: { credentialOwner: "app", getToken: async () => ({ token: process.env.X!, expiresAt? }) }` — sent as `Authorization: Bearer`; `headers: { "X-Api-Key": ... }` for other schemes; per-caller resolver functions supported.
- Interactive OAuth, hosted: `connect("<connector-uid>")` from `@vercel/connect/eve` (Vercel Connect). Requires a Vercel project: `npm install @vercel/connect && vercel link && vercel connect create <service> --name <name> && vercel connect attach <uid> --yes && vercel env pull`. User-scoped by default; app-scoped with `principalType: "app"`.
- Interactive OAuth, self-hosted (no Vercel): `defineInteractiveAuthorization` from `eve/connections` — "eve mints a callback URL, parks (durably suspends) the turn on a framework-owned webhook, and resumes once the token comes back." Emits `authorization.required` on the stream with `data.authorization` (`url`, `userCode`, `expiresAt`, `instructions`).
- Per-tool inline: `ctx.getToken(provider)` / `ctx.requireAuth(provider)` inside `execute`.
- Hard constraint: user-scoped connections need a real user principal from route auth ("`ctx.session.auth.current.principalType === "user"`"); a `localDev()`, schedule, or anonymous session fails with `reason: "principal_required"`. For a single-user local runner, use app-scoped/static-token auth or make the custom `AuthFn` return `principalType: "user"`.
- Approval per connection: `approval: once() | always() | auto() | policyFn`; MCP tool filters `tools: { allow: [...] }`.

**Out-of-the-box catalog (from `packages/eve-catalog/src/index.ts`, `kind` field).** ([catalog])
- GitHub: `channel/github` (GitHub App webhooks via Vercel Connect, or bring-your-own `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY`/`GITHUB_WEBHOOK_SECRET`) and extension `github-tools` ("scoped GitHub tools with Vercel Connect authentication and approval rules"). Both are Vercel-Connect-oriented. ([github-channel], [catalog])
- Gmail: only `channel/chat-sdk-gmail` — "Turn labelled Gmail threads into agent conversations via the Chat SDK." That is an inbound *channel*, not a Gmail read/send *tool*. **No Gmail or Google Workspace connection/tool is in the catalog.** ([catalog])
- Connections (`kind: "connection"`, MCP): Vercel, Linear, Notion, Datadog, Honeycomb, Airtable, Stripe, Supabase, Neon, PostHog, Sentry, Shopify, Zapier, Todoist, Miro, Mixpanel, and ~30 others. Channels: Slack, Discord, Teams, Telegram, Twilio, Web Chat, Google Chat, WhatsApp, Linq, Photon, etc. Extensions: `agent-browser` (browser automation), Browserbase, Browser Use. Memory: File memory, Supermemory, Upstash AgentKit, Mem0. ([catalog])
- Install: `eve add channel/github`, `eve add extension/agent-browser`, `eve add <item> --non-interactive --yes` for scripted setup (exit `2` = needs an answer). ([install-integrations])

**Implication.** For a local, non-Vercel runner, Gmail/Google must be a hand-written tool: either an OpenAPI connection with a static token, or a custom `defineInteractiveAuthorization` flow against Google OAuth. Vercel Connect (`connect()`) is not usable without a Vercel project and link.

---

## 7. Testing

**Evals are the documented test surface.** `evals/*.eval.ts` with `defineEval({ async test(t) { ... } })`; one `evals/evals.config.ts` per `evals/` dir. Drive: `t.send("...")` → turn; `turn.session.send(...)`; `session.respond(...)` for HITL. Assert: `t.succeeded()`, `t.calledTool("get_weather")`, `t.check(turn.message, includes("Sunny"))` (`includes|equals|matches|similarity` from `eve/evals/expect`), `t.judge("cites a source")` (LLM judge, default `typesafe-ai/jev`, soft by default; `.gate()`/`.atLeast()`). Gates fail the run; soft assertions are tracked (fail only with `--strict`). ([evals-overview])

**Mocking the model.** `mockModel` from `eve/evals`: `defineAgent({ model: mockModel("A deterministic reply") })`, or a callback `({ lastUserMessage, userMessageCount, tools, toolResults }) => string | { text, toolCalls, usage }` for scripted tool loops. "Because the model is part of the agent definition, use it for a dedicated fixture agent." ([evals-overview])

**Running.** `eve eval` boots a local dev server; `eve eval --url https://…` targets a running server; `--strict`, `--tag`, `--junit .eve/junit.xml`, `--json`, `--max-concurrency` (default 8), exit codes 0/1/2; artifacts under `.eve/evals/<timestamp>/` (`summary.json`, `results.jsonl`, per-eval event streams). ([evals-running]) Schedule testing: `t.target.dispatchSchedule("heartbeat")` (dev-routes only) + `t.target.attachSession(id)`; `t.target.fetch(path)` for channel ingress. ([evals-targets])

**Not documented:** unit-testing a `defineTool` executor in isolation (no test harness for `execute(input, ctx)` is described); the internal `vitest` configs in the repo are for eve itself. `eve invoke` is a CLI alternative for smoke scripts (exit `3` when paused for input). ([cli])

---

## 8. Known gaps / risks for our use, version pin

1. **Beta churn is real and fast.** 27 releases from 0.52.0 (2026-09-04) to 0.63.0 (2026-09-19), 12 of them minor bumps; recent minors removed/renamed public APIs: 0.63.0 dropped background execution from `defineTool` and removed `TaskExec`/`postMessage`; 0.62.0 replaced `t.judge.autoevals.*`, moved instrumentation to `agent/instrumentation/`, removed compatibility shapes; 0.60.0 removed `redactSpanInputs()` etc. and moved `autoModel`/`evaluate` imports; 0.59.0 changed eval session ownership. ([changelog], [npm]) Vercel's beta agreement disclaims continued support. ([beta-terms])
2. **Workflow SDK is also beta** (`@workflow/*@5.0.0-beta.*`), and world packages must match the line eve vendors. ([agent-config], [pkg-json])
3. **Node 24 is required** (`engines >=24`); many machines run 20/22. ([pkg-json])
4. **ChatGPT sign-in is TUI-only** (`/login`/`/model` in `eve dev`); there is no `eve login` command and `eve set` "does not configure model credentials." A non-developer install must drive the TUI once, or we accept API keys instead. ([cli], [dev-tui])
5. **`chatgpt()` under `eve start` is undocumented** (see section 3); documented only as "local dev". If it fails, the only cron-capable mode (`eve start`) cannot use the subscription and we must choose between cron and subscription billing, or trigger runs ourselves against `eve dev --no-ui`. ([schedules], [src-transport])
6. **Missed cron runs do not catch up** (not documented by eve or Nitro; in-process croner). ([nitro-tasks])
7. **Auth gotcha:** `localDev()` is inert under `eve start`; the scaffold returns `401` until replaced; both servers bind all interfaces by default. ([auth], [cli])
8. **Sandbox on a friend's laptop:** without Docker, `defaultBackend()` picks microsandbox (Apple Silicon) or just-bash, both auto-installed only by `eve dev`; under `eve start` a missing package is a hard failure. Pin `justbash()`/`docker()` explicitly and add the dependency, or remove sandbox tools. ([sandbox])
9. **OS support:** no explicit support matrix in docs. Evidence: CI runs `ubuntu-latest` and `windows-latest` (a dedicated `test-dev-windows` job); credential storage documented for macOS Keychain, Windows Credential Manager, Linux Secret Service (Linux/WSL needs `secret-tool`, D-Bus, unlocked keyring). macOS support otherwise **UNVERIFIED by docs** (the author's machines are evidently macOS, but nothing states it). ([ci], [ts-api])
10. **Telemetry on by default** for the CLI (`EVE_TELEMETRY_DISABLED=1` to opt out); local traces stored under `.eve/traces/` with prompt/response content by default (`EVE_TRACES_CONTENT=off`). ([cli])
11. **Vercel-centric integrations:** Vercel Connect OAuth, File memory (Vercel Blob), GitHub channel, Web Chat installer all assume `eve link`/a Vercel project. ([connections], [memory-file], [github-channel])
12. **Single durable data dir:** `.eve/.workflow-data` inside the project; deleting the project directory loses sessions. ([self-hosting])
13. **Responsible-use posture:** "Unless you configure stricter controls, eve agents may operate with permissive settings, including tool execution without human approval where approval is omitted." Job applications are "employment" actions the docs explicitly say should require approval. ([responsible-use])
14. **Directives compile per app root.** This is not in the docs. It was verified by probe at eve@0.63.0 during the P03 review (2026-09-22; logs/blocks.md, "P03 peer review, round 1").
    - `"use workflow"` and `"use step"` are compiled and registered only for modules inside the app root being built (`runner/agent` or `runner/eval-agent/agent`).
    - Within one root, imports work, including an imported `"use workflow"` executor and separate step modules.
    - Across roots, the directives fail:
      - Re-exporting a workflow tool from another root fails discovery: "requires a compiled workflow executor".
      - Importing a `"use step"` function from another root builds, then fails at run time: `Step "step//./…" is not registered`.
      - A directive-free helper imported from another root and called from a local step works.
    - Pattern:
      - Share logic in directive-free modules under `runner/agent/lib/`.
      - Keep a thin executor and step wrapper in each root.
      - Never re-export or copy a tool's logic into the eval agent. Evals must exercise the shared helper, not a copy.
15. **An aborted client turn can end quietly as `completed`.** This is not in the docs. It was verified at eve@0.63.0 during the P08-A review (2026-09-22; logs/blocks.md, "P08-A peer review, round 1"), by probes with the real `Client` and a stubbed `fetch`, and by reading `dist/src/client/`.
    - `open-stream.js` `followStreamIterable`: when the `signal` aborts while the client is opening or reopening the event stream, or while it backs off between attempts, the stream returns without throwing (`catch … if (signal.aborted) return`, and the `aborted` checks after the read loop and after `sleep`). An abort while an open stream is being read does throw.
    - `session-utils.js` `summarizeTurnEvents`: `status` is `waiting` or `failed` only when a boundary event (`session.waiting`, `session.failed`) was seen. With no boundary it defaults to `completed`. So `response.result()` resolves `completed` for a turn that never finished.
    - The client reconnects an idle stream after 15 s (`streamReadIdleTimeoutMs`, default 15e3). A turn that goes silent more than about 15 s before its deadline therefore hits the quiet path.
    - **Silence without an abort** (checked 2026-09-23, P03 round-3 review):
      - A turn response (`MessageResponse`, whether through `result()` or by iterating it) follows its stream with `keepAlive`, so eve reopens a silent stream without limit.
      - If that stream ends before the turn boundary without an abort, eve throws "The response stream ended before the accepted message reached its turn boundary." (`session.js`, when the send reported a delivery id). So on a turn response, the only quiet end is the abort.
      - A manually opened `session.stream()` stops quietly after five reopens in a row that bring no event (idle policy `maxAttempts: 5`, each reopen after 15 s of silence). eve's docs say it "eventually stops after repeated empty streams" (`guides/client/streaming.mdx:154`).
    - `MessageResponse.cancel()` sends nothing until the client has seen the turn start, and nothing once the turn is parked. `ClientSession.cancel()` (`POST …/session/:id/cancel`) is the reliable cancel.
    - Pattern for every caller that sets a timeout:
      - After `result()` resolves, check `signal.aborted`.
      - Treat a turn as ok only when `summarizeTurnEvents(...).boundary` (a terminal `session.*` event) is present.
      - Cancel through the session.
      - Read the stream event by event, so partial `step.completed` usage survives a timeout.
    - **Which boundary means what.** Don't confuse our "parked" with eve's.
      - A normal conversation turn, which is what `client.sessions.create` gives, ends `turn.completed → session.waiting`. eve's docs call `session.waiting` "parked and ready for the next message": that is idle between turns, and it is **ok**.
      - `session.completed` ends only task-mode sessions, such as a schedule firing. The P02 spike (`eve-spike.md`) recorded both sequences.
      - A turn is **waiting on the person** only when `input.requested` carried a non-empty request list (`result().inputRequests`).
      - `turn.cancelled` (always followed by `session.waiting`) is not ok.
      - A failure event, or a `session.failed` boundary, is not ok.
      - Found in the P08-A round-2 review (2026-09-22): a harness that read `session.waiting` as "needs input" recorded every normal run as a failure.
    - Callers: P08-A `runTurn` (fixed in its revision), P03's extraction route (R3 timeout), and P02's `checkModel` (a runner follow-up).

**Recommended pin (read 2026-09-20):** `"eve": "0.63.0"` exact (no caret), `"ai"` and `"zod"` at whatever `eve init` writes for 0.63.0, Node `24` in `.nvmrc`/`engines`, and read docs from `node_modules/eve/docs` at that version rather than `main`. Re-evaluate the pin deliberately; do not float `eve@latest` in the template.

---

## Implications for the MVP

- **Ship a full pinned eve project template, not just an extension.** The template pins `eve@0.63.0`, Node 24, an explicit sandbox backend, and a replaced `agent/channels/eve.ts`; the job-application workflow itself can still be authored as an extension package (`extension/instructions.md`, `extension/skills/*/SKILL.md`, `extension/tools/*.ts`, `extension/schedules/*.ts`) mounted at `agent/extensions/jobs.ts`, so later workflows are `eve add`-able.
- **Prompts are plain files:** `agent/instructions.md` (system), `agent/skills/**/SKILL.md` (procedures, Agent Skills-compatible), `agent/schedules/*.md` (cron prompts). Put every editable prompt there; keep tools thin.
- **Pick the runner mode on day 1 with a spike:** (A) `eve build && eve start --host 127.0.0.1 --port 3000` gives real cron but needs `httpBasic()`/custom auth + CORS and an unverified `chatgpt()` path; (B) `eve dev --no-ui --host 127.0.0.1 --port 2000` gives `/login`-brokered ChatGPT credentials and `localDev()` auth for free but never fires cron and prunes stale runtime generations. If (A) fails the `chatgpt()` test, run (B) and have the extension/OS scheduler `POST /eve/v1/dev/schedules/<id>` or `POST /eve/v1/session` on its own clock.
- **Model default:** `model: process.env.EVE_RUNNER_MODEL_MODE === "api" ? openai() : chatgpt()` (or gateway string) with `reasoning` set; document that ChatGPT sign-in happens in the TUI (`/login` → "ChatGPT Subscription", browser to `localhost:1455`) and that Codex CLI, if installed, becomes the credential owner.
- **Extension ↔ runner contract:** JSON `POST /eve/v1/session`, NDJSON `GET .../stream`, HITL via `input.requested` → `POST .../session/:id { inputResponses }`, cancel via `.../cancel`. Set `cors: { origin: <extension origin> }` on `eveChannel` and verify Chrome's `chrome-extension://` origin is accepted (not documented).
- **Route auth for the runner:** generate a per-install secret at setup, store it in the extension's storage, send it as Basic/Bearer; keep `localDev()` as the last entry so (B) also works. Never `none()`.
- **Gate the side effects:** wrap "submit application", "send email", "post message" tools with `approval: always()` (or a policy) and rely on `ctx.ask`/`ask_question` for the guided flow; this is also what makes step replays safe.
- **Gmail/GitHub:** no local-friendly Gmail tool exists; write an OpenAPI/static-token or `defineInteractiveAuthorization` tool. For GitHub use a PAT via `getToken`, not Vercel Connect.
- **Persistence:** rely on `.eve/.workflow-data` for sessions; keep the user's profile/resume data in our own files (a tool under `agent/lib/`), since `fileMemory()` provisions Vercel Blob. Back up `.eve/` in the installer's uninstall/upgrade path.
- **Tests:** a fixture agent with `mockModel` + `evals/*.eval.ts` asserting `t.calledTool(...)` and `t.succeeded()`; CI `eve eval --strict --junit`. Set `EVE_TELEMETRY_DISABLED=1` in the installer or disclose telemetry.

---

## Sources

Repo blobs are pinned to commit `d004e6d47e9d25d0380c24b5a47b65a18f8b2784` (main, 2026-09-19).

[readme]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/README.md
[docs-readme]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/README.md
[pkg-json]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/packages/eve/package.json
[changelog]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/packages/eve/CHANGELOG.md
[getting-started]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/getting-started.mdx
[project-structure]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/concepts/project-structure.mdx
[agent-files]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/reference/agent-files.md
[agent-config]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/agent-config.md
[instructions]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/instructions.mdx
[skills]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/skills.mdx
[tools]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/tools/overview.mdx
[workflows]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/tools/workflows.mdx
[hitl]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/tools/human-in-the-loop.md
[connections]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/connections/overview.mdx
[connections-mcp]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/connections/mcp.mdx
[install-integrations]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/install-integrations.mdx
[extensions]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/extensions.md
[schedules]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/schedules.mdx
[dynamic-scheduling]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/patterns/dynamic-scheduling.md
[durability]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/concepts/execution-model-and-durability.mdx
[sessions]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/concepts/sessions-runs-and-streaming.md
[state]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/concepts/state.md
[security-model]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/concepts/security-model.md
[responsible-use]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/responsible-use.md
[self-hosting]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/guides/deployment/self-hosting.md
[deploy-overview]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/guides/deployment/overview.md
[cli]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/reference/cli.md
[ts-api]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/reference/typescript-api.md
[dev-tui]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/guides/dev-tui.md
[auth]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/guides/auth-and-route-protection.md
[eve-channel]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/channels/eve.mdx
[channels-overview]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/channels/overview.mdx
[github-channel]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/channels/github.mdx
[client]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/guides/client/overview.mdx
[frontend]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/guides/frontend/overview.mdx
[nextjs]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/guides/frontend/nextjs.mdx
[sandbox]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/sandbox.mdx
[memory-file]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/memory/file.md
[evals-overview]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/evals/overview.mdx
[evals-running]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/evals/running.mdx
[evals-targets]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/evals/targets.mdx
[ship-it]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/docs/tutorial/ship-it.mdx
[catalog]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/packages/eve-catalog/src/index.ts
[ci]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/.github/workflows/ci.yml
[src-openai-index]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/packages/eve/src/public/models/openai/index.ts
[src-transport]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/packages/eve/src/public/models/openai/chatgpt/transport.ts
[src-oauth]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/packages/eve/src/public/models/openai/chatgpt/oauth.ts
[src-chatgpt-auth]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/packages/eve/src/setup/flows/chatgpt-auth.ts
[src-credential-store]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/packages/eve/src/public/models/openai/chatgpt/credential-store.ts
[src-token-broker]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/packages/eve/src/public/models/openai/chatgpt/token-broker.ts
[src-broker-client]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/packages/eve/src/internal/model-auth/development-broker-client.ts
[src-deploy]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/packages/eve/src/setup/flows/deploy.ts
[src-auth-localdev]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/packages/eve/src/public/channels/auth.ts
[src-schedule-routes]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/packages/eve/src/internal/nitro/host/schedule-task-routes.ts
[src-cli-run]: https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/packages/eve/src/cli/run.ts
[npm]: https://www.npmjs.com/package/eve
[npm-world-local]: https://www.npmjs.com/package/@workflow/world-local
[gh-releases]: https://github.com/vercel/eve/releases/tag/eve%400.63.0
[eve-dev]: https://eve.dev/
[vercel-eve]: https://vercel.com/eve
[beta-terms]: https://vercel.com/docs/release-phases/public-beta-agreement
[nitro-tasks]: https://nitro.build/docs/tasks
