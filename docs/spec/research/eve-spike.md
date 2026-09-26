# P02 step 0 — eve run-mode spike (verbatim report)

Recorded by the orchestrator in iter-002 from the spike agent's reply, unedited below the rule. The spike ran in `/tmp/wc-eve-spike`, outside the repo, against `eve@0.63.0` pinned exactly. Decision rule: `mvp-spec.md` §8. Outcome: **mode A** (`eve build && eve start --host 127.0.0.1`), with the conditions listed under "Decision".

---

## P02 spike — 2026-09-22 (Opus)
Environment: macOS 26.6.2 arm64, Node 24.18.0, npm 11.16.0, eve 0.63.0, codex-cli 0.155.1
- **Where things are:** the project is left in place at `/tmp/wc-eve-spike/runner` (eve pinned, `.output/` built from the final config). The test driver is `/tmp/wc-eve-spike/spike.mjs` and raw logs are in `/tmp/wc-eve-spike/logs/`.
- **No sign-in was performed.** Codex already held a ChatGPT login, and eve used it through `codex app-server` in both modes.
- **Environment:** every eve command ran with `EVE_TELEMETRY_DISABLED=1 EVE_TRACES_CONTENT=off`.
- **Model use:** 4 trivial completed turns, 2 rejected calls, 1 model-list call.
- **Final spike config:**
  - `agent.ts`: `model: chatgpt("gpt-5.6-luna")`
  - `channels/eve.ts`: `[httpBasic({ username: "runner", password: process.env.ROUTE_AUTH_BASIC_PASSWORD }) when set, localDev()]`
  - `sandbox/sandbox.ts`: `defineSandbox({ backend: justbash() })`

### Outcome A — eve build && eve start (chatgpt(), httpBasic)
- **Build:** `eve build` exited 0 in about 5 s, with one warning: `nf3: could not resolve \`traceInclude\` entry "just-bash" from any root`.
- **Boot:** `eve start --host 127.0.0.1 --port 3210` answered `GET /eve/v1/health` with 200 `{"ok":true,"status":"ready","workflowId":"workflow//eve//workflowEntry"}` after 1.1–1.7 s.
- **Auth:**
  - No auth: `POST /eve/v1/session` returned 401 with `WWW-Authenticate: Basic realm="eve", charset="UTF-8"` and body `{"code":"unauthorized","error":"Authorization is required for this route.","ok":false}`.
  - Wrong password: the same 401. `localDev()` stayed inert under start.
- **Run 1, `chatgpt()` (default slug `gpt-5.6-luna-fast`):** failed.
  - Create: 202 `{"ok":true,"sessionId":"wrun_01M33R4Q6XWTWFXC7Z3DRPN8WR","status":"accepted"}`.
  - Stream (`x-eve-stream-version: 25`): `session.started → turn.started → message.received → step.started → step.failed → turn.failed → session.failed`.
  - Error on `step.failed`, `turn.failed` and `session.failed`: code `MODEL_CALL_FAILED`, `Model provider API request failed (HTTP 400): {"detail":"The 'gpt-5.6-luna-fast' model is not supported when using Codex with a ChatGPT account."}`.
  - Server log: `[eve:harness.tool-loop] tool-loop stream error { error: { message: 'AI_APICallError: Bad Request', … } }`, then `[eve:harness.tool-loop] Model provider API request failed (HTTP 400): {"detail":…} { errorId, sessionId, turnId, details: { statusCode: 400, upstreamStatusCode: 400, responseBodySnippet } }`.
  - Credentials resolved; the backend rejected the model slug.
- **Models this account accepts:** `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`. I got the list from eve's internal `availableHelperModels("chatgpt")`, the same call the `/model` picker makes.
- **Run 2, `chatgpt("gpt-5.6-luna")`:** passed.
  - Create: 202 `wrun_01M33R6V9VP2KWEZSKRWX8ZBG3`.
  - Stream: `session.started → turn.started → message.received → step.started → message.appended → message.completed → step.completed → turn.completed → session.waiting`.
  - Final text `pong` (`finishReason: "stop"`), `turn.completed` 1.6 s after attaching to the stream.
  - No error events. The server log had only `➜ Listening on: http://127.0.0.1:3210/` and `[START] server listening at http://127.0.0.1:3210/`.
- **A2 (cron):** passed.
  - Setup: `agent/schedules/spike-tick.md` (`cron: "* * * * *"`, body "Reply with exactly: tick"), rebuilt, started at 05:08:47Z.
  - At 05:09:00.024Z session `wrun_01M33R8VFGZNQZN22HVRHA2XRW` appeared in `.eve/.workflow-data/runs/` with no request from me.
  - Its stream, read with the Basic principal: `session.started → turn.started → message.received → step.started → message.appended → message.completed → step.completed → turn.completed → session.completed`, text `tick`.
  - The server logged nothing for the fire. The schedule file was deleted afterwards.

### Outcome B — eve dev --no-ui (chatgpt(), localDev)
- **Boot:** `eve dev --no-ui --host 127.0.0.1 --port 2000` answered health with 200 after 4.3–4.9 s. The password env var was unset, so the auth walk was `[localDev()]` and requests carried no auth header.
- **`chatgpt("gpt-5.6-luna")`:** 202 `wrun_01M33R9T3JYX7PFME7PXHZ6CCD`, the same event sequence as A run 2 ending in `session.waiting`, text `pong`, 1.9 s.
- **`chatgpt()` default:** the same 400 as in A (`'gpt-5.6-luna-fast' model is not supported when using Codex with a ChatGPT account`), ending in `session.failed`.
- **Dev trigger:** I added a test schedule `spike-devtick` (`cron: "0 0 1 1 *"`).
  - `POST /eve/v1/dev/schedules/spike-devtick` needed no auth and returned 200 `{"scheduleId":"spike-devtick","sessionIds":["wrun_01M33R9XGNB48JM0P49TNMW86M"]}`.
  - That session streamed `… turn.completed → session.completed` with text `tick` in 2.7 s.
  - An unknown id returned 404 `{"error":"Unknown schedule \"does-not-exist\". Available schedules: \"spike-devtick\".","availableScheduleIds":["spike-devtick"]}`.
  - The schedule was deleted afterwards.
- **Server log:**
  - `[eve:dev] 1 active local Workflow run(s) reference development generations that no longer exist (dpl_local@1.0.0). Their deliveries are quarantined; remove ".eve/.workflow-data" to discard the app's active local Workflow runs.`
  - `[world-local] Upgrading from version 1.0.0 to 5.0.0-beta.45`

### Decision per spec §8
Mode A: `eve build && eve start --host 127.0.0.1` with `httpBasic()` or a custom `AuthFn`. `chatgpt()` completed turns under `eve start` using the credentials Codex already owns, the auth walk failed closed, and a cron schedule fired and completed on its own. The §8 fallback (B plus a bridge-driven clock) is not needed; B gave the same results and remains a working fallback. A has three conditions:
- pin a model slug the account accepts, because the default was rejected;
- keep `codex` on the runner's PATH;
- run `eve extension build` before `eve build`.

### What init did
- **Run:** `npx -y eve@0.63.0 init runner` finished in 19.5 s with no TUI ("Creating agent... Installing dependencies... Initializing Git..."). It then printed an agent-handoff prompt ("# Build this eve agent with the user").
- **Tree:**
  - `.gitignore` (node_modules, .env*, .eve, .vercel, .next, .output, .nitro, dist, .DS_Store, *.tsbuildinfo), `.vercelignore`, `AGENTS.md`, `CLAUDE.md`, `README.md`, `package.json`, `package-lock.json`, `tsconfig.json`.
  - `agent/agent.ts` with `model: "openai/gpt-5.6-luna-fast"` (a Gateway string), `agent/instructions.md`, and `agent/channels/eve.ts` with `[vercelOidc(), localDev(), placeholderAuth()]`.
- **`package.json`:**
  - Dependencies: `@vercel/connect 2.2.0`, `ai ^7.0.105` (resolved 7.0.109), `eve ^0.63.0` (caret), `zod 4.5.4`.
  - Dev dependencies: `@types/node 24.x` (24.13.6), `typescript 7.0.2`.
  - Also `engines.node 24.x`, `imports` `#*`→`./agent/*` and `#evals/*`→`./evals/*`, and scripts build/deploy/dev/eval/start/typecheck.
- **tsconfig:** `moduleResolution: bundler`, `types: ["node","eve/workflow-modules"]`, `noEmit`; `tsc` 7.0.2 passes.
- **Package manager:** it installed with npm (invoked via npx in a bare directory). The detection order is in `dist/src/setup/package-manager.js`.
- **Git:** it ran `git init`, `checkout -b main`, `add -A` and committed `Initial commit from eve` as the ambient global git identity. `dist/src/cli/commands/init-git.js` skips all of this when `.git` exists, git is missing, or the target is inside a git/hg work tree. In the monorepo, no nested repo would be created.
- **Outside `runner/`:** nothing was written (no `~/.eve`, no `~/.config/eve`; only the npx cache).
- **Pin:** I changed eve to `"0.63.0"` and ran `npm install` ("up to date"); the lockfile root now reads `"eve": "0.63.0"`.

### Facts for the P02 skeleton (with doc paths)
- **`httpBasic`:** `httpBasic(credentials: { username: string; password: string }, options?: { realm?: string }): AuthFn<Request>` from `eve/channels/auth` (`dist/src/public/channels/auth.d.ts`).
  - It authenticates as `{ authenticator: "http-basic", principalId: username, principalType: "user" }` (`dist/src/channel/auth/http-basic.js`), with a constant-time comparison.
  - Route secrets "never land in compiled artifacts" (`docs/guides/auth-and-route-protection.md:222`). Verified: a canary password set at build time was absent from `.output/` and `.eve/`.
- **Custom `AuthFn`:** `type AuthFn<T = Request> = (event: T) => SessionAuthContext | null | undefined | Promise<…>`. `SessionAuthContext` is `{ attributes, authenticator, issuer?, principalId, principalType, subject? }` (`dist/src/channel/types.d.ts`).
  - For the paired device, return `{ attributes: {}, authenticator: "pairing", principalId: deviceId, principalType: "user" }`.
  - Returning `null` skips to the next entry. Throw `UnauthenticatedError` or `ForbiddenError` for 401/403.
  - `withAuthChallenges(fn, [{ scheme: "Bearer" }])` sets the challenge header (`docs/guides/auth-and-route-protection.md`, "The ordered auth walk" and "Custom verifiers").
- **`eveChannel`:** `eveChannel({ auth, cors?, audience?, trustedForwarders?, uploadPolicy?, turnPolicy?, onMessage?, events? })`.
  - `cors` is `true` or `{ origin, methods, allowedHeaders, exposedHeaders, credentials, maxAge, preflightStatus }`; if omitted, CORS is left untouched.
  - The health route is public (`dist/src/eve-channel/types.d.ts`, `docs/channels/eve.mdx`).
- **`eve/client`:** `new Client({ host, auth?: { bearer } | { basic: { username, password } } | { vercelOidc }, headers?, redirect? })`. The password may be a function; the docs advise `redirect: "manual"` on clients that carry credentials.
  - `client.health()` and `client.info()`.
  - Create: `const { session, response } = await client.sessions.create({ message })`.
  - Stream: `await response.result()` gives `{ status, message, events }`, or iterate live with `for await (const ev of response)`.
  - Follow up with `await session.send(text)`. Resume with `client.sessions.attach(id)` plus the saved `session.state` `{ sessionId, streamIndex }`.
  - Sends retry for up to 20 s (`docs/guides/client/overview.mdx`, `streaming.mdx`, `continuations.mdx`; `docs/concepts/sessions-runs-and-streaming.md`).
- **`defineTool`:** `defineTool({ description, inputSchema, outputSchema?, execute(input, ctx) })` from `eve/tools`; the file name is the tool name (`docs/tools/overview.mdx`).
- **`defineWorkflowTool`:** from `eve/tools`. `"use workflow"` must be the first statement of `execute`, and side effects go in `"use step"` functions (`docs/tools/workflows.mdx`).
- **`defineSchedule`:** `defineSchedule({ cron, markdown } | { cron, run({ to, waitUntil, appAuth }) })` from `eve/schedules`, or a `.md` file with `cron` frontmatter. The id is derived from the path, and markdown schedules cannot park (`docs/schedules.mdx`).
- **Extension:** `npx eve@0.63.0 extension init <name>` creates the package, installs it, and runs git init (`docs/extensions.md`).
  - Layout: `extension/{extension.ts,instructions.md,tools/,skills/*/SKILL.md,schedules/,lib/}`.
  - `package.json`: `"eve": { "extension": { "source": "./extension", "dist": "./dist/extension" } }`; `eve` as an exact devDependency plus a `"*"` peer, never in `dependencies`; `build` and `prepare` scripts are `eve extension build`.
  - Mount: `agent/extensions/jobs.ts` containing `export { default } from "<pkg>"` (or `pkg(config)`), with the package as a `"workspace:*"` dependency. Mounted names get a `jobs__` prefix (e.g. `jobs__capture_job`).
  - An extension cannot declare a sandbox, agent config or memory.
  - "Production `eve build` expects the extension distribution to exist already."
- **Evals:**
  - Files: exactly one `evals/evals.config.ts` (`defineEvalConfig({})`) plus `evals/*.eval.ts`, e.g. `defineEval({ async test(t) { await t.send("…"); t.succeeded(); t.calledTool("jobs__capture_job"); } })`.
  - Fixture agent: `model: mockModel(({ toolResults }) => toolResults.length === 0 ? { toolCalls: [{ name, input }] } : "done")`. The docs recommend a dedicated fixture agent, meaning its own app root.
  - Command: `eve eval --strict --junit .eve/junit.xml` boots a local dev server; exit codes are 0/1/2 (`docs/evals/overview.mdx`, `docs/evals/running.mdx`). I did not run it.
- **`justbash()`:** `import { justbash } from "eve/sandbox/just-bash"`. `just-bash` is an optional peer (`^3.1.0`) that only `eve dev` auto-installs (`docs/sandbox.mdx`).
  - The alternative is `defineAgent({ defaultTools: false })`, or `disableTool()` per tool (`docs/concepts/built-in-tools.md`).
  - `eve start` needed only the pin to boot: with `just-bash` absent it booted and completed turns that used no tools. A sandbox tool call was not exercised.
- **`.eve/` contents:**
  - After build: `agent-summary.json`, `builds/`, `locks/`; the server itself is `.output/server/index.mjs`.
  - After sessions: `.workflow-data/{runs,events,steps,streams,hooks,waits,version.txt}`. Each session creates two runs (`workflowEntry` and `sessionTimeoutWorkflow`).
  - `eve dev` adds `dev-hosts/`, `dev-runtime/{current.json,snapshots/}`, `dev-server-state.v1.json`, `dev-cleanup-intent.<uuid>.json` and `traces/v1/…`. `eve start` wrote no `traces/`.
  - Documented but not seen here: `discovery/`, `compile/`, `sandbox-cache/`, `evals/<ts>/`, `provider.json` (`docs/reference/cli.md`, `docs/sandbox.mdx`, `docs/guides/dev-tui.md`).
- **`.env.local`:** yes, `eve start` loads it.
  - Precedence: `.env.development.local` > `.env.local` > `.env.development` > `.env`, and variables already set in the process env win.
  - Source: `dist/src/cli/dev/environment.js`, called from `dist/src/cli/run.js` and `dist/src/internal/nitro/host/start-production-server.js`; the docs don't state it.
  - Verified: a password present only in `.env.local` got 200 on `GET /eve/v1/info`, and 401 without auth.
- **Process model:** `eve start` is a CLI parent that spawns `node .output/server/index.mjs`.
  - SIGTERM to the parent stops it gracefully with exit 0.
  - Killing the port listener instead makes the parent log `Built server process exited unexpectedly (code=143, signal=null).` and exit 1.
- **Doctor message when not signed in:** `ChatGPT subscription is not signed in to Codex. Run \`codex login\` or sign in from /login.`
  - The request path never launches `codex login`; only the TUI's `/login` does.
  - If the codex binary is missing (ENOENT), eve falls back to its own Keychain entry (`dist/src/public/models/openai/chatgpt/codex-app-server.js` and `token-broker.js`).

### Risks and surprises
- **Default model slug rejected:** the default `chatgpt()` slug was rejected in both modes. `chatgpt()`'s own type docs say availability is enforced per account (`dist/src/public/models/openai/index.d.ts`).
  - Pin an explicit slug and have doctor check it against `GET https://chatgpt.com/backend-api/codex/models`. That is what eve's internal `availableHelperModels` calls; it is not a public export.
  - A model error ends the whole session (`session.failed`), not only the turn.
- **Prompt text in server logs:** on a model-call failure the server printed the full request body (system prompt, tool schemas, user text) to stdout/stderr twice, even with `EVE_TRACES_CONTENT=off`. No auth headers or tokens were printed. Runner logs must be treated as personal data.
- **Session store is unencrypted:** `.eve/.workflow-data/{runs,events}/*.json` hold message content in plain JSON (`features.encryption: false`). Traces contained no content. Uninstall and the privacy docs must cover `.eve/`.
- **Don't alternate modes on one `.eve/`:** start stamps world version `1.0.0` and dev stamps `5.0.0-beta.45`. Each switch logs "Upgrading from …", and dev quarantined the session created under start.
- **`codex` must be on PATH:** under `eve start`, `chatgpt()` spawns `codex app-server --stdio` using the server's PATH. A launcher without `/opt/homebrew/bin` would fall back to eve's empty Keychain entry and get the sign-in error. A machine without Codex (eve's own `/login` path) was not tested.
- **Short scripts must stay alive:** eve `unref()`s the `codex app-server` child. A short script such as doctor must keep its event loop alive until the token call settles. My first model-list script exited with the await unsettled, and its app-server exited on its own once stdin closed.
- **Missing `just-bash` only warns at build:** with default tools on, a model call to `bash`, `read_file` or `write_file` under start would hit the missing backend. Either add `just-bash` with an exact pin or set `defaultTools: false`.
- **Cron fires are not announced:** I found no HTTP route that reports a cron fire; I detected it through `.eve/.workflow-data/runs/`. P08 needs a hook or the dispatcher pattern (`docs/patterns/dynamic-scheduling.md`) to record schedule outcomes.
- **Init leftovers to replace:** `@vercel/connect`, `.vercelignore`, `AGENTS.md`/`CLAUDE.md`, the Gateway-string model (which needs `AI_GATEWAY_API_KEY`) and `placeholderAuth()`. I did not re-check the `autoApprove`/`bypassMinimumReleaseAge` install flags noted in `logs/blocks.md`.

Final state: no eve, codex or spike processes are running; ports 3210 and 2000 are free. Port 3000 is the owner's `next-server` and was not touched. The worktree is unmodified.
