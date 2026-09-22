# P02 · Runner spike and skeleton

Status: open
Assignee: none
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
