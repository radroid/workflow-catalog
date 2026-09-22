# @workflow-catalog/runner

The job-assistant runner: a pinned eve agent that runs on the person's own
computer with their own model provider, plus the **bridge**, a small HTTP
server on `127.0.0.1:4310` that the Chrome extension and the runner's local
UI talk to. Everything the runner keeps about the person is a file in their
workspace folder.

- eve **0.63.0**, pinned exactly (no caret) here, in the adapter and in the
  eval fixture. `npm run doctor` checks the pin. Bump deliberately, with the
  changelog open (mvp-spec §8).
- Node **24** or newer.
- Facts about eve come from `docs/spec/research/eve-runtime.md`,
  `docs/spec/research/eve-spike.md` and `node_modules/eve/docs`, never from
  memory.

## Run mode: A (`eve build` + `eve start`)

Decided by the P02 spike (`docs/spec/research/eve-spike.md`). `npm run
runner` builds when needed, then starts `eve start --host 127.0.0.1 --port
3210` and the bridge on `127.0.0.1:4310`. The person runs one command. In
mode A, eve fires cron schedules itself, and `chatgpt()` completes turns
with the sign-in that Codex owns.

Mode A holds only under four conditions, and the runner enforces each:

1. **An explicit model slug the account accepts.** eve's default,
   `gpt-5.6-luna-fast`, is rejected for ChatGPT accounts. Setup records a
   slug (it suggests `gpt-5.6-luna`), and `doctor` reports whether it was
   verified.
2. **`codex` on eve's PATH.** `chatgpt()` spawns `codex app-server` from
   the server's PATH. Setup records codex's directory as `RUNNER_CODEX_DIR`,
   and the launcher puts it first on eve's PATH.
3. **The adapter builds before the agent.** `eve extension build` runs
   before `eve build`; the launcher does both.
4. **One mode per `.eve/` directory.** Never alternate modes on it: do not
   run `eve dev` inside `runner/`.

Mode B (`eve dev --no-ui`, with the bridge triggering schedules) passed the
same test and stays the fallback.

eve reads the model at runtime (`agent/lib/model.ts`), but its build also
records the model id as metadata, so the launcher rebuilds whenever the
provider or model differs from the last build (a stamp in `.output/`). The
stamp also covers every source the build reads (`lib/build.ts`
`buildInputsFor`):

- `agent/`, `lib/` and `store/`
- the adapter source and the package skills
- `packages/contracts/src/`
- the manifests and `pnpm-lock.yaml`

So a `git pull` that changes any of them rebuilds on the next start.

## Install

The runner is used from a **whole-repo clone**:

Node 24 is the tested version and ships with Corepack. On Node 25 or newer,
run `npm install -g corepack` first.

```sh
git clone https://github.com/radroid/workflow-catalog.git
cd workflow-catalog
corepack enable          # provides the pinned pnpm
pnpm install --frozen-lockfile
cd runner
npm run setup
npm run runner
```

Why not `npx degit radroid/workflow-catalog/runner` plus `npm install`: the
runner depends on `@workflow-catalog/contracts` and the eve adapter through
`workspace:*`, which only a pnpm workspace resolves. It would also produce a
second lockfile. A clone keeps one lockfile, installs exactly the tested
versions, and makes `git pull && pnpm install` the upgrade path.

## Scripts

Run them inside `runner/` as `npm run <script>`, or from anywhere in the repo
as `pnpm --filter @workflow-catalog/runner <script>`. In `runner/` with pnpm,
write `pnpm run setup`: a bare `pnpm setup` is pnpm's own command.

| Script | What it does |
|---|---|
| `setup` | Checks Node 24, chooses the workspace, connects the provider, writes `runner/.env.local`, prints a pairing code. Asks questions in a terminal; `--yes` never asks. |
| `setup -- --forget` | Lists, then removes, everything the runner stored (see Uninstall). `--dry-run` only lists; `--keep-workspace` keeps your data. |
| `doctor` | The install checklist. `--json` for machines, `--live` to verify the model with one short call. Exits 1 while a required item fails. |
| `runner` | Builds when needed, then starts eve and the bridge on loopback. Ctrl-C, SIGTERM or closing the terminal (SIGHUP) stops both, even during startup (`lib/launcher.ts`: route modules load and the bridge is built before eve is spawned, so a startup failure never leaves eve running). |
| `pair` | A new pairing code (10 minutes, single use). |
| `ui` | A new one-time sign-in link for the local UI. |
| `eval` | `eve eval --strict` on the fixture agent (no model, no credentials). |
| `test` | The unit tests (vitest), then the eval. |
| `typecheck`, `lint` | As everywhere in the repo. |

Flags go after `--`: `npm run setup -- --workspace ~/JobAssistant`. The boolean flags
`--json`, `--live`, `--forget`, `--dry-run` and `--keep-workspace` also work
without `--` (`npm run doctor --json`), because npm hands them over as
`npm_config_*`. Value flags must come after `--`, since npm has settings named
`workspace`, `provider` and so on.

### Setup

```sh
npm run setup                                    # interactive
npm run setup -- --workspace ~/JobAssistant --provider chatgpt --model gpt-5.6-luna --yes
npm run setup -- --provider openai --model <slug> --api-key-env MY_KEY_VAR --yes
```

- **Workspace.** The default is `~/JobAssistant`. Setup creates an empty
  folder, or reopens one that already has a valid `workspace.json`. It
  refuses a folder with other files in it, the disk root, your home folder
  itself, and anything inside this repository.
- **Provider.** One of `chatgpt`, `openai`, `anthropic` or `gateway`.
  - **ChatGPT:** Codex owns the sign-in (`codex login`) and the runner
    stores no ChatGPT credential. Setup runs `codex login status` and
    explains what to do if Codex is missing or signed out. The Codex sign-in
    is the only way in: under `eve start`, `chatgpt()` uses the credentials
    Codex keeps (`docs/spec/research/eve-spike.md`). eve's own `/login`
    lives in `eve dev`, which never runs in `runner/` (condition 4 above).
  - **API keys:** stored in the OS keychain (macOS Keychain, or Secret
    Service on Linux) under the service `workflow-catalog-runner`, never
    in a file. Under `eve start`, eve reads a provider key only from its
    environment (`eve/dist/src/internal/model-auth/api-key.js`), so
    `npm run runner` hands the key to the eve process in memory.
- **`runner/.env.local`** (mode 0600, gitignored; eve loads it too):
  - `EVE_TELEMETRY_DISABLED=1` and `EVE_TRACES_CONTENT=off`
  - `RUNNER_MODEL_PROVIDER` and `RUNNER_MODEL`
  - `RUNNER_CODEX_DIR`
  - `RUNNER_WORKSPACE`
  - `ROUTE_AUTH_BASIC_PASSWORD`: the per-install secret for eve's
    `httpBasic` route auth
  - `RUNNER_UI_TOKEN`: the local-UI cookie value

  A variable set in the environment wins over the file, as in eve.
- **Re-running** keeps the workspace, the stored key and both secrets. It
  updates only what you change.

### Doctor

It has seven items, all required:

- The catalog install page's five, with the same ids and labels:
  `node`, `runner`, `provider`, `workspace` and `extension`.
- `privacy`: the two eve switches.
- `eve`: the exact pin.

Each item is `ok`, `warn` or `fail`. A `warn` is not a failure: a provider
that is connected but not yet verified is a warn until `doctor -- --live`,
or "Check the model" on the status page, gets an answer. The JSON form is
`{ ok, checkedAt, items: [{ id, label, status, detail, required, fix? }] }`.

## The bridge (`server/`)

Hono on `127.0.0.1:4310`, loopback only. The extension talks only to the
bridge. The bridge talks to eve server-side with `eve/client`, using Basic
auth. The extension-facing routes are exactly these four (mvp-spec §5):

| Route | Body / answer |
|---|---|
| `POST /pair` | `PairRequest` → `PairResponse` `{ deviceId, token }` |
| `GET /commands?since=` | `CommandsResponse`: the device's pending `open_application_group` commands, leased for 5 minutes |
| `POST /events` | `EventsRequest` (`job_capture`, `browser_command_result`, `application_status_changed`) |
| `GET /status` | `StatusResponse` `{ version, workspaceId, budget, schedules }` (no personal data) |

Each request passes these checks in order, and the first failure answers:

1. **Host.** It must be exactly `127.0.0.1:4310` or `localhost:4310`,
   else **403** `host_not_allowed`. This is the defence against DNS
   rebinding.
2. **Route.** An unknown route or method gets **404**.
3. **Declared size.** A `Content-Length` over 256 KiB
   (`MAX_BRIDGE_BODY_BYTES`) gets **413**, before a byte is read.
4. **Token.** It must be `Authorization: Bearer <device token>`, else
   **401** with `WWW-Authenticate: Bearer`. The bridge stores token hashes
   only. Tokens last 30 days.
5. **Origin.** Chrome sends no `Origin` on an extension's GET (from its
   pages, its service worker and alarm-driven fetches alike; measured on
   Chromium 153), and sends `Origin: chrome-extension://<id>` on its POST.
   So:
   - A GET (or HEAD) with no `Origin` is accepted on the device token alone.
   - An `Origin` that is present must equal the origin the device paired
     from, else **403** `origin_not_allowed`.
   - A POST must carry that origin, else **403** (`origin_required` when it
     is missing).
6. **Content type.** It must be `application/json`, else **415**.
7. **Streamed size.** More than 256 KiB of body gets **413**, counted as it
   streams, whatever the declared length said.
8. **Contract.** The JSON is validated with the `@workflow-catalog/contracts`
   schema. A failure gets **400** `invalid_body`, with every zod issue and its
   `path`.

Identity comes from the token: events carry no `deviceId`, by design.

- **Pairing.** `setup`, `pair` and the status page issue a code like
  `7KQ2M-X9RTB`. It is 10 characters of Crockford base32 (about 50 bits),
  lasts 10 minutes and works once. Only its hash is stored. `/pair` accepts
  only a `chrome-extension://<32 letters a-p>` origin, which becomes the
  device's origin. Wrong codes are limited two ways:
  - **Per origin, for fairness.** After 10 wrong codes in 10 minutes from
    one origin, `/pair` answers that origin 429, so another extension's
    wrong codes never lock this one out.
  - **Per code, for security.** A local process can send any extension
    origin, so the per-origin limit alone does not bound guessing. Once 100
    wrong codes, from any origins, have been tried since a code was issued,
    that code is withdrawn: even the right code then gets 401.
    `npm run pair` issues a new code, with a fresh budget.

  Revoking a device (status page, or `POST /api/devices/<id>/revoke`)
  deletes it, and its token fails on the next request.
- **Replay.** Every event is journaled once per `eventId`
  (`.runner/events/`), using an exclusive create. A replay gets the stored
  outcome back with `duplicate: true`, and its handler does not run again.
  The same `eventId` with a different body, or from another device, is
  **409** `event_id_conflict`. Only a handler that failed unexpectedly runs
  again, when the extension retries.
- **Event status codes.** With no handler for its type, an event is
  journaled and acknowledged with **202**. A handled event gets **200**,
  with the handler's `result`. A handler's rejection gets its own 4xx.
- **CORS.** CORS is not authentication. Preflights and responses carry
  `Access-Control-Allow-Origin` only for the paired extension origin; for
  `/pair`, for any well-formed extension origin.

## The local UI (`ui/`, `server/local-ui.ts`)

Plain HTML pages with small scripts and no framework, at
`http://127.0.0.1:4310/ui/<page>`. `/` redirects to `/ui/status`. Any web
page the person visits can send requests to 127.0.0.1, so the UI and its
JSON API are protected as follows:

- **Host check.** The same check as above, so DNS rebinding fails.
- **Sign-in.** `npm run runner` prints a one-time link,
  `/ui/login?nonce=…`, and `npm run ui` prints a fresh one. A link lasts 10
  minutes and works once. A HEAD request does not use it up. It sets the
  cookie `wc_runner_ui` (HttpOnly, SameSite=Strict, Path=/, 30 days). Every
  page and every `/api/*` route needs that cookie.
- **Same-origin API.** When the browser sends `Sec-Fetch-Site`, `/api/*`
  answers only `same-origin`, which is what the runner's own pages send.
  - `cross-site` and `same-site` are refused. Cookies are not scoped by
    port, so a page on another port of 127.0.0.1 is "same-site" and would
    otherwise carry the cookie.
  - `none` is refused too. Chrome sends the SameSite=Strict cookie with a
    fetch from any extension that has host permission for the bridge, and
    marks it `none` (measured on Chromium 153).
  - Pages and the sign-in link are navigations, so they keep working with
    `none` (a link opened from the terminal, or a typed address).
- **State changes.** Any request other than GET and HEAD also needs an
  `Origin` equal to the bridge's own origin and a JSON `Content-Type`,
  which an HTML form cannot send.
- **Headers.**
  - Every response: `X-Content-Type-Options: nosniff`,
    `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`.
  - Pages also get a CSP that allows only the bridge's own scripts, styles
    and fonts, with `frame-ancestors 'none'`.

The **status page** (`ui/status.html`) shows:

- the doctor checklist
- the model, with "Check the model"
- the paired browsers, with Revoke and "New pairing code"
- the workspace

There is no Settings page yet. Revocation (mvp-spec §7.5) lives here until
one exists. Fonts are Geist, self-hosted (`ui/assets/fonts`, SIL OFL).

## Workspace layout

The spec §5 layout, plus `.runner/` for the bridge's own state:

```text
workspace.json    { workspaceId, workflowInstanceId, packageVersion, createdAt }   (WorkspaceManifest)
sources/ jobs/ applications/ sessions/ runs/ outbox/ inbox/
.runner/devices/<deviceId>.json         paired devices (token hash, origin, expiry)
.runner/pairing/<sha256>.json           outstanding pairing codes
.runner/ui-login/<sha256>.json          outstanding UI sign-in links
.runner/events/<eventId>.json           the event journal (holds captured job text: personal)
.runner/commands/<commandId>.json       the command queue for GET /commands
.runner/model-check.json                the last live model check (no prompt or reply text)
```

Every write is atomic: the store writes a temp file in the same folder,
fsyncs it, renames it over the target, then fsyncs the folder. Every path
goes through `Workspace.resolve`, which refuses `..`, absolute paths, NUL
bytes and symlinks that lead out of the workspace.

## Extending the runner

Later packets add behaviour by **adding files**. They never edit the files
P02 wrote. Four conventions:

**1. Route modules: `server/routes/<name>.ts`.** The bridge loads every
file in `server/routes/` at start, in name order, and skips `_helpers.ts`
and `*.test.ts`. Each file default-exports:

```ts
import { defineRouteModule, EventRejectedError } from "../route-modules.ts";

export default defineRouteModule({
  // Local-UI JSON routes, mounted at /api/<name>, already behind the
  // local-UI guard (Host, cookie, same-origin). Read bodies with
  // readBoundedJson from ../http.ts and a cap that suits the route.
  api(router, ctx) {
    router.get("/", async (c) => c.json({ ok: true }));
  },
  // POST /events handlers, one module per type (two claiming one type is
  // a startup error). The event is already authenticated, contract-valid
  // and journaled; the return value is stored and sent back as `result`.
  events: {
    job_capture: async (event, ctx) => {
      // ctx.device is the paired device; ctx.workspace, ctx.journal, ctx.commands...
      // Throw new EventRejectedError(409, "stale_revision", "...") to refuse with a 4xx.
      return { jobId: "..." };
    },
  },
  // Budget and schedules for GET /status.
  status: async (ctx) => ({ budget: { dailyRunLimit: 20, runsUsedToday: 0, paused: false }, schedules: [] }),
  // Runs once when the bridge starts (after eve is ready); may return a stop function.
  start: async (ctx) => () => {},
});
```

`ctx` (`server/context.ts`) holds:

- `workspace`, `clock`, `log`
- the stores: `devices`, `pairing`, `uiLogin`, `journal`, `commands`
- `eve`: the `eve/client` gateway; undefined in tests
- `model`, `packageVersion`

Log operational lines only, never content.

**2. Stores: `store/<domain>.ts`.** Write one module per domain, on top of
`Workspace` (`readJson`, `writeJson`, `createJson`, `list`, `resolve`) and
the atomic helpers. Validate with the contracts when reading and writing.

**3. Pages: `ui/<page>.html`.** Shared styles and helpers are in
`ui/assets/runner.css` and `ui/assets/runner.js` (`getJson`, `postJson`,
`el`). Put `<!-- runner:nav -->` where the navigation goes. The planned
pages (onboarding, profile, jobs, board, sessions, runs, settings, status)
join the nav on their own. Any other page joins it with
`<meta name="runner-nav" content="Label">`. Scripts must be files under
`ui/assets/`, because the CSP allows no inline script.

**4. Model tools: `agent/tools/<name>.ts`.** Write each as a `defineTool`,
thin, with typed input. Pass IDs, never raw content or URLs.
`defaultTools: false` stays: add only the tools you need. Every prompt
change ships with a fixture that proves it (`eval-agent/`).

| Packet | Adds |
|---|---|
| P03 | `server/routes/onboarding.ts`, `store/profile.ts`, `ui/onboarding.html`, `ui/profile.html`, `agent/tools/extract_claims.ts`, `agent/tools/ask_follow_up.ts`, onboarding skills |
| P04 | `server/routes/captures.ts` (the `job_capture` handler), `store/jobs.ts`, `agent/tools/import_job_url.ts`, `ui/jobs.html` |
| P05 | `agent/tools/prepare_application.ts`, `store/applications.ts`, `validate/`, `export/`, `ui/application.html`, preparation skills |
| P06 | `server/routes/{applications,sessions,commands}.ts` (the `application_status_changed` and `browser_command_result` handlers), `store/sessions.ts`, `ui/board.html`, `ui/sessions.html`, and the body of `agent/tools/open_application_group.ts`. The tool queues commands through the workspace files (see "Commands" below); the `browser_command_result` handler retires them with `ctx.commands.acknowledge()`. |
| P07-B | Nothing here. The extension uses the four bridge routes. |
| P08 | `agent/schedules/`, `store/runs.ts`, `scheduler/`, `ui/runs.html`, the schedules and budget sections of `ui/settings.html`, and `server/routes/runs.ts` for `status()` (budget, schedules) and `start()` (catch-up). |
| P10 | `upgrade/`, the upgrade section of `ui/settings.html`, and an optional `server/routes/upgrade.ts`. |

**Commands.** `GET /commands` is already complete over
`store/commands.ts`. P06 only has to fill the queue and acknowledge
commands.

- It is device-scoped, and never delivers an expired command.
- A delivery leases the command for 5 minutes. A command still
  unacknowledged when its lease lapses is delivered again, whatever `since`
  says, so a service worker that dies holding a command cannot strand it.
- `since` only narrows commands never delivered: they must be created at or
  after it. Omitting `since` is always safe, because the lease already keeps
  one command from being handed out twice at once.
- `HEAD /commands` is checked like a GET but leases nothing.

`open_application_group` runs inside eve's process (`eve start`), not the
bridge's, so there is no `ctx` and no `ctx.commands` there. The tool
enqueues through the workspace files, with the same store:
`new CommandQueue(await Workspace.open(process.env.RUNNER_WORKSPACE), systemClock).enqueue(command)`.
eve's process has `RUNNER_WORKSPACE`, because the launcher passes the
settings in its environment. This is safe across processes:

- An enqueue only creates a new file, exclusively (`link(2)`), which appears
  whole.
- Only the bridge leases and acknowledges, serialised in its one process.

## Privacy

- **Runner output is personal data.**
  - The runner writes no log files. eve's output is prefixed `[eve]` and
    goes to the terminal only.
  - A failed model call prints its whole request to that output (spike), so
    do not paste it anywhere public.
  - The bridge logs operational lines only, never content.
- **`.eve/` is personal data.** eve keeps session state in
  `.eve/.workflow-data`, and the message content in it is unencrypted
  (spike). It is gitignored, never shared, and removed by uninstall.
- **eve's privacy switches.** Setup turns off eve's CLI telemetry
  (`EVE_TELEMETRY_DISABLED=1`) and trace content (`EVE_TRACES_CONTENT=off`),
  and `doctor` checks both.
- **Provider keys** are kept only in the OS keychain.
- **The workspace** is a folder the person owns: plain JSON files they can
  read and delete.

## Uninstall

`npm run setup -- --forget` lists what the runner stored, then removes it
after a confirmation (or with `--yes`):

- `runner/.env.local`
- `runner/.eve/`, `runner/.output/`, `runner/.nitro/`
- `runner/eval-agent/.eve/` and `.output/`
- the workspace folder, but only when its `workspace.json` is valid
  (`--keep-workspace` keeps it)
- the runner's keychain entries

It also lists **eve's own sign-in**, which is shared by every eve project on
the computer, and asks separately before removing it (default no). `--yes`
never removes it; only an answer in a terminal does:

- the keychain entries under service `eve`: `chatgpt`, `openai-key`,
  `anthropic-key`, `ai-gateway-key`, `vercel`
- `~/.eve/connection.json` and `~/.eve/auth/chatgpt.json`

The Codex CLI's ChatGPT sign-in belongs to Codex; remove it with
`codex logout`. After `--forget`, deleting the repository folder leaves
nothing behind.

## Tests and the eval

- `npm test` runs the vitest suites in `test/`, then `npm run eval`.
  - The vitest suites cover the stores, the bridge, pairing, the local UI,
    route modules, setup, doctor, uninstall and the keychain encoding.
  - It needs no codex, no model call and no credentials, so it runs in CI.
- `npm run eval` builds the adapter, then runs `eve eval --strict` on
  `eval-agent/`: a separate eve app root with `mockModel` and the real
  adapter, tools and sandbox. Its evals prove four things:
  - The tool surface is exactly `load_skill` plus `open_application_group`,
    with no shell, file or web tools.
  - The data rule is in the system prompt.
  - A `jobs__*` skill loads.
  - `open_application_group` parks with an approval request instead of
    executing, and calls to tools that do not exist fail without running
    anything.
- `eve eval` always starts its own development server on 127.0.0.1 with an
  ephemeral port (`eve/dist/src/evals/cli/eval.js`). The port cannot be set,
  and the server stops with the eval.

## Files

```text
agent/            the eve agent: agent.ts, instructions.md, channels/eve.ts (httpBasic, then localDev),
                  extensions/jobs.ts (the adapter), sandbox/sandbox.ts (refuses to create one),
                  tools/ (load_skill, open_application_group), lib/ (model and agent options)
eval-agent/       the eval fixture: its own eve app root on mockModel, with evals/
server/           the bridge: app.ts, extension-api.ts, events.ts, local-ui.ts, route-modules.ts,
                  context.ts, eve-gateway.ts, http.ts, routes/ (status, devices, pairing, model)
store/            the workspace and the runner's own stores
lib/              settings, the .env.local file, secrets, codex, doctor, setup, uninstall, builds, the launcher
cli/              the npm scripts
ui/               the local UI pages and assets
test/             vitest suites and fixtures
```
