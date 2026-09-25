# Pilot success test — run record

Run of `docs/pilot/success-test.md` for P10-B Acceptance 2, executed
2026-09-25 in a manual Claude Code session (implementer worktree), as far as
this machine allows. Per the packet brief: any step that can't run here is
recorded `blocked` with the exact reason, never a silent skip.

**Fresh clone:** `/tmp/wc-p10b-clone`, branch `packet/P10-B` at head
`566e5550c09a382c731638087aedc84ce23e0cbb` (the merge candidate: `overnight/
integration` merged in, plus this packet's own commits — the state the PR's
CI will run). **Fresh workspace:** `/private/tmp/wc-p10b-ws` (macOS resolves
`/tmp` to `/private/tmp`). **Assigned port:** 127.0.0.1:4320, checked free
before use; `npm run runner`'s ports (3210, 4310) are hard-coded in
`runner/cli/runner.ts` with no override flag, so the real 4310/3210 were used
for step 4's attempt per the brief's own exception ("never bind 4310 unless
P07-C has merged and no other agent holds it" — confirmed via `lsof -i :4310`
before the attempt: nothing listening, and P07-C is merged).

## Steps

1. **Clone and install — passed.**
   ```
   git clone --branch packet/P10-B https://github.com/radroid/workflow-catalog.git wc-p10b-clone
   cd wc-p10b-clone && pnpm install --frozen-lockfile
   ```
   `corepack enable` was skipped: `package.json` pins `"packageManager":
   "pnpm@11.17.0"`, and the ambient `pnpm --version` already reports
   `11.17.0`, so there is nothing for corepack to change. Install completed
   in 3.4s with no error ("Lockfile is up to date, resolution step is
   skipped", 458 packages).

2. **Set up the runner — passed, with one substitution.** Ran
   non-interactively (no TTY in this session):
   ```
   node --import ./lib/register-ts.mjs cli/setup.ts \
     --yes --workspace /tmp/wc-p10b-ws --provider gateway --model openai/gpt-5.6-terra
   ```
   Chose provider `gateway` instead of a real `chatgpt`/`openai`/`anthropic`
   account specifically so setup never touches the real OS keychain or a real
   provider — no `--api-key-env` was passed and none of
   `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`AI_GATEWAY_API_KEY` are set in this
   shell, so `connectApiKey` in `runner/lib/setup.ts` takes its
   no-key-available branch and never calls `store.set`. Output:
   ```
   Node 24.18.0: ok.
   Workspace: /private/tmp/wc-p10b-ws (created).
   Model: gateway openai/gpt-5.6-terra.
   gateway: no API key stored. Run setup again in a terminal to enter one, or set AI_GATEWAY_API_KEY where you start the runner.
   Settings: written to /private/tmp/wc-p10b-clone/runner/.env.local (private to you; eve telemetry and trace content are off).
   Pairing code: QQ75M-XDJJQ
   ```
   `.env.local` was written (mode 0600 per existing `updateEnvFile`
   behaviour), a fresh workspace was created, and a pairing code was printed
   — matching the checklist's *Expect*, modulo the provider substitution.

3. **Doctor — passed (matches the checklist's expected shape at this
   point).**
   ```
   node --import ./lib/register-ts.mjs cli/doctor.ts
   ```
   ```
   [ok]   Node 24 present: Node 24.18.0
   [ok]   Runner installed: Packages installed and setup done.
   [FAIL] Provider connected: gateway openai/gpt-5.6-terra: no API key found in the keychain or in AI_GATEWAY_API_KEY.
   [ok]   Workspace chosen: /private/tmp/wc-p10b-ws
   [FAIL] Extension paired: No browser extension is paired.
   [ok]   Privacy settings: eve telemetry off; trace content off.
   [ok]   eve pinned to 0.63.0: eve 0.63.0 installed, pinned exactly.
   ```
   `extension: fail` is exactly the checklist's documented expectation before
   step 6 pairs. `provider: fail` (checklist says `warn`) is the direct,
   expected consequence of the gateway substitution in step 2 (a real
   account would show `warn`, not `fail`, until verified `--live`); doctor's
   own logic is unaffected. `doctor -- --live` was **not** run: it makes one
   real call to a live model, which this run must never do.

4. **Start the runner — blocked.**
   ```
   node --import ./lib/register-ts.mjs cli/runner.ts
   ```
   Result: `Port 3210 on 127.0.0.1 is already in use, and eve needs it. Is
   another runner running? Stop it first.` Confirmed via `lsof -i :3210
   -sTCP:LISTEN` immediately before the attempt: an unrelated, pre-existing
   process (`convex-lo`, PID 19857, owned by this same machine user but no
   relation to workflow-catalog) is listening on 3210. `runner/cli/
   runner.ts` hard-codes `EVE_PORT`/`BRIDGE_PORT` (3210/4310) with no
   environment or CLI override, so this could not be redirected to the
   assigned 4320. Terminating another process on a shared machine on spec
   is outside this session's authorization, so this is recorded blocked
   rather than forced. **Every step below that needs a running bridge (6–14)
   is blocked by this same cause**, not attempted separately.

5. **Build and load the extension — build passed, load blocked.**
   ```
   pnpm --filter @workflow-catalog/extension build
   ```
   Passed for real: `dist/ scan clean: no eval, new Function, or remote
   script/import found.`, all chunks emitted. The Chrome-side half
   (`chrome://extensions` → Developer mode → Load unpacked, in a real,
   branded Chrome with a persistent profile) is blocked: this session's only
   browser automation is the chrome-devtools MCP browser, which the brief
   itself names as one of the standard blocked-step examples ("branded
   Chrome"). No extension load, so no action icon to click.

6. **Pair the extension — blocked.** Needs both the running bridge (step 4)
   and a loaded, branded extension (step 5's second half). Both blocked
   above; not separately attempted.

7. **Onboarding — blocked.** Needs the running bridge (`http://127.0.0.1:4310/ui/onboarding`).

8. **Approve the career profile — blocked.** Depends on step 7.

9. **Capture three real jobs — blocked.** Needs the running bridge and the
   paired extension.

10. **Prepare an application for each captured job — blocked.** Needs the
    running bridge and would need a live model call, which this run must
    never make even if the bridge were reachable.

11. **The board — blocked.** Needs the running bridge and step 9/10's data.

12. **A session: tab group, side panel, Applied — blocked.** Needs the
    running bridge, the paired extension's side panel, and a real Chrome tab
    group — three of the brief's blocked-step categories at once.

13. **A schedule and its catch-up — blocked.** Needs the running bridge; the
    catch-up half additionally needs real wall-clock waiting across a UTC
    schedule boundary, which this session cannot force.

14. **The budget pause — blocked.** Needs the running bridge; the
    "Paused" sub-case additionally needs a real provider 429, which this run
    must never trigger (no live model calls).

15. **Forget — passed, run twice (dry-run, then for real).**
    ```
    node --import ./lib/register-ts.mjs cli/setup.ts --forget --dry-run
    ```
    ```
    The runner stored:
      - runner/.env.local (settings, route password, local-UI token)
      - the workspace /private/tmp/wc-p10b-ws (your profile, jobs, applications, sessions, runs)
    Note: Codex keeps its own ChatGPT sign-in (in ~/.codex); the runner never stored it. Run `codex logout` to remove it.
    ```
    No secret-store entries were listed (none were ever written, per step
    2's substitution), so there was nothing eve-owned to ask about. Then for
    real:
    ```
    node --import ./lib/register-ts.mjs cli/setup.ts --forget --yes
    ```
    ```
    Removed runner/.env.local (settings, route password, local-UI token)
    Removed the workspace /private/tmp/wc-p10b-ws (your profile, jobs, applications, sessions, runs)
    Done. The runner's code is still here; delete the repository folder to remove it too.
    ```
    Confirmed both paths gone afterwards (`ls` on each returned "No such file
    or directory").

## Summary

- **Passed, for real, against the fresh clone/workspace:** 1 (clone+install),
  2 (setup, gateway substitution), 3 (doctor, expected pre-pairing shape),
  5's build half (extension bundle), 15 (forget, dry-run and real).
- **Blocked, with cause:** 4 (port 3210 held by an unrelated process on this
  shared machine; no override flag; not authorized to kill another process),
  5's load half and 6 (branded Chrome), 7–9 and 11–14 (need the running
  bridge from step 4, some also a live model or a real provider 429), 10 and
  the live half of step 12 additionally need a live model call, which this
  run must never make regardless of the bridge.
- **Failed:** none — every attempted step matched its documented *Expect* or
  a directly-attributable substitution.
- No server used the port assigned to another agent; nothing above 4310/3210
  was left running (the one `cli/runner.ts` attempt exited immediately on
  its own port check, no lingering process).
