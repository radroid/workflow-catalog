# P04 (#14): round-2 review of head f3cdec8 (iter 006)

Revision 1 was done by the Sonnet implementer; its CI run is 35954530791, green with the extension e2e. Round 2 is a second REVISE, so **revision 2 goes to a fresh Opus escalation implementer**, with decisions T1–Tn below. Any later REVISE goes back to that same escalation implementer.

## Reviewer (Opus): pending

## UI critic (Opus): REVISE — 9 issues

Scratch: `/tmp/wc-ui10-p04-scratch/r2/`. Key evidence:
- `stage-c-light-390.txt`: the background-extraction flows;
- `crops/line-clamp-long-light-390.png`: a message cut off at 390;
- `crops/committed-diff-light-390-line-midpage.png`: the screenshot defect;
- `sheets/`: contact sheets of the committed screenshots.

The clone is `/tmp/wc-ui10-p04`, at f3cdec8.

**Fixed since round 1:**
- **1:** the pinned line, with `scroll-padding-top` tracking its height.
- **3:** jobs are named from their own text.
- **5:** no focused node is rebuilt.
- **7:** the duplicate copy.
- **8:** a 175-character address fits at 390.
- **9:** screen readers hear the diff as "Removed: …" and "Added: …"; the marker glyph and spacing are right.
- **Polish:** almost all of it.

**What holds:**
- Focus never passed through `<body>`.
- All text is 4.5:1 or better, and there's no amber.
- Nothing scrolls sideways at 390.
- Paste and fetch show a real busy state.
- The event path answers in 60–180 ms, with no announcement.

**Partly fixed from round 1:**
- **2. Busy.** Try extracting again and Re-extract return in under 300 ms. Then:
  - "Extracting…" never shows;
  - the old line stays;
  - once, the line named another job's result for 2.5 s.
- **4a. Refresh.** A job whose extraction the page didn't start never refreshes. After an event capture with an 8 s turn, the job still showed "running" 11 s later, after the server had finished.
- **4b. The no-model wording.** "Set one up in Settings" points nowhere; Settings has only Budget. The runner says "Run `npm run setup` in `runner/`" elsewhere (`routes/model.ts:33`, `status.js:44`). This is the orchestrator's L12 wording, and it was wrong.
- **6. The size check.** The page counts raw bytes (`jobs.js:777`), but the contract counts `new TextEncoder().encode(JSON.stringify(text)).length` (`primitives.ts:202-207`). A 195,000-byte posting with 5,000 newlines passes the page. The server then refuses it, and the page shows "That didn't look right…" on the address field.

**New issues:**
1. **Field errors don't follow J4 and J6.3.**
   - Enter in a refused field announces only "Not saved.", and the reason isn't re-read.
   - "Can't reach the runner" and server errors are pinned to the address field, which is marked invalid (`jobs.js:790`, `:829`).
   - An address error survives a later successful paste.
2. **Field borders are 1.27:1** (WCAG 1.4.11).
   - They use the hairline `--border`, against `runner.css` G7 (lines 110–114): use `--muted-foreground`.
   - The red invalid border never shows: a more specific rule overrides it.
3. **A refresh closes the open diffs and the full posting text.** On Try extracting again, and when a background extraction finishes, the focused "Full posting text" toggle jumps 278 px at 390 (J6.6).
4. **axe serious `scrollable-region-focusable`** on the full posting-text box, in all four combinations. The box has no name, and shows Chrome's ring.
5. **J5: long messages are cut at 390.** Save messages with a not-run reason run 131–145 characters, and the two-line clamp hides the next step. A sliver of a third line shows.
6. **9 of the 29 committed screenshots don't show what they should.**
   - The four diff and four refused-private full-page shots draw the pinned line mid-page, over content.
   - The not-run viewport shot doesn't show the not-run detail.

**Polish:**
- Scroll an opened job's heading to just under the line. The heading shows Chrome's ring.
- The paused-budget message doesn't say the budget paused it, or point to Resume in Settings.
- "…or paste the text directly" appears on a pasted job.
- The paste form's optional address lacks the URL form's scheme check and its `javascript:` and `file:` wording.
- In the diff, wrapped lines and unchanged lines don't line up.
- The paste-refused shot uses the name "anchor", which isn't one of the fixture policy's companies.
- Extension captures appear only after a reload.
