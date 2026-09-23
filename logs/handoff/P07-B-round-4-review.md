# P07-B (#12): round-4 review of head 9529761 (iter 005)

A narrow confirmation round over revision 3 (d0e2b2c..9529761, decisions H1–H4 in `logs/handoff/P07-B-round-3-review.md`). The UI critic's section is added when its verdict lands.

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
