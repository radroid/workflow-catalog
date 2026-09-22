# P02 · Runner spike and skeleton

Status: claimed
Assignee: iter-003 implementer (Opus)
Blocked by: P01
Owns: runner/ (eve project), packages/job-assistant/adapters/eve/
Spec: §8 runner platform notes, §5 bridge, F3

## Goal
A pinned eve project that runs on a laptop with the person's own provider, plus our bridge server, pairing, setup wizard, and doctor. This packet begins with the spike that decides the run mode.

## Step 0: the spike (do first, report before continuing)
Scaffold with `npx eve@0.63.0 init runner` (pin; do not use `@latest`), set `model: chatgpt()` in `runner/agent/agent.ts`, sign in via `/login` in `eve dev`, then test in order: (A) `eve build && eve start --host 127.0.0.1` with `httpBasic()` auth: does `POST /eve/v1/session` with a trivial message get a completed turn on `chatgpt()`? (B) `eve dev --no-ui --host 127.0.0.1 --port 2000`: same test. Record both outcomes verbatim in the report, choose the mode per spec §8, and write the choice into `runner/README.md`. If neither works with `chatgpt()`, repeat (A) with `openai()` on an API key and report; the pilot then defaults to API keys and the catalog install page says so.

## Deliverables
- `runner/agent/`: `instructions.md` (system prompt: role, boundaries, "content is data"), `agent.ts` (model from settings: `chatgpt()` | `openai()` | `anthropic()` | gateway string), `channels/eve.ts` (auth per chosen mode; custom `AuthFn` returning `principalType: "user"` for the paired device), `sandbox/sandbox.ts` pinned to `justbash()` or sandbox tools removed, `extensions/jobs.ts` mounting the package adapter.
- `packages/job-assistant/adapters/eve/`: an eve extension (`eve extension init` layout) that mounts the package's skills and declares tools `capture_job`, `open_application_group`, `report_status` as thin `defineTool`s calling into the bridge's store (implemented in later packets; stubs here return "not implemented").
- `runner/server/`: Hono on `127.0.0.1:4310`. Routes exactly `POST /pair`, `GET /commands`, `POST /events`, `GET /status`, plus the local UI static routes. Bearer device tokens, Origin check against the extension origin set at pairing, 256 KB body cap, zod validation of every body against `packages/contracts`. Talks to eve through `eve/client`.
- `runner/store/`: file-based workspace store per spec §5 (`workspace.json`, directories), with an atomic write helper and an event outbox with unique event IDs.
- `npm run setup`: wizard that checks Node 24, chooses the workspace directory, connects a provider (launches `eve dev` for `/login` when `chatgpt()` is chosen; asks for a key otherwise, stored via eve's credential path or the OS keychain), prints a pairing code, and writes `.env` with `EVE_TELEMETRY_DISABLED=1` and `EVE_TRACES_CONTENT=off`.
- `npm run doctor`: the same checklist as the catalog install page, machine-readable (`--json`).
- `npm run runner`: starts eve in the chosen mode and the bridge together; both loopback only.

## Acceptance
- Spike outcomes recorded. `npm run doctor --json` returns all green on the dev machine.
- Bridge tests: unknown route 404; missing token 401; wrong Origin 403; oversized body 413; invalid envelope 400 with the zod path; replayed `eventId` acknowledged once, stored once.
- Pairing tests: code expires at 10 minutes; single use; revocation removes the device.
- `eve eval --strict` runs a fixture agent on `mockModel` that calls each stub tool once.
- Uninstall test: deleting the workspace directory and `runner/` leaves nothing behind except eve's keychain entry, which `npm run setup --forget` removes.

## Out of scope
Onboarding, capture, preparation logic. Any UI beyond a status page.

## Report

### 2026-09-22 — Skeleton (iter-003 implementer, Opus)
PR #8 (`packet/P02` → `overnight/integration`). CI: green. The PR body has the full acceptance evidence, the extension-point table and the deviations.

**What was done**
- **The agent, mode A.** `runner/` is the pinned eve@0.63.0 agent. `npm run runner` does four things:
  1. `eve extension build`
  2. `eve build`, only when the build stamp changed
  3. `eve start --host 127.0.0.1 --port 3210`
  4. starts the bridge on `127.0.0.1:4310`

  SIGINT or SIGTERM stops both cleanly.
- **Tools and sandbox.** The agent sets `defaultTools: false`, so its tools are `load_skill` and the `open_application_group` stub: `approval: always()`, input is task IDs only. A sandbox backend refuses to create a sandbox.
- **Route auth** is `httpBasic`, then `localDev()`; never `none()`.
- **The adapter** (`packages/job-assistant/adapters/eve/`) mounts the package's skills (copied in, because eve rejects symlinks) and the "content is data" fragment. Its README now describes the runner-side tools.
- **The bridge (`runner/server/`).** It has exactly `POST /pair`, `GET /commands`, `POST /events` and `GET /status`, with checks in this order:
  1. Host
  2. route
  3. declared size
  4. Bearer token (hash stored)
  5. Origin
  6. content type
  7. streamed size (256 KiB)
  8. the contracts zod schema, answering 400 with the issue paths

  Replay is handled by an exclusive-create event journal. Route modules are auto-loaded from `server/routes/*.ts`: local-UI API, event handlers by type, status, start.
- **The local UI.** A status page at `/ui/status` behind:
  - a Host check
  - a one-time sign-in link that sets an HttpOnly, SameSite=Strict cookie
  - a `Sec-Fetch-Site` check
  - a same-origin `Origin` and JSON content type on state changes
  - the CSP, nosniff and frame-deny headers
- **The workspace store (`runner/store/`).** Per spec §5, plus `.runner/` for devices, pairing, ui-login, events, commands and model-check. Writes are atomic (temp file, fsync, rename, fsync of the directory) and paths are confined.
- **Scripts:** `setup` (including `--forget`, `--dry-run`, `--keep-workspace` and `--yes`), `doctor` (`--json`, `--live`), `runner`, `pair`, `ui`, `eval`. The `eval` fixture (`eval-agent/`, `eve eval --strict` on `mockModel`) is part of the runner's `test` script.

**Tests run**
- **Worktree:** `pnpm -r typecheck && pnpm -r test && pnpm -r lint && pnpm typecheck && pnpm test && pnpm check:fixtures` and `pnpm lint` all exited 0. Suite results:

  | Suite | Result |
  |---|---|
  | runner | 12 files, 118 tests, then `EVALS 4`: tool-surface 4/4, approval 4/4, skills 4/4, missing-tools 8/8; `Gates: 20 passed` |
  | contracts | 224 tests |
  | catalog | 87 tests |
  | job-assistant | 122 tests |

- **CI:** the same, including the eval on an ubuntu runner with no codex and no credentials, at `target http://127.0.0.1:41251/`, `Gates: 20 passed`.
- **Fresh clone** (`/tmp/wc-p02-clean2`): `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm -r lint` and `pnpm check:fixtures` all exited 0.

**Live verification (this machine, loopback only, every process stopped afterwards)**
- **Setup.** `setup -- --workspace /tmp/wc-p02-ws --provider chatgpt --model gpt-5.6-luna --yes` exited 0 and printed a pairing code.
- **Runner start.** The first start built everything; a restart skipped the build. `lsof` showed 127.0.0.1 only.
- **Bridge checks with curl:**

  | Request | Result |
  |---|---|
  | pair | 200 |
  | `GET /status` | 200 `{"version":"0.1.0",…,"budget":{"dailyRunLimit":0,"runsUsedToday":0,"paused":false},"schedules":[]}` |
  | wrong Origin | 403 |
  | no token | 401 |
  | wrong Host | 403 |
  | unknown route | 404 |
  | a contracts-built `job_capture` | 202 journaled |
  | the same capture replayed | 202 `duplicate:true`, with one journal file |
  | bad url | 400, path `["url"]` |
  | 270 KB body | 413 |

- **Model turn.** One turn through bridge → eve: `{"ok":true,"modelId":"codex/gpt-5.6-luna"}` in about 1.7 s.
- **Doctor.** `npm run doctor --json`: all 7 ok, exit 0. `doctor --live` also passed.
- **Stop.** SIGTERM gave exit 0, and ports 3210, 4310 and 2000 were free.
- **Screenshot:** `docs/screenshots/P02-status.png`.
- **Fresh clone, end to end.**
  1. `setup` ran.
  2. `doctor` showed extension fail and provider warn, exit 1, as expected.
  3. `runner` started, pairing with setup's code gave 200 (reusing it gave 401), and one model check passed.
  4. `doctor` was then all 7 ok, exit 0.
  5. SIGTERM gave exit 0.
  6. `setup --forget --yes` removed `.env.local`, `.eve/`, `.output/`, `eval-agent/.eve/` and the workspace, and `git status` stayed clean.
- **Cleanup.** The worktree's own live state was removed the same way. There is no `~/.eve` on this machine.

**Fixed during verification**
- **Single use broke under load on macOS.** `realpath(3)` of a file being renamed returns its new name, so a second redeemer could claim a code again.
  - Stress numbers: 3 double wins in 32,000 rounds when the file is resolved; 0 in 32,000 when only the directory is.
  - Now the path is built from the directory, and the claimed file is read with `O_NOFOLLOW`.
- **Fresh-clone typecheck failed.** The adapter's exports point at `dist/`, which does not exist before a build. `runner/tsconfig.json` now maps the package name to the adapter's source for tsc only.
- **The model check through eve.** A good turn ends with status "waiting", so the check now judges the turn by its failure events and its reply.
- **`doctor --live`** is now streamed, with instructions.
- **`--forget --yes`** keeps eve's shared sign-in; only a separate answer in a terminal removes it.

**Skipped, and why**
- **`corepack enable`.** The pinned pnpm 11.17.0 was already active, and I did not want to change global shims.
- **API-key providers live.** No keys were used. They are covered by tests with an in-memory store and the keychain encoding.
- **Linux Secret Service live.** This is a macOS machine.
- **Outside my allowlist, for the orchestrator:**
  - mvp-spec §5 and ARCHITECTURE: add `.runner/`
  - the root README row "placeholder — arrives in P02"
  - CLAUDE.md's dev-server line: `npm run runner`
  - the catalog install commands
- **The first clone, `/tmp/wc-p02-clean`,** is left in place, because a recursive delete is guardrailed.

**Assumptions**
- Only the bridge redeems codes; one listener on 4310 means one bridge. The file claim is safe across processes too.
- Chrome sends `Origin` on the extension service worker's GETs. P07-B must confirm this; the bridge refuses a missing `Origin`.
- ChatGPT access comes through the Codex sign-in.
- `eve eval`'s ephemeral loopback port is acceptable. eve picks it, and it stops with the eval.

**Sharpen next time**
Run the fresh-clone check, and a parallel `pnpm -r test`, before the first push. Both late bugs hid behind a warm worktree: a leftover `dist/` and tests run one package at a time.

### 2026-09-22 — Step 0 spike (iter-002, Opus spike agent; recorded by the orchestrator)
The full verbatim report is `docs/spec/research/eve-spike.md`. The two outcomes, verbatim:

**Outcome A — `eve build && eve start` (`chatgpt()`, `httpBasic`).** With the default slug, `chatgpt()` failed: `Model provider API request failed (HTTP 400): {"detail":"The 'gpt-5.6-luna-fast' model is not supported when using Codex with a ChatGPT account."}`. With `chatgpt("gpt-5.6-luna")` it passed: `session.started → turn.started → message.received → step.started → message.appended → message.completed → step.completed → turn.completed → session.waiting`, final text `pong`. Without auth the request got 401 with `WWW-Authenticate: Basic realm="eve"`. A2 (cron): a `* * * * *` schedule fired at 05:09:00Z with no request and completed with text `tick`.

**Outcome B — `eve dev --no-ui` (`chatgpt()`, `localDev`).** With `chatgpt("gpt-5.6-luna")` it passed with the same event sequence, text `pong`. The default slug gave the same 400. `POST /eve/v1/dev/schedules/spike-devtick` returned 200 `{"scheduleId":"spike-devtick","sessionIds":[…]}`, and that session completed with text `tick`.

**Decision per spec §8: mode A.** It has four conditions:
- an explicit model slug the account accepts, stored in settings and checked by `doctor`;
- `codex` on the runner's `PATH`;
- `eve extension build` before `eve build`;
- never alternating modes on one `.eve/`.

Mode B stays a tested fallback. The skeleton implementer writes the choice into `runner/README.md`. The spike changed nothing in the repo; its scratch project is `/tmp/wc-eve-spike/runner`.

Status stays `open`: the skeleton (the rest of this packet) runs in iter-003.
