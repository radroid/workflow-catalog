# P08-A (#13): round-1 review of head 0af2945 (iter 005)

A REVISE goes back to the **same Sonnet implementer** once, via SendMessage; its worktree is kept. This file is the combined list. The reviewer's section is added when its verdict lands.

## UI critic (Opus): REVISE — 9 issues

Scratch:
- `/tmp/wc-ui5-p08a-scratch/`: harness, seed and stage scripts, and `log.json`;
- the workspaces `ws/{empty,invalid,main}`;
- `shots/`: `a1` (empty), `b1` (invalid only), `c1` (records), `d*` (settings), `e*` (corrupt and daily limit), `f1` (API 500).

The clone is `/tmp/wc-ui5-p08a`, at 0af2945.

**Overall:** the pages follow the house style well, and the core mechanics work:
- newest first, and the exact cap note;
- a keyboard-operable JSON view;
- `aria-disabled` while busy;
- inert hostile error text;
- the correct decision-2 corrupt-file behaviour.

1. **The `failure` pill fails contrast** (axe serious, both themes). White on #e54b4f is 3.85:1 in light, and white on #ff5b5b is 3.04:1 in dark. The style is P02's `.badge.fail` in `runner.css`. Fix: dark text on the red fill, like `.badge.warn` (about 4.7:1 light, 5.9:1 dark).
2. **Error text fails contrast** (light, 3.75:1). `.status-message.error` in `runs.css` and `settings.css` uses `var(--destructive)` text. Fix: foreground text with a destructive marker (a left border, "Error:"), or a red that measures at least 4.5:1.
3. **Resume loses focus.** The button sits inside `#budget-pause`, which is hidden on success, so focus falls to `<body>`. Fix: move focus to a stable element first, for example `#budget-title` with `tabindex="-1"` or the first input.
4. **Out-of-range input shows no page error.** Tried: 0, 51, 21, 2.5 and empty.
   - Only the native tooltip appears. There is no live-region message, no `aria-invalid`, no inline text, and the bounds are shown nowhere.
   - A server 400 would show raw ("Invalid request body at dailyRunLimit: Too big…").
   - Fix: bounds as hint text linked with `aria-describedby`; on an invalid submit, one plain sentence in the live region ("Daily run limit must be a whole number from 1 to 50."), `aria-invalid`, and focus kept; never the raw 400 text.
5. **Horizontal scroll at 390 from long unhyphenated model ids.** Measured `scrollWidth` 515–794. Fix: `overflow-wrap: anywhere` and `min-width: 0` on `.run-meta` or its `code`.
6. **The empty state repeats itself.**
   - "No runs yet." (the live region) is followed by "No runs yet…", and there is an empty `<ul>`.
   - With only an invalid file, the same sentence shows twice plus an amber note.
   Fix: one empty-state message, not echoed into the live region on load, and the empty list hidden.
7. **Full UUIDs and raw internal names are visible.**
   - Each card shows the full `runs/<date>/<uuid>.json`.
   - `Model n/a` (the NO_MODEL placeholder) appears on paused, interrupted and thrown records.
   - `MODEL_CALL_FAILED: …` appears in a reason.
8. **Amber is used for things that aren't decisions.**
   - The catch-up mark is `badge warn`.
   - The skipped-file note uses `notice decision` but doesn't name the file (the API returns only a count).
   - Every past `paused` pill is amber.
   Settings' current-pause notice uses amber correctly.
9. **Corrupt budget.**
   - The reason's path isn't in `<code>`.
   - The inputs show the defaults without saying so.
   - After Save the page says "Saved." while still showing "Paused: budget settings unreadable…", although the file is now valid.
   - Resume silently writes the defaults and says only "Resumed.".

**Polish:**
- **P1.** "Exceeding either pauses runs…" is untrue: the item cap never pauses, and at the daily limit there is no "new runs wait until tomorrow" line.
- **P2.** The Settings intro promises sections that don't exist; pairing is on Status.
- **P3.** A record with no `finishedAt` reads "failure — interrupted", which will also describe a run still in progress. It also shows "0 ms · 0 · 0 · n/a".
- **P4.** Put the reason next to the outcome pill.
- **P5.** Token counts have no thousands separators.
- **P6.** The "View JSON" controls share one name, and they use the browser's focus ring rather than `--ring`.
- **P7.** The trailing ellipsis in "No runs yet…" reads like loading.
- **P8.** The Resume button touches "Runs used today", and Resume and Save are both primary.
- **P9.** The first "Saved." pushes the card 40px under the pointer. "Saved." and "Resumed." will be ambiguous once more sections join, and a repeated "Saved." may not be re-announced.
- **P10.** "Failed to fetch" should read "Can't reach the runner. Is it still running?"
- **P11.** Input borders are 1.27:1 against the card; WCAG 1.4.11 asks 3:1.

**Verified:**
- newest first; runs used today; `aria-disabled`; focus on Save and the JSON view; inert HTML in errors;
- the decision-2 behaviour;
- all 16 committed screenshots, correctly named, at true width and full page, covering the prompt's list. They show issues 1 and 6, so they need retaking.
