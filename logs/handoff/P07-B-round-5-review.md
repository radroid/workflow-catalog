# P07-B (#12): round-5 review of head b8d0eaf (iter 005)

A narrow confirmation round over revision 4 (9529761..b8d0eaf, decisions K1–K4 in `logs/handoff/P07-B-round-4-review.md`). Both reviewers APPROVED, so PR #12 merged. The nits and polish are carried into P07-C.

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

## UI critic (Opus): APPROVE (polish only)

Scratch: `/tmp/wc-ui9-p07b-scratch/`:
- `r5-*.ts` and the `R5-*.json` results;
- `shots/` (41 files) and `sheets/cs-r5-*.png`.

The clone is `/tmp/wc-ui9-p07b`, at b8d0eaf. Everything the critic started has stopped, and 4310 is free.

**What holds:**
- **K1:** only Status's alert is announced, in both themes and with focus outside or inside the card. Cases:
  - options page: S6, S7 (from the status-page link, and from Un-pair) and S8;
  - popup-first: P13.
- **The notice:**
  - It is not live, by the logger and in Chrome's accessibility tree, but it stays in reading order.
  - It measures 19.26:1 (light) and 16.86:1 (dark).
  - When focus must move, it lands in the code field, described by the notice's sentence.
- **Own actions:** "Pairing…", "Paired." and "Un-paired." are announced once each, and the live line keeps its accessibility node across the rebuild.
- **K3:** the outbox line reads like "1 saved job waiting to send; trying again.", and the four shots are accurate.
- **K4:** a 2,147-character address gives the plain sentence. The second sentence was forced through a hook, and renders the same way.
- **Sweep:** 40 axe audits, with 0 violations and 0 incomplete. Lowest contrast 7.62:1; no overflow at 390.

**Polish (both predate revision 4):**
1. The amber notice can outlive what it describes. Pair, then un-pair, in another tab: the card keeps "Your pairing expired or was revoked." (the same early return as the reviewer's nit 2). Fix: when nothing is paired, re-derive the notice from `pairingExpired` on every sync, and clear it silently.
2. A half-typed code is dropped when a revoke rebuilds the card while focus is in the code field ("7KQ2M" becomes ""). Fix: carry the value into the rebuilt field.
