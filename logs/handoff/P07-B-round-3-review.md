# P07-B (#12): round-3 review of head d0e2b2c (iter 005)

Revision 2 was done by a fresh Opus escalation implementer, and CI was green on every head. Any REVISE goes back to that **same Opus implementer**; its worktree is kept. The UI critic's section is added when its verdict lands.

## Reviewer (Opus): REVISE — 1 issue (documentation only)

Scratch:
- `/tmp/wc-r3-p07b-review/`: chain logs, the CI log, plant specs, backups, and round 2's probes, adapted;
- `/tmp/wc-r3-p07b-mut/`: a clone at d0e2b2c, still holding untracked `zz-r3-*` probes;
- `/tmp/wc-r3-p07b-merge/`: merge commit 7f60bc6.

**What holds:**
- **Chain:** green at the head, and on the merge onto 276041d with no conflicts.
- **Extension tests:**
  - dist vitest: 20 files, 273 tests, 0 skipped;
  - realbridge: on an ephemeral port, 11/11 even with 4310 busy.
- **CI 35778631157:** Playwright ran 32 tests, all passed, with `retries: 0` and no skips.
- **Invariants:** exactly six manifest permissions; only `storage.session`; the token only in the Authorization header to the bridge; no `innerHTML`; `eventId` reuse; `duplicate: true` counts as success.
- **A (CI fix): the guard is not weakened.** The detector is unchanged, and 8 of 8 guard probes pass:
  - wrong-theme captures fail after 1 capture;
  - a persistent drop fails after 3 repairs;
  - CI's overlaid frame is flagged;
  - planting a "retry even when matchMedia agrees" weakening makes the probe fail.
- **Races:** 16 of 18 probes pass, P1–P9 adapted plus new interleavings. The 2 failures are nits 1 and 2.
- **Checklist:** B1–B5, C1–C5, D, E1–E4 and every earlier-round item are verified, with mutation plants. The Edit-tool append in `bridge-client.test.ts` is sound.

**Issue 1. The manual smoke checklist and the popup description contradict the PR.**
- `extension/README.md:25-29` and step 3 at `:180` say Save downloads `job-capture.json`. Since E1, Save only posts.
- Step 6 at `:194-196` claims a re-save delivers "the same `eventId` … exactly once". In fact `build-job-capture.ts:52` mints a new uuid each time the popup opens.
- Step 7 at `:197-198` imports a `job-capture.json`, but the import accepts only `application-session.json` (`options/main.ts:588`).
- `:142` ("Save → download") and `:88` (a single-tsc typecheck) are stale too.
- The fix is README-only.

**Nits:**
1. **A narrow window after pairing (the "LIFT race").** A worker's 401 pause write that lands after `resumeAfterPairing` has read the queue leaves the capture paused under a valid pairing, with no alarm. The comment at `outbox.ts:49-52` overstates this. Suggested fix: stamp each pause with the paired device's id, so a pause from an older pairing is lifted.
2. **The disclosed `forgetInvalidToken` window** (`storage.ts:112-117`): a pairing stored between its read and its remove is lost.
3. **The B1 fix depends on an untested ordering:** the entry must be written before the alarm is armed (`outbox.ts:300-303`). The reviewer's "R6-race" probe catches a swap.
4. **A full queue offers no file fallback.** When queueing throws (for example the 10 MB quota), "Save as a file" stays hidden (`render.ts:206-209`).
5. **`captureFrame` has no handler for a rejected `Page.startScreencast`** (`real-popup-cdp.ts:175-185`).
6. **No repo test covers the guard's refusal paths.** The reviewer's theme-guard probe could become one.
7. **Report accuracy:** "extension 20 / 273" holds only with `dist/` built. A clean tree gives 268 + 5 skipped.

**Scope:** 81 files:
- `extension/**`;
- the `ci.yml` extension step;
- `pnpm-lock.yaml` (+3, the `link:../runner` entry);
- the packet file;
- 46 screenshots.
Nothing in `packages/`, `runner/` or `apps/`.

## UI critic (Opus): REVISE — 5 issues

Scratch: `/tmp/wc-ui5-p07b-scratch/`:
- `shots/`: 129 files (`A-*` options, `B-*` popup, `B-opt-*` the options hand-off, `P-*` probes);
- `sheets/`: contact sheets, including `cs-committed-*`;
- the stand-in scripts and the JSON results.

The clone is `/tmp/wc-ui5-p07b`, at d0e2b2c and built.

**What holds:** every round-2 issue and polish item.
- About 110 axe audits: 0 violations, 0 incomplete.
- Active text is at least 7.62:1 in light and 7.99:1 in dark.
- No horizontal scroll at a true 390, and focus lands correctly after every action.
- The dark popup against the real bridge, "Export last capture", `[hidden]`, E1, E2, E4, B3, B4 and B7–B11 are all verified.
- All 46 committed shots are accurate.

1. **The Pairing card keeps a stale outcome after a rebuild.**
   - After a revoke, the card reads "Not paired yet." with a "Paired." flash, and the code field's accessible description is "Paired.".
   - In the mirror case (un-paired here, paired in another tab), it shows a device alongside "Un-paired. You can pair again below." and no form below.
2. **The "something other than the runner" state contradicts itself.** The Status alert blames the runner ("didn't match the expected shape" / "unexpected error (HTTP 404)"), with jargon and no next step, while the line below says something else answered.
3. **The 409 refusal shows developer text:** "This eventId was already used…", with `eventId` twice and an instruction nobody can carry out. The committed `P07B-popup-not-sent-409-*` shots show it.
4. **A command outside `<code>`:** "Enter the code shown by npm run setup." at `options/main.ts:194` and `:207`.
5. **Amber for waiting.** "Pairing…" and every automatic-retry outcome in the popup have an amber edge: runner down, no answer, 500, a foreign server, token replaced. The walkthrough reserves amber for "needs a decision".

**Polish:**
- Focus sits on `<body>` during "Pairing…" and "Saving…" (up to 5 s against a silent runner), because the focused button is disabled.
- "Check again" gives no feedback when nothing changed; "Checking…" shows for 6 ms.
- The inert "Saved ✓" is 3.99:1 in light.
- Wording:
  - "Not paired yet." after an expiry;
  - "waiting until this browser is paired" next to a paired device;
  - "isn't reachable" after a real 500.
- There are no committed shots of the new states (a foreign server on the port, token replaced).

## Orchestrator decisions for revision 3 (H1–H4)

- **H1. Tone.** Amber marks a state that needs the person to act; that includes the 401 and 403 pauses, which need a re-pair, so move them from red to amber. Progress and automatic retries use a neutral edge. Red marks a refusal where the capture was not kept. Retake the affected shots.
- **H2. Plain messages.** A refusal ("drop") leads with a sentence for people and a next step: "The runner refused this capture, so it wasn't saved. Save it as a file, or reopen the popup to capture it again."
  - Known bridge codes are translated.
  - A handler's own person-facing message is kept as it is.
  - `invalid_response` and `unknown_error` in `statusFailureMessage` map to one sentence that agrees with the outbox line, for example "Something other than the runner is answering on its port. Close that program, then start the runner with `npm run runner`."
  - No field names or status codes in visible text.
- **H3. The reviewer's nits.**
  - In this revision:
    - nit 1: stamp each pause with the pairing, and lift pauses from older pairings;
    - nit 3: adopt the R6-race probe as a test;
    - nit 4: a full queue offers "Save as a file";
    - nit 5: a handler for a rejected screencast;
    - nit 6: adopt the theme-guard probe as a test of the guard's refusal paths;
    - nit 7: correct the report.
  - Nit 2 (the `forgetInvalidToken` window) is documented as a known limitation in the report and README ("if you pair at the exact moment an old token is refused, pair again").
- **H4. Screenshots.** Retake the 409 pair, the tone-changed states and the pairing-card states. Add the foreign-server and token-replaced states, in light and dark.
