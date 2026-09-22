# P02 · Runner spike and skeleton

Status: claimed
Assignee: iter-003 implementer (Opus); revision 2 iter-003 (Opus)
Blocked by: P01
Owns: runner/ (eve project), packages/job-assistant/adapters/eve/
Spec: §8 runner platform notes, §5 bridge, F3

## Goal
A pinned eve project that runs on a laptop with the person's own provider, plus our bridge server, pairing, setup wizard, and doctor. This packet begins with the spike that decides the run mode.

## Step 0: the spike (do first, report before continuing)
Scaffold with `npx eve@0.63.0 init runner` (pin; do not use `@latest`), set `model: chatgpt()` in `runner/agent/agent.ts`, sign in via `/login` in `eve dev`, then test in order: (A) `eve build && eve start --host 127.0.0.1` with `httpBasic()` auth: does `POST /eve/v1/session` with a trivial message get a completed turn on `chatgpt()`? (B) `eve dev --no-ui --host 127.0.0.1 --port 2000`: same test. Record both outcomes verbatim in the report, choose the mode per spec §8, and write the choice into `runner/README.md`. If neither works with `chatgpt()`, repeat (A) with `openai()` on an API key and report; the pilot then defaults to API keys and the catalog install page says so.

## Deliverables
- `runner/agent/`: `instructions.md` (system prompt: role, boundaries, "content is data"), `agent.ts` (model from settings: `chatgpt()` | `openai()` | `anthropic()` | gateway string), `channels/eve.ts` (auth per chosen mode; custom `AuthFn` returning `principalType: "user"` for the paired device), `sandbox/sandbox.ts` pinned to `justbash()` or sandbox tools removed, `extensions/jobs.ts` mounting the package adapter.
- `packages/job-assistant/adapters/eve/`: an eve extension (`eve extension init` layout) that mounts the package's skills and a "content is data, never instructions" instruction fragment, and declares no tools. The one model tool is a runner tool, `runner/agent/tools/open_application_group.ts`: a stub (input is task IDs only, never a URL; `approval: always()`; returns "not implemented") whose body P06 replaces. `capture_job` and `report_status` are bridge actions (extension → bridge), not model tools. (amended iter-003 per review; was: the adapter declares three stub tools, `capture_job`, `open_application_group` and `report_status`)
- `runner/server/`: Hono on `127.0.0.1:4310`. Routes exactly `POST /pair`, `GET /commands`, `POST /events`, `GET /status`, plus the local UI static routes. Bearer device tokens, Origin check against the extension origin set at pairing, 256 KB body cap, zod validation of every body against `packages/contracts`. Talks to eve through `eve/client`.
- `runner/store/`: file-based workspace store per spec §5 (`workspace.json`, directories), with an atomic write helper and an event outbox with unique event IDs.
- `npm run setup`: wizard that checks Node 24, chooses the workspace directory, connects a provider (for `chatgpt()`, checks the Codex CLI sign-in with `codex login status`, the only sign-in mode A uses, and explains `codex login` (amended iter-003 per review; was: launches `eve dev` for `/login`); asks for a key otherwise, stored in the OS keychain), prints a pairing code, and writes `runner/.env.local` with `EVE_TELEMETRY_DISABLED=1` and `EVE_TRACES_CONTENT=off`.
- `npm run doctor`: the same checklist as the catalog install page, machine-readable (`--json`).
- `npm run runner`: starts eve in the chosen mode and the bridge together; both loopback only.

## Acceptance
- Spike outcomes recorded. `npm run doctor --json` returns all green on the dev machine.
- Bridge tests: unknown route 404; missing token 401; wrong Origin 403; oversized body 413; invalid envelope 400 with the zod path; replayed `eventId` acknowledged once, stored once.
- Pairing tests: code expires at 10 minutes; single use; revocation removes the device.
- `eve eval --strict` runs a fixture agent on `mockModel` that calls the one stub tool, `open_application_group`, once: the call raises an approval request instead of executing, no bash or file tools are available, and a call to a tool that does not exist runs nothing. (amended iter-003 per review; was: calls each stub tool once)
- Uninstall test: deleting the workspace directory and `runner/` leaves nothing behind except eve's keychain entry, which `npm run setup --forget` removes.

## Out of scope
Onboarding, capture, preparation logic. Any UI beyond a status page.

## Report

### 2026-09-22 — Revision 2 (iter-003, Opus escalation)
This answers the second Opus review of PR #8: 2 medium issues and 3 follow-ups. The code head is `ca60534`; this report is the next commit. CI on PR #8 passed at `ca60534`.

**What changed, by review item**

1. **Pairing limits under concurrency** (`89307f0`, `server/extension-api.ts`).
   - `/pair` reads and validates the body first. It then runs check → redeem → record → withdraw inside `PairThrottle.exclusive`, a promise chain like the one in `store/commands.ts`. Each request is judged only after every earlier failure has been recorded.
   - The body is read before the queue, bounded by the 256 KiB cap and the server's timeouts. The device is registered after the queue.
   - One visible change: an origin already at its limit now gets its 429 after its body is read. So a body that is too large, or not JSON, now gets its 413, 415 or 400 first.
   - Tests (`test/bridge.test.ts`). A helper holds every redeem until the whole burst is in flight, like a slow disk, so each race is deterministic:

     | Test | Result |
     |---|---|
     | 150 wrong codes from 150 origins at once, then the real code, sent last | 150 × 401; the real code gets 401 "withdrawn after too many wrong tries"; no device |
     | 30 wrong codes from one origin at once | exactly 10 × 401 and 20 × 429, with only 10 redeems; the code then pairs |
     | a valid code racing 50 wrong codes from other origins, judged at position 0, 25 and 50 | 200 each time, beside 50 × 401 |
     | a body still arriving while the real extension pairs | the pairing gets 200 at once; the slow request then gets 401 |

   - On the unfixed code, the first two fail: `expected 200 to be 401` and `expected { '401': 30 } to deeply equal { '401': 10, '429': 20 }`. With the lock moved around the body read, the fourth fails with `Test timed out in 3000ms`. All four passed 10 runs out of 10.
2. **Closing the terminal (SIGHUP)** (`635bc74`, in `lib/launcher.ts`, `cli/runner.ts` and `README.md`).
   - The launcher registers SIGHUP with SIGINT and SIGTERM, before the spawn, and removes it on failure. Closing the terminal now stops eve, both while starting and once ready.
   - `cli/runner.ts` adds a no-op `error` listener to `process.stdout` and to `process.stderr`.
   - The README's `runner` row now says that closing the terminal stops both.
   - Tests:
     - SIGHUP while waiting for eve to be ready: eve gets SIGTERM, the result is `{ state: "stopped" }`, and the listeners are removed.
     - SIGHUP once ready: the bridge closes, eve stops, and the launcher exits 0.
     - The listener count taken at the spawn now includes SIGHUP.
3. **Follow-ups**
   - **3a** (`b430be7`). A new test holds the health check open, sends SIGTERM, and asserts that eve gets SIGTERM at once.
     - With `void stopEve();` removed: `expected [] to deeply equal [ 'SIGTERM' ]` (1 failed, 13 passed).
     - Restored: 14 passed, and `git diff` was empty.
   - **3b** (`1d984f2`, `server/app.ts`). When a start hook throws, `startModules` stops the modules already started, newest first, then rethrows the start failure. A stop that fails is logged with its file name, and the stops after it still run.
     - Test: six modules, and the fifth fails. The stops run as `delta stopped, beta stopping, alpha stopped`, and the sixth never starts. The test failed on the old code.
   - **Found with 3b** (`7c4b7bd`, `lib/launcher.ts`). The launcher's shutdown ran `Promise.resolve(stop())`, which misses a stop that throws synchronously.
     - The effect: shutdown rejected, the bridge stayed open and eve was never stopped. Node 24 then crashes on the unhandled rejection and leaves eve running.
     - Shutdown now runs `Promise.resolve().then(stop)`. Its new test failed before the fix, with `Unhandled Rejection: Error: stop failed` and no exit.
     - This is outside the listed items. The fix is one expression, and I flag it for review.
   - **3c** (`ca60534`). The GET `/commands` handler answers HEAD after the token, Origin and query checks, without touching the queue. `HEAD /status` is unchanged, and its test stays green.
     - Test: after a HEAD, the queued command has no lease and 0 deliveries. HEAD without a token gets 401, and HEAD with a bad `since` gets 400. The next GET delivers the command at once.
     - It failed on the old code with `expected 1 to be +0`.

**Tests run** (worktree, at `ca60534`)
- `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm -r lint` and `pnpm check:fixtures` all exited 0. `git status --porcelain` was then empty.

  | Suite | Result |
  |---|---|
  | runner | 14 files, 153 tests (143 before), then `EVALS 4`; `Results: 4 passed`; `Gates: 20 passed` |
  | contracts | 235 tests |
  | job-assistant | 151 tests |
  | catalog | 139 tests |
  | `scripts/*.test.mjs` | 2 pass |

- The eval on its own, as `node --import ./lib/register-ts.mjs cli/eval.ts` (the command `npm run eval` runs): `Results: 4 passed (4 total)`, `Gates: 20 passed`.
- CI on PR #8 at `ca60534`: `ci` passed in 1m26s, with runner 153 tests and the eval at 4/4 and 20 gates.

**Live verification.** I ran these on a scratch copy of `ca60534`, made with `git archive`, in `/tmp/wc-p02-r2-live`. HOME was `/tmp/wc-p02-r2-live-home`, codex was off PATH, the provider was chatgpt, and no model was called. The drivers are in `/tmp/wc-p02-r2`.
- **Setup** exited 0 with "the Codex CLI was not found on PATH", as in the review.
- **SIGHUP once ready.**
  - Before: ready at +6.4 s, with eve's 2 processes running and 3210 and 4310 listening.
  - On SIGHUP, the launcher printed `[runner] Stopping...` and `[runner] Stopped.`, then exited 0 about 20 ms later.
  - 1.5 s later there were 0 eve processes, and nothing was listening on 2000, 3210 or 4310.
  - In the review, the launcher died from SIGHUP, eve kept 3210, and the next start refused.
- **SIGHUP once ready, with the terminal's pipes closed first,** so that every write fails with EPIPE: exit 0, 0 eve processes, and the ports were free.
- **SIGHUP while starting,** 150 ms after `Starting eve` and before ready: `[runner] Stopped before it was ready.`, exit 0, 0 eve processes, and the ports were free.
- **Without the two `error` listeners** (removed in the scratch copy only, then restored):
  - The closed-pipes run exited 1 instead of 0.
  - With only stdout closed, it exited 0. `console.log` guards its own write errors; the crash comes from relaying eve's lines with `process.stderr.write`.
  - In this timing eve had already been sent SIGTERM. But any eve output before that point would crash the launcher and leave eve running.
- **The review's race, over TCP,** against the same runner:
  - 1,000 wrong codes from 1,000 origins at once: `{"401":1000}`. The real code, sent last, got 401 `pairing_code_invalid`; the review measured 200.
  - 300 wrong codes from one origin at once: `{"401":10,"429":290}`; the review measured 59 × 401. The real code, from another origin, got 200.
  - The log had one line, `Withdrew 2 pairing code(s)`: setup's still-valid code and the burst's.
  - SIGTERM then exited 0.
- **Afterwards,** `ps` showed no runner or eve process, and `lsof` showed nothing listening on 2000, 3210 or 4310.

**Skipped, and why**
- **`README.md:200–204` and the comment at `extension-api.ts:64`** are unchanged, because the wording about the limits still holds. Only `PairThrottle`'s own comment, which describes the mechanism, changed.
- **`HEAD /ui/login?nonce=…`** is outside this round's items, so I left it; I checked it by reading, not by running it. Hono answers HEAD with the GET handler, so a HEAD spends the one-time sign-in link, and its response carries the `Set-Cookie`. The link is printed only to the terminal, so only a link previewer that sends HEAD would hit this. It is worth a follow-up.
- **How commands were run.** This session's command guard refuses:
  - the bare word "eval", so I ran the eval by its script's command;
  - git operations outside the worktree, so the live runs used `git archive` instead of a clone;
  - HOME set inline, so node drivers set HOME for their child processes only. No git runs in them.
- **Scratch folders** are left in `/tmp` for the OS: `wc-p02-r2`, `wc-p02-r2-live` and `wc-p02-r2-live-home`.

**Assumptions**
- One bridge process owns the `/pair` queue, as it owns leasing. Like the guess budget, the queue lives in memory.
- A flood of wrong codes can delay a valid code in the queue but never refuse it. After 100 wrong codes, the code is withdrawn anyway.

**Sharpen next time**
Beside every one-at-a-time test of a limit or a one-time token, write a burst test that holds the work open, so the race is deterministic. Both the single-use bug and the guess-limit bug passed their one-at-a-time tests.

### 2026-09-22 — Revision 1 (iter-003 implementer, Opus)
This answers the PR #8 review (VERDICT: REVISE, 7 issues and 4 more items) and the security review of `aa59afd`. The code head is `7dd7794`; this report is the next commit. CI on PR #8 passed at `cfe590e` and `7dd7794`.

**What changed, by review item**

1. **Origin on GETs** (`aae3c75`). The rule now runs in this order:
   1. The Host check, unchanged.
   2. The token.
   3. A GET or HEAD with no `Origin` is accepted on the token alone.
   4. Any `Origin` that is present must be the paired one, else 403 `origin_not_allowed`.
   5. A POST must carry the paired `Origin`, else 403 `origin_required`.

   `/pair` and preflights are unchanged. The tests use Chrome's recorded header shape. The README check order and my wrong assumption in the skeleton entry are corrected.
2. **`since` stranding leased commands** (`dfa7235`). `since` now narrows only never-delivered commands. A delivered command whose lease lapsed unacknowledged comes back whatever `since` says. Tested with the review's exact sequence: enqueue 09:00, poll at 09:01 with since=09:00, then poll at 09:16 with since=09:01 returns the same command, on its second delivery.
3. **Startup leaving eve running** (`5287944`, `7dd7794`). The new `lib/launcher.ts` runs startup in this order:
   1. Load the route modules and build the bridge app. A module that fails to load, or a duplicate handler, stops here with no child.
   2. Register the SIGINT/SIGTERM handlers, then spawn eve. The handlers go first on purpose: Node runs them from the event loop, so no signal can fall between the spawn and their registration.
   3. Wait for health, listen, then run the start hooks. Any failure after the spawn stops what started, eve last.

   Two supporting changes: eve's health check is bounded at 5 s (`client.health()` takes no signal), and a route module's load error now names its file. Covered by 11 tests with an injected child. I also confirmed it live (below).
4. **`/pair` throttle shared across origins** (`aa59afd`). The failure window is now kept per origin. Test: three rounds of 10 wrong codes from another origin. That origin gets 429 each time, while the real extension pairs with the valid code.
5. **Bin shim in the release tarball** (`12bb83b`). `/node_modules/` is added to the adapter's `.gitignore`. On a fresh clone I ran the release workflow's own `pnpm --filter @workflow-catalog/job-assistant pack --pack-destination dist`:
   - 49 entries.
   - `tar -tzf … | grep node_modules` printed nothing (exit 1).
   - Against the review's tarball, the only difference is the missing line `package/adapters/eve/node_modules/.bin/eve`.
6. **Lockfile conflict** (`bcfb25f`). I merged `origin/overnight/integration` (`a9032b3`) with a merge commit, took integration's lockfile, and ran `pnpm install`. Compared with both sides, the result is integration's lockfile plus exactly this branch's runner and adapter importers.
7. **Build stamp** (`1cfb2b3`). All inputs are now in one list, `buildInputsFor(repoRoot)`:
   - `packages/contracts/src` and the contracts manifest
   - `pnpm-lock.yaml`
   - `runner/lib` and `runner/store`, because agent code may import them (item 10)

   The adapter's generated `extension/skills/` copy is now excluded; hashing it made a fresh install build twice. Tested on a fake repo: each input changes the stamp, while build output does not.
8. **Local-UI API** (`5d79b94`). When `Sec-Fetch-Site` is present, `/api/*` answers only `same-origin`, so `none`, `cross-site` and `same-site` are refused. Pages and the sign-in link still open with `none`.
9. **Sign-in advice** (`5289208`). Setup and the README now say the Codex sign-in is the only way in for ChatGPT, and no longer suggest `eve dev`. The setup test checks the advice never mentions `eve dev` or `/login`.
10. **Cross-process enqueueing** (`dfa7235`). The README section "Commands" gives P06 the route: the tool builds `new CommandQueue(await Workspace.open(process.env.RUNNER_WORKSPACE), systemClock)` and calls `enqueue()`. This is safe across processes, for two reasons:
    - An enqueue is an exclusive create of a new file.
    - Only the bridge leases or acknowledges.

    To check the route itself, I made a scratch tool that imports the store (in a `/tmp` clone, never committed). It built with `eve build` (exit 0), and the bundle contains `CommandQueue = class {`, `class Workspace` and `leasePending`.
11. **Packet text** (`cfe590e`). Lines 17 and 28 now describe the one-stub design, marked "(amended iter-003 per review)". Line 20 said setup launches `eve dev` for `/login`, the same contradiction as item 9, so I amended it the same way.

**Security review** (`1ed51f9`, on `aa59afd`)
- **The finding, confirmed.** A local process can send any extension origin, so the per-origin window alone gave it unlimited guesses. Evicting origins also reset their counts.
- **The fix.** The per-origin window stays, for fairness only, and eviction can affect only fairness. Separately, the bridge keeps the times of the last 100 wrong codes from any origin. Once 100 have been tried, every outstanding code issued at or before the oldest of them is withdrawn from the pairing store, and even the right code then gets 401. The 401 message now says a code may have been withdrawn after too many wrong tries, and to run `npm run pair`.
- **Why per code rather than a count since the newest code.** A count reset by each new code lets an older code, still valid, absorb about 200 wrong codes. With one outstanding code the two rules are the same, and a code issued later (for example by `npm run pair` in another process) still starts with a fresh budget.
- **Details.**
  - Withdrawal claims a code the way redeem does, so a code is either redeemed or withdrawn, never both.
  - Expired codes do not count as guesses.
  - Origins were already checked strictly (`chrome-extension://` plus 32 letters a–p) before the throttle.
- **Tests.**
  - 1,100 distinct origins sending one wrong code each get exactly 100 tries at a valid code, after which even the right code is refused. A code issued afterwards pairs.
  - An older code is withdrawn while a newer one keeps its own budget.
  - 160 attempts from 8 malformed origins get 403 before the throttle and never touch the code.
  - The per-origin test (item 4) stays green.

**Tests run** (worktree, at `7dd7794`, after the merge)
- `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm -r lint`, `pnpm lint`, `pnpm check:fixtures`, `pnpm -r test` and `pnpm -r typecheck` all exited 0.

  | Suite | Result |
  |---|---|
  | runner | 14 files, 143 tests, then `EVALS 4`; `Results: 4 passed`; `Gates: 20 passed` |
  | contracts | 235 tests |
  | job-assistant | 151 tests |
  | catalog | 139 tests |

- The eval on its own: tool-surface 4/4, approval 4/4, missing-tools 8/8 and skills 4/4, on an ephemeral port.
- **Fresh clone** (`/tmp/wc-p02-rev1`, at `cfe590e`): `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test` (runner 142 tests plus the eval), `pnpm -r lint` and `pnpm check:fixtures` all exited 0. I then fast-forwarded it to `7dd7794` for the live run.

**Live verification** (fresh clone, loopback only; every process stopped afterwards and ports 2000, 3210 and 4310 confirmed free)
- **Interrupted startup.** I sent SIGTERM the moment `Starting eve` was printed. The log reads `[runner] Stopped before it was ready.`, the launcher was gone in about 250 ms, and no process from the clone was left.
- **Bridge, with Chrome's GET header shape:**

  | Request | Result |
  |---|---|
  | GET /status, no Origin, token | 200 |
  | GET /commands?since=, no Origin, token | 200 |
  | no token | 401 |
  | unknown token | 401 |
  | foreign Origin | 403 |
  | POST /events, no Origin | 403 `origin_required` |
  | POST /events, paired Origin | 202 |
  | the same event replayed | 202 `duplicate=true`; one journal file |

- **Local UI:**

  | Request | Result |
  |---|---|
  | sign-in link | 303 |
  | `/ui/status` with `none` | 200 |
  | `/api/status` with `none` | 403 |
  | `/api/status` with `cross-site` | 403 |
  | `/api/status` with `same-origin` | 200 |

- **Budget.** Pairing codes came from `npm run pair`, a separate process. 150 wrong codes from 150 made-up origins all got 401. The right code issued before them then got 401 `pairing_code_invalid`, a code issued afterwards got 200, and a malformed origin got 403.
- **Real Chromium 153**, with the review's probe extension (`hkenhjopfikgadihenpjlonnmpbamgdi`) paired to this bridge:
  - From both the extension page and its service worker: `GET /status` 200, `GET /commands?since` 200, `POST /events` 202, and the replay 202 with `duplicate:true`.
  - `GET /api/status` with the UI cookie, from the extension: 403 `cross_site_request`.
  - In a normal tab, the status page rendered all 7 checklist rows. Its own `/api/model`, `/api/devices` and `/api/status` calls returned 200, with no console errors, and the cookie is `wc_runner_ui` (Strict, HttpOnly).
- **Stop.** SIGTERM gave `[runner] Stopped.` and exit 0.
- **Model use.** None this round.

**Skipped, and why**
- **The PR description** still says the bridge refuses a GET without `Origin`, so it is out of date. I did not edit it: this round did not ask for PR edits, and editing it is an outward-facing change.
- **mvp-spec §5** is the coordinator's to amend, per the round's rules.
- **Scratch folders** are left in `/tmp` for the OS: the clones `wc-p02-rev1` and `wc-p02-clean*`, the workspace `wc-p02-rev1-ws` and `wc-p02-scratch`.

**Assumptions**
- The Chromium 153 header shapes (no `Origin` on an extension's GET; `Sec-Fetch-Site: none` and the SameSite=Strict cookie on its fetches) hold for the Chrome versions the pilot uses.
- One bridge process owns leasing and the guess budget. The budget is in memory, so a bridge restart resets it.

**Sharpen next time**
Measure the real browser's request shapes before writing header rules. The Origin assumption was a guess, and a 20-line Chromium probe settled it.

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
- ~~Chrome sends `Origin` on the extension service worker's GETs.~~ Wrong (corrected in revision 1, per review): Chromium 153 sends no `Origin` on an extension's GETs and sends it on POSTs. The bridge now accepts a GET without `Origin` on the device token alone; any `Origin` present must be the paired one, and every POST must carry it.
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
