# P04 (#14): round-1 review of head e8b74de (iter 006)

The code head is 3e2c48d. CI 35940703381 on e8b74de is green, extension e2e included. Revision 1 goes back to the **same Sonnet implementer**, whose worktree is kept, with the decisions below. A second REVISE goes to a fresh Opus escalation.

## Reviewer (Opus): REVISE — 9 issues

Scratch:
- `/tmp/wc-rev-p04-r1-probes/`: the probes, including `lookup-probe.mjs` and `lookup-fix-probe.mjs`, the IPv6 table, the timing probes, and the CI logs;
- `/tmp/wc-rev-p04-r1-mutations/`: the backups and mutation logs.

**What holds:**
- The chain at the head, run three times, is green. The eval passed 100/100 gates each time, with job-extraction 15/15 and onboarding 65/65 and no race.
- The merge onto cdf382f has no conflicts and is green.
- CI e2e: 37 of 37. But the e2e bridge loads no route modules (`extension/e2e/real-bridge-harness.ts:158`, `modules: []`), so P04's handler never runs there.
- The `run-harness.ts` change is additive: every deleted line is a `return` re-added inside `withEvents`. Classification is unchanged, and P08-A's 92 tests pass unedited.
- **Events:** a replay returns `duplicate: true`. The same event id with a different payload gets 409.
- **The store:** writes go through `atomic.ts`, and paths through `resolveReal`. Ten concurrent captures give revisions 1–10.
- **Event and paste paths:** nothing on either path fetches the URL.
- **Addresses:** every IPv4 form is blocked, and a DNS answer with any blocked address refuses the fetch. Redirects are re-checked on every hop, capped at five, and `https:` only.
- **The fetch:** the size cap counts real bytes.
- **Extraction:** the boundary is 128 random bits. `extract_job` has a strict zod shape.
- **Scope** is clean. The fixtures sit at the top level because `fixtures.test.ts:29-33` requires it.

**Issues:**
1. **The URL fetch fails for every hostname in production** (`safe-fetch.ts:140-141`).
   - Node 24 calls the pinned `lookup` with `{ all: true }` (`autoSelectFamily`), and the callback answers `(null, address, family)`. Every fetch gets `ERR_INVALID_IP_ADDRESS`.
   - No test runs the production transport. Removing the pin (M7) or handing the transport the hostname (M6b) stays green.
2. **IPv6 forms slip through** (`safe-fetch.ts:116-125`, `:163`).
   - `isBlockedAddress` passes `::ffff:a9fe:a9fe` (169.254.169.254), `::ffff:7f00:1`, `0:0:0:0:0:0:0:1`, `0000::1`, `::127.0.0.1`, `64:ff9b::7f00:1` and `fec0::1`.
   - WHATWG URL keeps the brackets, so `https://[::1]/` goes to the resolver as a name.
   - Node never calls `lookup` for an IP-literal host, so the checked address and the connected address differ.
3. **`readable-text` is quadratic on hostile HTML** (`readable-text.ts:14,15,18`), and it freezes the bridge.
   - 160 KB of unclosed `<!--` takes 10 s. At the 2 MiB cap, that is roughly 30 minutes to 1.7 hours.
4. **`safeFetch` throws, despite "never throws"** (`safe-fetch.ts:178-195`; unguarded at `:236/249/255/259`; `captures.ts:250` doesn't catch).
   - A slow-drip body rejects with `TimeoutError`, so the route returns 500 and the page says "That didn't work. Try again."
5. **`job_capture` holds `POST /events` open for the whole model turn** (`captures.ts:196-204` → `:147`).
   - A turn can take up to 90 s, plus 5 s to cancel. The extension times out at 5 s (`bridge-client.ts:85,150`), says the runner isn't reachable, and retries a capture the runner already has.
6. **Any stray file in `jobs/`, such as Finder's `.DS_Store`, breaks every Jobs path** (`jobs.ts:73-80, 88-101, 116-125`).
   - Reading it throws ENOTDIR, so the list, paste and event paths all return 500. The extension retries forever.
7. **"Three paths produce identical records" isn't proven, and it fails for the real fixture** (`captures.test.ts:230-248`).
   - No test drives the three routes, and `/url` has no way to inject a transport.
   - The URL path's `.trim()` drops the fixture's trailing newline, so it stores a different hash from the paste path.
8. **Two security properties have no test.**
   - M3a: moving the posting text out of the boundary block stays green.
   - M8: checking the size cap after buffering the whole body stays green.
9. **The hostile-fixture check is weaker than written, and the eval's workspace fallback can't work.**
   - No test pushes `job-posting-hostile.txt` through the capture path.
   - Setting `RUNNER_WORKSPACE` inside `test()` never reaches eve's dev-host Worker, which copies the environment when it is created, after every eval file has been imported (`dev-runner.js`).
   - job-extraction passes only because `onboarding-extraction.eval.ts` assigns the variable at its top level. Without that assignment, job-extraction fails 10/15 and onboarding 17/31.
   - So the iter-006 rule "never assign it at the top level" is wrong, and is amended below.

**Nits:**
- `events.push` runs when `collectEvents` is false (`run-harness.ts:187`).
- URLs aren't normalized for dedupe.
- A redirect target is stored with its userinfo, and with no length cap.
- A gzip body isn't refused, and the declared charset is ignored.
- The timeout doesn't cover DNS, and it applies per hop, so up to 6 × 10 s.
- Script text leaks for `</script >` and for an unclosed `<script>`.
- `extract_job` can overwrite an older revision's fields.
- The event handler recomputes the content hash. That is correct: the client isn't trusted.
- A turn that fails after the tool ran keeps its fields.
- The report cites `job-tools.test.ts` for the `javascript:` and `file:` refusals, but that file has none. `file:` is untested on the event and paste paths, and the 200 KB refusal on the URL path.
- Extraction runs outside `withRun`.

**Mutation proofs:**
- The implementer's proofs 1, 2, 4 and 5 fail a test. Proof 3 does only in its "into the fields" reading (3b), not "out of the boundary" (3a).
- The reviewer's M6 and M9 fail a test. M3a, M6b, M7 and M8 stay green.

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

## Revision 1: the orchestrator's decisions (L1–L14)

Everything below stays inside P04's Owns, plus one grant in L9. You may read, and copy from, `/tmp/wc-rev-p04-r1-probes/`, `/tmp/wc-rev-p04-r1-mutations/` and `/tmp/wc-ui10-p04-scratch/`. Don't edit them.

- **L1. The production transport works, and a test proves it** (reviewer issue 1).
  - The pinned `lookup` answers both call shapes: with `{ all: true }` an array, and otherwise `(address, family)`.
  - A test drives the real transport's connection path with `autoSelectFamily` on, against a local server. It proves the connection lands on the address that was checked. `lookup-fix-probe.mjs` shows the pattern.
  - M6b (handing the transport the hostname) and M7 (removing the pin) must now fail a test.
- **L2. IP literals are checked as literals, numerically** (issue 2).
  - Strip the brackets. An IP-literal host never goes to the resolver, and the connection goes to that literal.
  - Compare numerically, with `net.BlockList` or an equivalent. Cover:
    - loopback and unspecified in any notation;
    - IPv4-mapped `::ffff:0:0/96`, IPv4-compatible `::/96` and NAT64 `64:ff9b::/96`, each checked by its embedded IPv4;
    - `fc00::/7`, `fe80::/10`, `fec0::/10`, and multicast.
  - Add one test per form in the reviewer's IPv6 table.
- **L3. `readable-text` is linear** (issue 3, and the script nit).
  - Make one pass, based on `indexOf`. An unclosed comment, script or style drops everything to the end, and `</script >` counts as a closing tag.
  - Tests: each of the reviewer's three hostile inputs at 2 MiB finishes in under about 1 s, and no script text leaks.
- **L4. `safeFetch` never throws, under one deadline** (issue 4, issue 8's M8, and the timeout, gzip and charset nits).
  - Body errors map to `timeout` or `request_failed`.
  - A redirect's body is cancelled, not drained.
  - One overall deadline covers DNS, every hop and the body.
  - Send `accept-encoding: identity`, and refuse any other `content-encoding`.
  - Honour a declared charset that `TextDecoder` supports; otherwise use UTF-8.
  - Tests:
    - a slow-drip final body and a slow-drip redirect body each resolve as `timeout`;
    - an endless body resolves as `too_large` quickly, so M8 now fails.
- **L5. A capture responds once its snapshot is saved; extraction runs afterwards** (issue 5, UI 2 and 4, and nits).
  - **When each path responds.** The event, paste and URL paths all save the snapshot, then respond. The URL path still waits for its bounded fetch.
  - **How extraction runs.** It runs in the background, one turn at a time in the runner process. It never starts while the budget is paused; the page then shows that it didn't run, and why.
  - **Extraction state.** Each revision records one state beside the snapshot: waiting, running, done, not run, or failed.
    - Keep it out of the contract's record unless the schema allows it.
    - Not run and failed carry a plain reason: the runner isn't running, no model is set up, the budget is paused, or the turn failed, timed out or returned no fields.
    - A state an earlier process left running reads as interrupted.
  - **Fields appear only after an ok turn.**
    - The turn's events must hold a successful `extract_job` call for that exact job and revision.
    - A failed turn leaves the previous fields untouched, even if the tool ran.
    - `extract_job` can't write a revision that isn't being extracted.
    - Choose either "the tool validates and the route writes" or "a staging record the route promotes". Test it.
  - **No extra extractions.** A duplicate event, or a capture whose content hasn't changed, doesn't queue another extraction.
  - **Test:** the event response arrives before a slow fake turn finishes.
  - **Deferred:** whether extraction turns count against the daily run limit goes to P08-B.
- **L6. Only job directories are jobs** (issue 6).
  - Only uuid-named directories count.
  - A damaged snapshot never breaks the list, or a capture of another job, and the page names it plainly.
  - Tests: one with `.DS_Store` and one with a damaged snapshot.
- **L7. Three paths, one rule** (issue 7).
  - The route's fetch is injectable through a factory in `captures.ts`, with no edit to `context.ts`.
  - One test drives the event, paste and URL routes with `job-posting-northwind.txt`, and compares the stored records.
  - Text is normalized by one rule on every path.
- **L8. Both security properties are tested** (issue 8).
  - A prompt test asserts that the posting text sits only between matching START and END markers carrying the same token, so M3a now fails.
  - The endless-body test is covered in L4.
- **L9. The hostile fixture goes through the real path, and `RUNNER_WORKSPACE` has one owner** (issue 9; amends the iter-006 rule).
  - A Vitest route-level test runs `job-posting-hostile.txt` through the capture path with a scripted turn. It asserts:
    - the result holds fields only;
    - no other tool is called;
    - the profile store's hash is the same before and after.
  - One small shared module sits beside the eval files and creates the eval workspace once, when it's imported.
    - Check that eve's discovery doesn't treat it as an eval.
    - `job-extraction.eval.ts` and `onboarding-extraction.eval.ts` import it, and neither assigns the variable itself.
    - **Grant:** the workspace lines of `onboarding-extraction.eval.ts`.
  - Fix the "solo run" comment. Prove the point: with the onboarding eval's import removed, job-extraction still passes. Then restore it.
- **L10. URL hygiene** (nits).
  - Stored URLs drop the userinfo and the fragment, and are validated with the contract's bounded URL schema. That includes the final URL after a redirect.
  - Don't rewrite them in any other way.
- **L11. Missing tests and small fixes** (nits).
  - Add tests for:
    - `javascript:` and `file:` on the event and paste paths;
    - the 200 KB refusal on the URL path.
  - Correct the report's citations.
  - `events.push` runs only when `collectEvents` is true.
- **L12. The Jobs page** (UI 1–9 and the polish). Follow P03's J4–J6 in `logs/handoff/P03-round-3-review.md`, and implement it in `jobs.css`, `jobs.js` and `jobs.html` only.
  1. **Outcome line.** Use P03's pinned "Last action" line: sticky, with `scroll-padding-top` tracking its height. Every outcome shows where the person is working.
  2. **Busy state.**
     - An `aria-disabled` button looks disabled.
     - "Saving…" or "Fetching…" appears after about 300 ms.
     - A new request clears the old message.
  3. **Job names.** An unextracted job is named by the posting's first non-empty line, trimmed and capped at about 80 characters, or else by the URL's path. Never by the bare hostname.
  4. **Extraction states.**
     - Each state is a plain sentence with the reason and the next step: `npm run runner` in `<code>`, "set up a model in Settings", or "try again". Each is styled for what it is.
     - A failed Re-extract says the existing fields were kept.
     - Never say "structured fields".
     - While a job's extraction runs, the page refreshes that job in place. It announces, exactly once, the result of an extraction started on the page.
  5. **Focus.** Never replace the focused node (J4). Update the detail in place, and keep focus on the button that was pressed.
  6. **Refusals.**
     - The paste form checks the size before sending.
     - Too-large gets the 200 KB sentence on every path.
     - An empty paste and an empty URL each get their own message.
     - Field errors sit beside their control, with `aria-invalid` and `aria-describedby`. The line says only the short outcome.
  7. **Duplicates** say: "Already saved: this posting hasn't changed since revision N, so nothing was duplicated."
  8. **Long addresses.** The detail's address line uses `overflow-wrap: anywhere`. A 175-character address causes no horizontal scroll at 390.
  9. **The diff.**
     - Use `<ins>` and `<del>`, or visually hidden "Added:" and "Removed:".
     - Hide the visual marker from screen readers.
     - Use `"\2212\00a0"`, and keep the marker out of the line-through.
  - **Polish.** Do all of it, except the list's position, which is your call:
    - scroll an opened job's heading into view, and mark the open row;
    - use the theme's field borders and focus ring;
    - fix the `javascript:` and `file:` refusal copy;
    - put `https://` in `<code>`;
    - include the revision numbers in the diff toggles' names;
    - say "a private or local network address";
    - drop the seconds from timestamps, and format the deadline;
    - name the job in success messages;
    - add "opens in a new tab" to new-tab links.
- **L13. Retake the screenshots.**
  - Before each capture, check that `document.documentElement.clientWidth` is 390 or 1280, and that no hover styling shows.
  - The states:
    - empty;
    - the list with extracted and unextracted jobs;
    - revisions;
    - the diff, with added and removed lines;
    - an extraction that didn't run, with its reason;
    - a refused private `https://` address, in view at the form;
    - a paste refusal with its field error.
  - Take each in light and dark, at 390 and 1280, full page. Where a full-page shot hides where the person is working, add a viewport shot.
- **L14. Mutation proofs.**
  - Re-run the five originals.
  - These must now fail a test: M3a, M6b, M7 and M8.
  - Add three more, each of which must fail a test:
    - allow the IPv4-mapped metadata address;
    - await the extraction before responding;
    - keep a failed turn's fields.

**Carried to other packets:**
- **P07-C:** the e2e bridge loads no route modules (`real-bridge-harness.ts:158`), so it never reaches P04's handler. P07-C loads the real ones.
- **P08-B:** P03's and P04's extraction turns run outside `withRun`, so the daily run limit doesn't see them. P08-B decides the policy.
