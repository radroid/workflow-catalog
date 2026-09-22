# P07-B (#12): revision 1 instructions and the B5 correction (sent 2026-09-22)

These are the exact messages the orchestrator sent to the P07-B implementer after round-1 review (reviewer REVISE 6, UI critic REVISE 10). The implementer finished revision 1 at c207783, then the B5 correction at 6da1a83. What remains is the round-2 review in `P07-B-round-2-review.md`.

## Revision 1 message

P07-B (#12) revision 1: the reviewer (REVISE — 6 issues) and the UI critic (REVISE — 10 issues) both reviewed head 2e3b52d. Their overlapping points are merged below. This is your one revision round.

SETUP
- Merge `origin/overnight/integration` first (normal merge; no rebase, amend or force-push).
- Port 4310 is yours alone during the round. Stop every bridge you start before reporting. 3000/3001 belong to the owner.
- Standing rules:
  - Write only in the worktree or /tmp, and leave scratch.
  - No recursive delete through node, find or python.
  - Never test a guardrail or reroute after a refusal.
  - Stage by explicit path, commit at green steps, plain push.
  - Fictional data only.
- Owns: `extension/`, plus the one extension step in `.github/workflows/ci.yml`.

ORCHESTRATOR DECISIONS
E1 The file bridge is a fallback (the P07 deliverable says "File bridge fallback: export job-capture.json").
  - Nothing downloads when the bridge accepts a capture.
  - "Save as a file" stays an explicit secondary action, offered when unpaired or when delivery fails.
  - Update the tests to match; this follows the packet and isn't a loosening.
E2 A capture made while not paired is queued in the outbox and sent automatically once pairing succeeds (flush on pair success).
E3 The code label names `npm run pair`, which prints a new code; setup prints the first one. Render commands with <code>, never literal backticks.
E4 storage.session means quitting Chrome unpairs the browser. That is by design (spec §7.5). Say so in one line on the options page.

ISSUES
B1 [reviewer 1] `pnpm test` needed 127.0.0.1:4310 free. Fix: give the realbridge vitest harness an ephemeral port, keep 4310 for `test:e2e` only, and guard afterEach against a failed setup.
B2 [reviewer 2] Outbox flush race: `flushOutbox` wrote back a stale `remaining` list, so a capture queued meanwhile was lost ([1111, 2222] became [1111]). Fix: per-entry keys, or a worker-owned serialised queue. Add the race as a test.
B3 [reviewer 3, critic 2 and 6, reviewer nit] Every refusal read "isn't reachable". Branch on status and code:
  - network error, timeout or 5xx: queue, and keep the "isn't reachable… sent automatically" message;
  - 401: keep it queued, pause retries, "Your pairing expired or was revoked. Pair again in Settings and it's sent", Open settings; mark the pairing invalid or clear the dead token; never show "Connected: Yes" for it;
  - 403: keep it queued, pause retries, "This pairing belongs to a different install. Pair again in Settings"; store the 403, because GET /status carries no Origin;
  - other 4xx: don't queue, remove it if already queued, show the specific message.
  - After a new pairing, flush. Update the gate-9 e2e to the new 403 text.
B4 [reviewer 6, critic 1] No timeout, and delivery wasn't validated.
  - Put `AbortSignal.timeout(~5000)` on every request, mapped to network_error ("The runner isn't responding").
  - Render Pairing and File bridge at once, and fill Status in afterwards ("Checking the runner…").
  - Count a capture as delivered only on `ok: true` with the matching `eventId`. `duplicate: true` still counts as success.
B5 [reviewer 4] CI skipped the two dist tests. Run the extension vitest after the build in the CI step, and make the tests fail rather than skip in that step. The wording was corrected later; see below.
B6 [reviewer 5] Three test files were excluded from typecheck, hiding `e2e/bridge-e2e.spec.ts(257,44)` (`string | undefined` passed to `revoke`). Add a second tsconfig run from the extension's `typecheck` script, and fix line 257.
B7 [critic 3, reviewer nit] One persistent live region. Focus Un-pair on success and the code field on failure.
B8 [critic 4] aria-invalid only for empty or malformed codes and for `pairing_code_invalid`/`pairing_code_expired`. On 429 say "Try again in about N minutes", from Retry-After.
B9 [critic 5] `.eyebrow` gets `font-weight: 400`.
B10 [critic 7 and 8] "Check again" (or a re-check on focus), plus an outbox line: "1 saved job waiting to send" / "All saved jobs sent".
B11 [critic 9] "Open settings" (`chrome.runtime.openOptionsPage()`) in the not-paired popup, with one page name throughout. Queue per E2.
B12 [critic 10] Code label per E3.
Polish:
- no mid-command wraps at 390;
- the Un-paired message beside its button;
- the workspace UUID shortened to 8 characters, with the full value in a title;
- Pair form collapsed to "Pair again" while paired;
- "Saved ✓" disabled after saving;
- `.flash`/pill outcomes;
- a stronger scroll cue;
- wording: drop "including actual revocation"; "Pair this browser";
- the brightness retry only on matchMedia disagreement.
Screenshots: full height, light and dark; the popup at its natural size, the options page at 1280 and 390, across about 11 states.
FINISH: the full chain; extension build + vitest against dist (0 skipped) + e2e twice; mutation proofs for B2, B3, B4, B5 and B6; a "Revision 1 (part B)" report section.

## B5 correction (sent after c207783; the orchestrator's wording caused the conflict)

- The problem: `extension/src/manifest.test.ts:80` ran the dist tests whenever `CI` was set. GitHub Actions sets CI=true for the root "Test" step, which runs before any build, so CI went red.
- The fix, landed at 6da1a83:
  - Gate on `built || process.env.EXTENSION_DIST_REQUIRED === "1"`.
  - The ci.yml extension step runs `EXTENSION_DIST_REQUIRED=1 pnpm --filter @workflow-catalog/extension test` after the build.
  - Mutation proof: with the variable set and no `dist/`, the tests fail; `CI=true pnpm test` stays green.
