# P07-B (#12): round-4 review of head 9529761 (iter 005)

A narrow confirmation round over revision 3 (d0e2b2c..9529761, decisions H1–H4 in `logs/handoff/P07-B-round-3-review.md`). The reviewer approved; the UI critic returned REVISE with 1 issue. Revision 4 goes to the same Opus implementer, with decisions K1–K4 below.

## Reviewer (Opus): APPROVE (no issues, 2 nits)

Scratch:
- `/tmp/wc-r4-p07b-review/`: `rev3.diff`, the head and merge logs, both CI logs, `bak/`, and `mut/` (p1–p14);
- `/tmp/wc-r4-p07b-merge/`: merge commit ef1f589 onto b383772.

**What holds:**
- **Chain at the head:**
  - typecheck 6/6;
  - `pnpm test`: contracts 235, job-assistant 151, runner 155, catalog 168, extension 319 + 5 skipped;
  - lint and fixtures clean, and the porcelain is empty;
  - dist vitest with `EXTENSION_DIST_REQUIRED=1`: 324, 0 skipped.
- **CI 35920644241:** Playwright ran 36 tests and all passed, with `retries: 0` and no skips.
- **The red run 35918588650** failed exactly on gate 4's single outbox check, the race that c613ecc fixes.
- **The gate-4 fix doesn't weaken the gate.** The 10 s poll ends about 11 s after the capture reaches the bridge's journal, and a failed first try isn't retried for 30 s, so a real failure still fails the test. The implementer's delay proofs agree.
- **Invariants:**
  - the manifest is unchanged: the six permissions, and host permission only on `http://127.0.0.1:4310/*`;
  - the token travels only in the Authorization header;
  - no HTML sinks, no `eval`, no `storage.local`;
  - `package.json` and `pnpm-lock.yaml` are unchanged.
- **Mutations:**
  - 9 of the implementer's plants re-run and caught: the pairing stamp (the LIFT race), R6, the storage-failure offer, `captureFrame`'s cancel, both guard weakenings, the foreign-server mapping, the pause tones and the raw refusal text;
  - 4 of the reviewer's 5 caught, including removing each busy guard. The survivor is nit 2.
- **Merge:** onto b383772, no conflicts, and the chain is green.
- **Scope:** `extension/**`, `docs/screenshots/P07*` (46 retaken, 20 new) and the packet file, plus `logs/` from the setup merge.
- **Checklist:** items 2–12 are verified; item 1 (the README) is partial, which is nit 1.

**Nits:**
1. README step 7 (`extension/README.md:251-256`) imports an `application-session.json`, which the runner doesn't write until part C. Say where to get one, for example a hand-written fictional manifest built from `packages/contracts/src/session.ts`.
2. Only the 401 half of the foreign-server ordering is tested. Add a non-envelope 403 row to the H2 `it.each` table (`options/main.test.ts:887`).

**For the record, outside this round:** a part-A path (`build-job-capture.ts:67`) can still show zod messages in the popup's fallback.

## UI critic (Opus): REVISE — 1 issue

Scratch: `/tmp/wc-ui7-p07b-scratch/`:
- the harness scripts, and the JSON results, including `R4-opt-real-{light,dark}.json`, `R4-popup-*.json` and `committed.json`;
- `shots/` (116 files) and `sheets/cs-r4-*.png`.

The clone is `/tmp/wc-ui7-p07b`, at 9529761 and built. Everything the critic started has stopped, and 4310 is free.

**What holds:**
- **Every round-3 item is verified:**
  - the Pairing card after a rebuild;
  - one plain foreign-server sentence everywhere;
  - the 409 wording;
  - commands in `<code>`;
  - H1 tones: amber only where the person acts, neutral for progress and retries, red where nothing was kept, the reference's `.flash.ok` for success;
  - busy buttons keep focus;
  - "Check again" feedback;
  - inert "Saved ✓" at 7.17:1 light and 6.76:1 dark;
  - the wording fixes;
  - the new-state shots.
- **axe:** 116 audits, with 0 violations and 0 incomplete.
- **H2:** no field names or status codes anywhere.
- **H4:** all 66 changed or new shots are accurate.

**Issue 1. A revoked or expired pairing is announced two or three times** (the options page, both themes, any width).
- The cases:
  - "Check again" after a revoke;
  - the automatic re-check when the window regains focus;
  - opening Settings while the runner refuses the stored token.
- In each, Status's alert ("Your pairing has expired or was revoked. Pair again above.") is followed 1 ms later by the Pairing line's live text change ("Your pairing expired or was revoked.").
- If focus was in the card, focus then moves to the code field, whose description repeats the sentence a third time.
- Code: `syncPairingSection` sets the line at `extension/src/options/main.ts:326`, right after the Status view inserts the alert (`:578-579`).
- The popup-first path is fine: there the line is set before the page appears (`:754`).
- Evidence: the `S6`, `S7` and `S8` log entries in `R4-opt-real-*.json`, the `P13` entries in `R4-popup-*.json`, and `shots/O-revoked-check-again-*` and `shots/O-expired-load-*`.

**Polish:** when another program answers on the port, Status's alert and the outbox line repeat the same clause back to back. The outbox line could say "1 saved job waiting to send; trying again."

## Orchestrator decisions for revision 4 (K1–K4)

- **K1. A refused pairing is announced once, by Status's alert.**
  - On every path, the Pairing line's text is set silently, as the page-load path already does: set `aria-live="off"` for the update and restore it afterwards, or an equivalent. The visible amber line stays.
  - If focus was inside the card and its control disappears, move focus to the code field. Its description may carry the sentence, because that is read on focus, not announced.
  - Tests: live-region tests for the three cases (Check again, the focus re-check, and opening Settings with a refused token), each asserting that only the alert is announced.
- **K2. The reviewer's nits.**
  - README step 7 says where to get an `application-session.json` until part C: a hand-written fictional manifest built from `packages/contracts/src/session.ts`.
  - Optionally, the popup's "four things" list names the storage-failure outcome.
  - Add a non-envelope 403 row to the H2 `it.each` table.
- **K3. Polish.** The outbox line doesn't repeat the foreign-server clause when Status already says it. Retake the affected `P07B-options-foreign-server-*` shots.
- **K4. H2 in part A's fallback.** `build-job-capture.ts:67` shows a plain sentence in the popup's fallback, never a zod message. Add a test.
