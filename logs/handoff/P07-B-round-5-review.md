# P07-B (#12): round-5 review of head b8d0eaf (iter 005)

A narrow confirmation round over revision 4 (9529761..b8d0eaf, decisions K1–K4 in `logs/handoff/P07-B-round-4-review.md`). The UI critic's section is added when its verdict lands.

## Reviewer (Opus): APPROVE (no issues, 2 nits)

Scratch:
- `/tmp/wc-r5-p07b-review/`: the logs, `bak/`, `mut/`, `probe-multitab.log` and `merge-budget-probe.log`;
- `/tmp/wc-r5-p07b-merge/`: merge de53d2c, never pushed.

**What holds:**
- **K1:** the refusal sentence lives in a separate notice (`p.flash[data-notice]`, `options/main.ts:107-108`), which is never live. Both refused-token paths use it (`:362`, `:798`), and focus moves to the code field when the card rebuilds (`:361-370`). Unit tests and the Chrome e2e assert that only Status's alert is announced, each after proving the recorder hears "Paired.".
- **K2:**
  - The fixture `extension/fixtures/application-session.example.json` is fictional, valid, and test-guarded.
  - The README lists five outcomes.
  - The non-envelope 403 row catches the ordering plant; with the row removed as a control, the plant survives.
- **K3:** the outbox line says its clause once.
- **K4:** the popup's fallback is plain, never zod's text.
- **Mutations:** 3 of the implementer's plants and 5 of the reviewer's, all caught and all restored.
- **Chain at the head:** green. Extension 329 + 5 skipped; `EXTENSION_DIST_REQUIRED=1` gives 334, 0 skipped.
- **CI 35927935376:** Playwright 37/37 with `retries: 0` and nothing skipped.
- **Merge onto a1f7389**, which contains P08-A: no conflicts, and the chain is green.
  - The real-bridge tests pass 11/11.
  - A probe showed the extension parses `/status` with P08-A's `budget`, both the default and a paused state.
- **Scope:** `extension/**`, four shots and the packet file. No dependency or manifest changes.

**Nits:**
1. The popup test covers only the address sentence of K4. "This page couldn't be captured." is tested only in the builder (`build-job-capture.test.ts:109`).
2. An older gap from revision 3 (`main.ts:358`). Say this Settings page never showed the paired state, and another view learns of the refusal. Status then says "expired or was revoked", but the card stays "Not paired yet.", with no notice. `syncPairingSection`'s early return compares only the device id. Fix later: also rebuild when the expired flag differs. Reproduced in `probe-multitab.log`.
