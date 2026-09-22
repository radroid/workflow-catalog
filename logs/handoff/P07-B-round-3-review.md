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
