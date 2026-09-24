# P04 (#14): round-1 review of head e8b74de (iter 006)

The code head is 3e2c48d. CI 35940703381 on e8b74de is green, extension e2e included. Revision 1 goes back to the **same Sonnet implementer**, whose worktree is kept, with the decisions below. A second REVISE goes to a fresh Opus escalation.

## Reviewer (Opus): pending

## UI critic (Opus): REVISE — 9 issues

Scratch: `/tmp/wc-ui10-p04-scratch/`:
- the harness, its scripts and `log.json`, with the focus trails and the live-region text;
- `shots/`: 150 files;
- `sheets/`: contact sheets, including `committed-*.png` for the committed screenshots.

The clone is `/tmp/wc-ui10-p04`, at e8b74de.

**What holds:**
- The page matches the theme: monochrome, hairline cards, Geist, and no amber.
- axe found zero serious or critical findings in 68 audits: 17 states, both themes, at a true 390 and 1280.
- All text measured at 4.5:1 or better.
- There is one live region, and it announced each outcome exactly once.
- Jobs is in the shared navigation on all six pages, with `aria-current`.
- Enter submits, and the tab order follows reading order.
- No IDs or status codes appear in visible text.
- The committed screenshots are present and distinct, in the right theme, and their names match their content.

**Issues:**
1. **Outcomes land off-screen.** The only outcome line is at the top of a long page. After Fetch and save, Try extracting again or Re-extract, it sits 250–1,500 px above the pressed button, so a sighted person sees nothing change.
   - Evidence: `shots/b-url-metadata-light-390-viewport.png`, `shots/b-url-metadata-dark-1280-viewport.png`, `shots/c-retry-no-model-light-390-viewport.png`.
2. **Busy is invisible.** 800 ms into a request the button still looks active, and the previous outcome stays in the line. With a model, a save can take up to 90 s for the extraction plus 10 s for the fetch.
   - Evidence: `shots/f-busy-url-submit-light-390-viewport.png`, `shots/f-busy-paste-submit-dark-1280-viewport.png`.
3. **Unextracted jobs are all called "jobs.example".** Four of five rows, and the detail heading, show the bare hostname, so rows differ only by date and revision count.
   - Evidence: `shots/c-list-several-light-390.png`, `shots/c-list-several-dark-1280.png`.
4. **Extraction messages give no reason and no next step.**
   - After a paste: "Saved a new job. Structured fields were not extracted yet.", styled as success.
   - After a retry: the same sentence, styled as an error.
   - After Re-extract: the same sentence, while the kept fields show right below it.
   - "Not run" and "failed" read the same, because `captures.ts` folds every non-ok turn into one message. "Structured fields" echoes an internal key.
5. **A focused node is rebuilt.** Try extracting again and Re-extract call `detail-body.replaceChildren()`, which removes the pressed button, so focus falls to `<body>` before it reaches the heading. Seen at 390 light and 1280 dark.
6. **Paste refusals don't say what's wrong.**
   - 210,000 characters: "That didn't look right. Check the address and the posting text…"
   - 300,000 characters: "That didn't work. Try again."
   - The page's own "over 200 KB" sentence is never returned on the paste path.
   - An empty paste gets the same generic sentence.
   - The URL form's empty-submit message mentions "the posting text", which that form doesn't have.
   - No field is marked invalid.
   - Evidence: `shots/b-paste-too-large-300k-light-390-viewport.png`, `shots/b-url-empty-light-390-viewport.png`.
7. **A duplicate paste doesn't say that nothing was duplicated.** It says "This posting hasn't changed since it was last saved.", while the walkthrough says "… nothing was duplicated."
8. **Horizontal scroll at 390.** A realistic tracking address of about 175 characters makes the page 464 px wide in both themes. The detail's address line has `overflow-wrap: normal`.
   - Evidence: `shots/d-long-url-light-390.png`, `shots/d-long-url-detail-light-390-viewport.png`.
9. **The diff relies on punctuation, and its "removed" marker is broken.**
   - Screen readers hear "−- 4+ years…" and "+ - 5+ years…": no "added" or "removed", and the strikethrough isn't exposed.
   - `content: "\2212 "` loses its space, because the CSS escape consumes it, and the line-through crosses the minus sign.
   - Contrast is fine.
   - Evidence: `shots/c-diff-closeup-light-390.png`, `shots/c-diff-closeup-dark-1280.png`.

**Polish:**
- An opened job's heading lands at the bottom of the viewport, and the open row isn't marked (`shots/c-open-ledgerkit-light-390-viewport.png`).
- Inputs keep the browser's 2px inset border and Chrome's blue focus ring, instead of the theme's (`shots/a2-focus-paste-url-light-1280.png`).
- A two-line message at 390 pushes the forms down by about 24 px.
- The `javascript:` and `file:` refusals say "paste … for an http:// page". `https://` in messages isn't in `<code>`.
- Both diff toggles are named "What changed from the previous revision".
- "Loopback address" is jargon, timestamps show seconds, and the deadline shows as a raw ISO date.
- Success messages don't name the job.
- The saved-jobs list sits below both forms.
- Links open a new tab without saying so.

**The committed screenshots:**
- The "390" files are a 375 px layout, and the "1280" files a 1265 px layout. A desktop scrollbar took 15 px, even though `innerWidth` read 390 and 1280.
- The refused-url set shows only the `http:` refusal, taken full page from the top. There is no private-address `https:` refusal, and the message isn't shown where the person is working.
- Revisions-390, light and dark, caught a hover underline.
- The diff shots show only added lines, so there is no removed line.
- Two of the three seeded jobs were pre-extracted, so the all-hostname list never appears.

**States it couldn't reach for real:** a successful URL fetch, and a real timeout or DNS failure, which need the network; and a live extraction, which needs a model. Those were stubbed in the browser with the server's exact error codes.
