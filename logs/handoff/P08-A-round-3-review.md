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
