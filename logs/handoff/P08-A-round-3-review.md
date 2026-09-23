# P08-A (#13): round-3 review of head 2c02190 (iter 005)

A narrow confirmation round over the Opus escalation's revision 2 (371cd63..2c02190, decisions I1–I4 in `logs/handoff/P08-A-round-2-review.md`). The reviewer's section is added when its verdict lands.

## UI critic (Opus): APPROVE (polish only)

Scratch: `/tmp/wc-ui7-p08a-scratch/`:
- the scripts and `log.json`;
- the workspaces `ws/{records,skipped,invalid,folder,mixed,runsdir,runlog}`;
- `shots/` (100 files) and `sheets/sheet-*.png`.

The clone is `/tmp/wc-ui7-p08a`, at 2c02190. Everything the critic started has stopped, 4340 is free, and permissions are restored.

**What holds:**
- **Round-2 issue 1:** the skipped-file note shows 10 short paths, each in `<code>` with the full path in `title`, then "and 2 more.". No UUID walls.
- **Round-2 issue 2:** corrupt-budget recovery matches the file on disk at every step, whether Save then Resume, or Resume directly.
- **Round-2 issue 3:** "Copied" and "Couldn't copy" appear beside the button on cards 7 and 14, at both widths. Nothing moves, and each press is announced once.
- **Polish:**
  - P2: the lede lists only real sections.
  - P4: the reason sits beside the pill.
  - P9: a 0 px shift in all cases, 320–1280 px.
  - Unique names for Copy path and View JSON.
  - `--ring` on the focused heading.
  - The JSON view matches the file on disk.
- **The implementer's extra fixes:** the pause path stays on one line at 390, and the "records or folders" wording is in (partial; see P-b).
- **The new states:**
  - The run-log pause `run log unreadable (runs/<date>/)`: amber, with Resume hidden and usage "unknown". It clears on its own once the folder is readable.
  - A timed-out run before its first step shows its duration and tokens without a model.
- **Shots:** all 40 committed shots are accurate.
- **Sweep:**
  - axe: 0 findings of any kind in every state;
  - one announcement per outcome; focus never lost; `aria-disabled` while busy;
  - contrast at least 7.6:1; no horizontal scroll at 390;
  - hostile HTML stays inert.

**Polish:**
- **P-a. "No runs yet." when `runs/` itself can't be read.** The skipped note is followed by "No runs yet.", which isn't true. Settings in the same state shows the budget-file pause and promises that Resume restarts runs, but Resume answers 500 "The runner hit an unexpected error." Fix: hide or reword the empty-state line when `invalidCount > 0`.
- **P-b. Folder wording.**
  - A lone folder reads "record or folder".
  - The "records or folders" check looks only at the first 10 listed entries, so an unreadable day-folder can hide inside "and 3 more.".
  - Fix: list folders first, or have the server flag them.
- **P-c. The run-log note.** "Resume can't clear this pause." names a hidden button and doesn't say what to do. Suggested: "Runs restart on their own once the runner can read this folder again; check its permissions." With a stored pause on top, usage reads "unknown" with no reason until Resume is pressed.

## Reviewer (Opus): APPROVE (no issues, 6 nits)

Scratch: `/tmp/p08a-r3-review/`:
- the probes `probe-i1.txt`, `probe-prebody.txt` and `probe-extra.txt`, with their sources in `probes/`;
- the time-zone runs, `mut/` (`summary.txt`), and the chain logs;
- the clones `merge-clone/` and `p03-trial-clone/`.

**What holds:**
- **I1**, probed with the real `Client`:
  - the spike's normal sequence and the task-mode sequence are ok, with 0 cancels; through `withRun` the record is `success` and the key is done;
  - `turn.cancelled` gives a failure that is not done;
  - a non-empty `input.requested` parks, with 1 session cancel;
  - an empty list is ok.
  - All three I1 plants are killed.
- **I2**, the pre-body probe, with 0 unhandled rejections:
  - chmod 000 on today's folder, or on `runs/`: `withRun` resolves with an in-memory failure, and `/status`, the budget route and the runs route all stay 200;
  - chmod 300 on today's folder writes a `paused` record;
  - empty, whitespace, undefined or non-string keys get the fixed failure, and the body never runs.
- **I3:** nits 1–8 all met, 129/129 under both Kiritimati and Pago Pago.
- **I4, the code side:**
  - messages come from the server's state;
  - the JSON view equals the file on disk;
  - `absolutePath` appears only in the local runs API;
  - skipped names are capped at 10 and never reach an HTML sink.
- **Mutations:** 9 of the implementer's plants re-run and killed; the reviewer's own 4 of 5 killed (R1 is nit 1).
- **Chain:** green at 2c02190 and on the merge onto 09f8bbe. CI 35922498349 passed.
- **P03 trial merge** (5612d69): only `route-modules.test.ts` conflicts. With P03's readdir version, the runner passes 560/560.
- **Scope:** the Owns list, G7's two `runner.css` edits, and the `"runs"` line. No dependency changes.

**Nits, carried as follow-ups:**
1. Nothing tests a body that returns `{ turns: [] }`, the `n/a` side of nit 8 (`run-harness.ts:372`).
2. "eve is not running" is recorded as model `unknown` with 0/0 tokens. Keep `n/a` when no turn reached eve (`:151`, `:372`).
3. `hasSucceededWithIdempotencyKey` (`runs.ts:314-330`) rejects when a folder can't be listed, and doesn't document it. A rejection means "unknown", never "not done"; P05 and P08-B must not write `.catch(() => false)` around it.
4. `GET /api/runs/:runId` returns 500 when `runs/` is unreadable (`runs.ts:286`). Catch it as `listRuns` does.
5. An `authorization.required` with no `webhookUrl`, followed by `session.waiting`, reads as ok. It isn't reachable in P08-A (no connections). It goes into `eve-runtime.md` item 15 as a note for P05.
6. For information: `pauseBudget` (`run-harness.ts:205`) can reject if `runs/budget.json` can't be written; `withRun`'s body catch contains it.
