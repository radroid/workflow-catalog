# P04 · Job capture

Status: claimed (iter 006)
Assignee: iter-006 escalation implementer (Opus), revision 2 (T1–T21); round 0 and revision 1 by the iter-006 implementer (Sonnet)
Blocked by: P03
Owns: runner/server/routes/captures.ts, runner/store/jobs.ts, runner/lib/safe-fetch.ts, runner/lib/readable-text.ts, runner/agent/tools/ (the job-extraction tool only), the eval-agent re-export, fixture and tool-registry entries and eval for it, runner/ui/jobs.html and its script, runner/test/ (new tests for these files), packages/job-assistant/fixtures/jobs/
Spec: F6, hard-problems #3

## Goal
A job posting becomes a versioned snapshot from any of three paths, and the snapshot is data.

## Deliverables
- `POST /events` handling of `job_capture` from the extension: bounded text, extractor version, content hash, dedupe by URL into revisions.
  - URL validation follows the contract's `httpUrlSchema`: http or https, and no other scheme.
  - A captured or pasted URL is provenance only; nothing on those paths fetches it.
  - Only the URL-fetch path is https-only (decision, iter 005: `logs/blocks.md`, "P04 URL rule").
- Paste path in the local UI. The URL path is a local-UI route in `routes/captures.ts`, not a model tool: model tools take IDs only (iter-003 decision).
  - It fetches through `runner/lib/safe-fetch.ts`: https only; no loopback, private, link-local or metadata addresses, checked after DNS resolution and on every redirect; a redirect limit, a size cap and a timeout; `text/html` or `text/plain` only.
  - It extracts the text with `runner/lib/readable-text.ts`.
  - P03.1 reuses both modules, so give each a small documented interface and its own tests. Tests use an injected resolver and a local fake server, never the real network.
- Structured extraction of `{ title, company, location, requirements[], niceToHave[], deadline?, applyUrl }` from the snapshot text into typed fields; the raw text is never placed in a system prompt.
- Jobs page: list, revisions, "posting changed" diff.

## Acceptance
- Three paths produce identical snapshot records for the same fixture text.
- Same URL captured twice with changed text → revision 2; revision 1 retained.
- Hostile posting fixture: extraction returns fields only; no action tool called; profile unchanged (assert store hash before/after).
- Rejected inputs:
  - `javascript:` and `file:` URLs on every path, and `http:` on the URL-fetch path;
  - loopback, RFC 1918, link-local and `169.254.169.254` targets, including after a redirect or a DNS answer;
  - bodies over the cap, and text over 200 KB.
- `job_capture` gets its handler here: today the bridge journals it as `no_handler`. The route module declares the event, and `route-modules.test.ts` needs no edit after P03's revision (D2).

## Out of scope
Preparation, sessions, the extension itself (P07 sends the envelope; this packet accepts it).

## Report

### 2026-09-24 — Revision 2 (iter-006 Opus escalation, T1–T21)

**PR:** [#14](https://github.com/radroid/workflow-catalog/pull/14) `packet/P04` → `overnight/integration`. Revision 2 started from `f3cdec8`, the head reviewed in `logs/handoff/P04-round-2-review.md`. The code is final at `436cc75`, and this report is the commit after it.

| Commit | What | CI run, result |
|---|---|---|
| `2d725f4` | Merge of `origin/overnight/integration` at `214ef69`: GOALS.md, the P02.2 packet and prompt, the P04 escalation prompt and round-2 review, the packet index and logs/. No conflicts; git's default merge message, left as it is. | pushed with `9137d53` |
| `9137d53` | Claim | `35958595732`, success |
| `c646c84` | T4, T7: `safe-fetch.ts` | `35958978393`, success |
| `80d443b` | T1–T3, T5, T6, T8–T10: the route, the store, the tool, the text rule and the eval workspace | `35960511358`, success |
| `212ae31` | T11–T19, and T6 on the page | `35962197873`, success |
| `436cc75` | T20 screenshots; T18 lines that name a job fitted to 80 characters; T11 the open row follows its detail; the README's refresh sentence | `35964641638`, success |
| (this commit) | This report | see the reply |

Every run passed every step, including "Build and test the extension (vitest against dist/, then Playwright)". On `436cc75` that step ran 37 Playwright tests (2.1 m) and 334 of 334 dist tests, and the Test step ran the runner's 830 tests plus 105 of 105 gates.

**Scope.** Everything changed is in P04's Owns or a grant:
- `runner/server/routes/captures.ts`, `runner/store/jobs.ts`, `runner/lib/safe-fetch.ts` and `runner/lib/readable-text.ts`;
- the tool: `runner/agent/tools/extract_job.ts`, `runner/agent/lib/extract-job-logic.ts` and `extract-job-schema.ts`, the eval-agent re-export, `job-extraction.eval.ts`, and `eval-workspace.ts` for T8;
- `runner/ui/jobs.html`, `runner/ui/assets/jobs.js` and `jobs.css`;
- P04's tests, plus two new files: `runner/test/shared-workspace-env.test.ts` and the TLS helper `runner/test/tls-fixture.ts`;
- `runner/README.md` (the Jobs lines), `docs/screenshots/P04-*` and this file.

Not touched: `packages/contracts`, `context.ts`, `events.ts`, `settings.ts`, `doctor.ts`, `runner.css`, P03's pages, `extension/`, `runner/package.json` and `pnpm-lock.yaml`. `run-harness.ts` keeps revision 1's one addition. The L9 grant (`onboarding-extraction.eval.ts`) wasn't needed, and `packages/job-assistant/fixtures/jobs/` is unchanged.

**T1–T21.** The page's DOM tests (`runner/test/jobs-page.test.ts`) run the page's own script in happy-dom against the bridge's real routes. The Chromium measurements are listed after this table.

| Item | What changed | Proved by |
|---|---|---|
| T1 | `extract_job`, in both agents, checks the fields and returns them; it never writes (`checkExtractedJob`). After an ok turn, the queue in `captures.ts` saves the fields from that turn's own accepted `extract_job` result (`extractedJobFields`), and only for the job and revision it extracted. The last accepted call wins. A failed turn, a turn that isn't ok, or an ok turn with no fields keeps the fields already saved, so a running Re-extract shows the previous fields. The route tests' scripted turns carry a real `extract_job` result from the real check, and none calls `recordStructured`. `job-extraction.eval.ts` reads the fields the same way and checks that the snapshot stays unwritten (20 gates, up from 15). | `captures.test.ts`: "saves the fields from the turn's own extract_job result once the turn ends ok"; "a Re-extract whose turn calls extract_job and then fails keeps the fields already saved"; "during a running Re-extract the previous fields are shown, and the new ones only once its turn ends ok"; "a turn that isn't ok counts as not extracted, even with an accepted extract_job result inside it"; "an ok turn returns the accepted fields for exactly this job and revision"; "an ok turn that found nothing keeps the fields already saved". `extract-job-logic.test.ts`: `checkExtractedJob` (7 tests) and `extractedJobFields`. `job-tools.test.ts`, for both agents: "accepts and returns the fields … and never writes the snapshot". Mutations T1, L14-5, L14-keepfailed. |
| T2 | A `waiting` or `running` state records the runner process that wrote it. The API never shows that owner. A state from another process, or with no owner, reads as `interrupted`, and a retry queues it again. The page stops its 2 s refresh once nothing it shows is waiting or running (T11). | `captures.test.ts`, the T2 `it.each` (waiting, waiting with no owner, running): "… left by an earlier process reads as interrupted everywhere, and a retry queues it again". Also "a waiting state this process wrote carries its owner, which the API never shows", and `jobs-store.test.ts` "keeps the owner of a waiting or running state". Mutation T2. |
| T3 | The queue runs `extractionPreflight` again just before each turn. A queued revision whose turn can't start records `not_run` with that reason, for example `budget_paused`, and no turn runs. A revision whose snapshot became unreadable while it waited records `failed`/`unreadable`. | `captures.test.ts`: "the first turn hits a provider limit and pauses the budget; the second never starts, and records not run"; "a revision whose snapshot became unreadable while it waited records failed/unreadable, and no turn runs for it". Mutation T3. |
| T4 | `safeFetch` makes one `AbortSignal` for the whole call and hands it to the transport. DNS, every hop and every body read race it. A failure is classified by cause: the deadline gives `timeout`, any other error or abort gives `request_failed`, and only the byte cap gives `too_large`. The real transport throws the same `ECONNRESET` "aborted" for a deadline and for a reset, so the error's name can't decide. The mistitled test now asserts what its title says. Every time bound has at least 4× headroom over its deadline; the flaky one is now 1000 ms against 250 ms. | `safe-fetch.test.ts`, with the real `nodeHttpsRequest` against a local TLS server (`test/tls-fixture.ts`: an in-memory self-signed certificate, nothing written to disk): "a slow-drip body gives timeout, not too_large"; "a reset mid-body gives request_failed, not too_large"; "an endless body gives too_large at the default 2 MiB cap"; "a redirect whose body drips is cancelled, and its target still loads". Unit tests: "resolves request_failed, not too_large, when the body stream throws mid-read before the deadline"; "resolves request_failed for an abort that is not the deadline"; "reports request_failed, not timeout, for an AbortError that is not the deadline". Mutation T4. |
| T5 | `normalizePostingText` (`readable-text.ts`) is the one rule. It folds CRLF and lone CR, collapses spaces and tabs, trims each line, keeps one blank line at most, and trims the whole. It is idempotent, and `extractReadableText`'s output is already a fixed point of it. The event, paste and URL paths each apply it once, and `captureAndExtract` takes only text it has already normalized. Whitespace-only text is refused plainly: a 400 on paste, and on the event path a typed 422 through the events module, journaled `rejected` (never `handler_failed`, and never retried by the extension). | `captures.test.ts`, "one text rule on every path": the Northwind fixture as written, and again with a double space, trailing spaces and CRLF, gives the same text and hash on all three real routes. Also "a re-paste that differs only in whitespace creates no revision and no new extraction", "refuses whitespace-only pasted text with a plain 400 (never a 500)", "captureAndExtract takes only text the shared rule already normalized …", and the event path's "refuses whitespace-only text with a typed 422 …". `readable-text.test.ts`: "normalizePostingText" (5 tests). Mutation T5. |
| T6 | Damaged files are named, never skipped. A job whose latest revision can't be read stays in the list. It is named by the URL that a readable file of the job records, and `unreadable` lists each bad file's path (`jobs/<id>/snapshot-<n>.json`), which the page shows in `<code>` on the row and in the detail. A job with no readable revision still lists, last, and opens. An unreadable extraction state reads as `interrupted`, and a retry rewrites it. A Re-extract of an unreadable revision gets a plain 409 naming the file. A recapture of the URL lands in the same job, as the next revision. | `jobs-store.test.ts`: 4 tests under "JobsStore resilience". `captures.test.ts`: the 5 tests in "damaged data is named, never a 500 and never a silent gap". `jobs-page.test.ts`: the 2 tests in "damaged files are named, never hidden". `extract-job-logic.test.ts`: "refuses a revision whose extraction state file is damaged". Screenshots `P04-jobs-unreadable-*`. Mutation T6. |
| T7 | `safeFetch` hands the transport the address that the resolver answered and the check passed, never the hostname. This holds for DNS names as it does for literals. Newly blocked: `::ffff:0:0:0/96` (checked by its embedded IPv4), `64:ff9b:1::/48` and `2002::/16` (entirely), `198.18.0.0/15` and `192.0.0.0/24`. | `safe-fetch.test.ts`: "hands the transport the address the resolver answered and the check passed, never the hostname" (a recording transport), and "fetches a DNS name end to end over TLS, connecting through the checked address (M6b for a DNS name)". `isBlockedAddress` has 11 new blocked cases and 6 allowed neighbours. Mutations T7 and L14-M6b. |
| T8 | When the coordination variable is already set, `openOrCreateEvalWorkspace` opens that workspace and sets `RUNNER_WORKSPACE` to the same path. | `shared-workspace-env.test.ts` (new, 4 tests): both variables set ambiently to different workspaces; a second call from the other eval file's copy of the module; an ambient `RUNNER_WORKSPACE` alone (as GitHub Actions sets) is never taken for the eval workspace; a coordination variable that names no workspace fails closed. Mutation T8. |
| T9 | A revision already waiting or running in this process isn't queued again. The retry answers with its current state. | `captures.test.ts`: "two concurrent Re-extracts of one revision queue one turn, and a third while it runs queues nothing". Mutation T9. |
| T10 | Accepted as decided, with no code change. Every path stores the WHATWG serialization, after dropping userinfo and the fragment. The README's Jobs lines say so. | `captures.test.ts`: "every path stores the same WHATWG serialization of one address, so the captures dedupe". |
| T11 | One refresh loop covers the list and the open job, updating both in place. It runs every 2 s while a job the page shows is waiting or running, and every 5 s otherwise. It runs only while the page is visible, and refreshes at once when the page becomes visible again. An accepted Try extracting again or Re-extract says "Extracting “<job>”…" at once and shows the job as running, and its result is announced once. Only extractions the page started are announced; extension captures join on the 5 s refresh, silently. In `436cc75` the open job's row takes its state from the detail, which is read after the list, so the two never disagree. | `jobs-page.test.ts`, the 5 tests in "extraction in the background (T11)", including "the open job's row never disagrees with its detail: the detail, read after the list, wins". Chromium figures below. Screenshots `P04-jobs-running-*`. Mutation T11-row. |
| T12 | No model: "No model is configured. Run `npm run setup` in `runner/`, then try again.", the runner's own wording, with the command and folder in `<code>`. A paused budget: "The budget is paused, so nothing was extracted. Resume it in Settings, then try again.", with Settings linked. A provider limit says that the budget is now paused, with the same link. A pasted job never offers "…or paste the text directly". | `jobs-page.test.ts`, the 3 tests in "extraction wording (T12)". Screenshots `P04-jobs-not-run-*` and `P04-jobs-paused-*`. |
| T13 | The page measures `new TextEncoder().encode(JSON.stringify(text)).length`, as the contract does. Every too-large refusal on the paste path lands on the text field, whether the page or the runner refuses it. | `jobs-page.test.ts`: "measures the paste the contract's way: 195,000 bytes with 5,000 newlines is over 200 KB as JSON, and is refused on the text field"; "a too-large refusal from the runner lands on the text field, never the address". `captures.test.ts`: "measures the cap the contract's way, as JSON …". |
| T14 | After Enter, focus stays in the refused field and the line carries the short reason ("Not saved: the address is empty."). From the button, focus moves to the refused field and the line says only "Not saved.". "Can't reach the runner", server errors and a page that couldn't be fetched go in the line only: never on a field, and never with `aria-invalid`. A field error clears when its field changes, or when a later action succeeds. | `jobs-page.test.ts`, the 7 tests in "field errors (J4, J6.3, T14)". Screenshots `P04-jobs-paste-refused-*` (from the button) and `P04-jobs-refused-private-*` (Enter in the field). |
| T15 | Field borders use `--muted-foreground`, following runner.css G7, in `jobs.css`. The invalid rule is more specific, so its red border wins, and a 1 px inset shadow in the same red doubles it. | Chromium contrast figures below. |
| T16 | A refresh reads each section's open state from the live DOM, reuses unchanged diffs, and never moves a focused control: if a render shifts it, the page scrolls back by the difference. Handlers act on the live node. | `jobs-page.test.ts`: "a refresh keeps the open diff and the full posting text open, and the focused toggle keeps focus". Chromium figures below. |
| T17 | The posting-text box is a focusable (`tabindex="0"`), labelled region ("Full posting text, revision N") with the theme's 2 px ring. | `jobs-page.test.ts`: "the full posting text is a focusable, labelled region". Chromium: axe clean in all four combinations (below). |
| T18 | Every line message is one sentence, consequence first, of 90 characters or fewer. A line that names a job is fitted to 80 (`NAMED_LINE_MAX`, `436cc75`), shortening the name with an ellipsis. Reasons and next steps live in the job's detail. In `jobs.css` the two-line clamp sits on the line's inner body, which has no padding, so no sliver of a third line shows. The whole sentence stays in the text node and in its `title`. | `jobs-page.test.ts`: "every line message is one sentence of 90 characters or fewer, and 80 or fewer when it names a job, however long the name". Chromium figures below. Mutation T18. |
| T19 | An opened job's heading scrolls to 12 px under the line and shows the theme's focus ring. The paste form's address gets the fetch form's scheme check, with its own wording. Wrapped and unchanged diff lines share one grid column with the changed text. | `jobs-page.test.ts`: "opens a job (moving focus to the detail heading), shows both revisions, and the diff between them, every line in the same text column"; "the paste form's address gets the fetch form's scheme check, with its own wording". Chromium figures below. |
| T20 | The 41 screenshots listed below. | — |
| T21 | 22 mutations: 21 run and killed, and M7 not run. | The table below. |

**The round-2 reviewer's issues.**

| Issue | T | Commit | Test |
|---|---|---|---|
| 1. A failed turn overwrites the previous fields | T1 | `80d443b` | "a Re-extract whose turn calls extract_job and then fails keeps the fields already saved"; "during a running Re-extract the previous fields are shown …" |
| 2. A `waiting` state from an earlier process never clears | T2, T11 | `80d443b`, `212ae31` | the T2 `it.each` (waiting, waiting with no owner, running) |
| 3. A budget pause doesn't stop queued turns | T3 | `80d443b` | "the first turn hits a provider limit and pauses the budget; the second never starts, and records not run" |
| 4. A slow page is reported as too large | T4 | `c646c84` | "a slow-drip body gives timeout, not too_large"; "a reset mid-body gives request_failed, not too_large" (real transport, local TLS) |
| 5. "One rule on every path" is only `trim()` | T5 | `80d443b` | the three-routes test with a double space, trailing spaces and CRLF; "a re-paste that differs only in whitespace creates no revision …" |
| 6. Damaged data isn't named plainly | T6 | `80d443b`, `212ae31` | the T6 tests in `jobs-store`, `captures` and `jobs-page` |
| Nit: M6b is covered only by the IPv6-literal test | T7 | `c646c84` | "hands the transport the address the resolver answered …"; "fetches a DNS name end to end over TLS …" |
| Nit: the timing test at `:530` failed once in seven | T4 | `c646c84` | every bound has at least 4× headroom, and each timing test asserts the reason |
| Nit: `openOrCreateEvalWorkspace` doesn't reset `RUNNER_WORKSPACE` | T8 | `80d443b` | `shared-workspace-env.test.ts` |
| Nit: whitespace-only text gives a 500 | T5 | `80d443b` | "refuses whitespace-only pasted text with a plain 400"; the event path's typed 422 |
| Nit: two concurrent Re-extracts queue two turns | T9 | `80d443b` | "two concurrent Re-extracts of one revision queue one turn …" |
| Nit: a retry that reports `running` isn't watched | T11 | `212ae31` | "a job the page didn't start is watched and updated in place, with no announcement" |
| Nit: five ranges still allowed | T7 | `c646c84` | the new `isBlockedAddress` cases |
| Nit: `stripUrlForStorage` re-serializes the whole URL | T10 | `80d443b` | "every path stores the same WHATWG serialization …"; the README |
| `RUNNER_WORKSPACE` in production | — | — | P02.2's. Nothing here touches it. |

**The round-2 UI critic's issues.**

| Issue | T | Commit | Proof |
|---|---|---|---|
| Round-1 item 2, busy: "Extracting…" never shows, and the line named another job | T11 | `212ae31` | "an accepted Try extracting again says “Extracting …” at once, shows the job as running, and announces its result exactly once"; Chromium: line at 33 ms, running at 38 ms |
| Round-1 item 4a, refresh: a job the page didn't start never refreshes | T11 | `212ae31`, `436cc75` | "a job the page didn't start is watched and updated in place …"; "the open job's row never disagrees with its detail …" |
| Round-1 item 4b: "Set one up in Settings" points nowhere | T12 | `212ae31` | "no model: the runner's own wording, with the command and folder in code"; `P04-jobs-not-run-*` |
| Round-1 item 6: the size check counts raw bytes | T13 | `212ae31` | the two T13 page tests and the route test |
| New 1: field errors don't follow J4 and J6.3 | T14 | `212ae31` | the 7 "field errors (J4, J6.3, T14)" tests |
| New 2: field borders are 1.27:1, and the red border never shows | T15 | `212ae31` | normal borders 7.81:1 light and 7.99:1 dark; invalid 6.47:1 and 7.2:1 |
| New 3: a refresh closes the diffs and the posting text, and the focused toggle jumps 278 px | T16 | `212ae31` | "a refresh keeps the open diff …"; Chromium: the toggle moved 0.125 px at 390 and 0.875 px at 1280 |
| New 4: axe serious `scrollable-region-focusable` | T17 | `212ae31` | "the full posting text is a focusable, labelled region"; axe clean in all four combinations |
| New 5: long messages are cut at 390 | T18 | `212ae31`, `436cc75` | the line-length test; Chromium at 390: every message fits two lines |
| New 6: 9 of the 29 screenshots are wrong | T20 | `436cc75` | the 41 shots below |
| Polish: scroll an opened heading under the line, without Chrome's ring | T19 | `212ae31` | "opens a job (moving focus to the detail heading) …"; a 12 px gap and the theme's ring |
| Polish: the paused-budget message | T12 | `212ae31` | "a paused budget says so, and points to Resume in Settings"; `P04-jobs-paused-*` |
| Polish: "…or paste the text directly" on a pasted job | T12 | `212ae31` | "a pasted job never offers “paste the text directly”; a captured one does" |
| Polish: the paste form's address lacks the scheme check | T19 | `212ae31` | "the paste form's address gets the fetch form's scheme check, with its own wording"; `P04-jobs-paste-refused-*` |
| Polish: diff lines don't line up | T19 | `212ae31` | "… every line in the same text column"; `P04-jobs-diff-*` |
| Polish: the name "anchor" | T20 | `212ae31`, `436cc75` | the tests and the shots use only the policy's names |
| Polish: extension captures appear only after a reload | T11 | `212ae31` | "a new extension capture joins the list on the page's own 5 s refresh, with no announcement"; Chromium: it joined after 4.5 s |

**Tests run, real output.** All commands were run from the repo root at `436cc75`. Every one exited 0, and `git status --porcelain` was empty afterwards.
- `pnpm install --frozen-lockfile`: already up to date.
- `pnpm typecheck`: all 6 packages done.
- `pnpm test`:
  - contracts: 16 files, 235 tests;
  - job-assistant: 6 files, 153 tests;
  - runner: 44 files, 830 tests (731 at `f3cdec8`);
  - `eve eval`: 6 of 6, 105 gates: approval 4, tool-surface 4, missing-tools 8, skills 4, job-extraction 20 and onboarding-extraction 65;
  - catalog: 26 files, 168 tests;
  - extension: 21 files plus 1 skipped, 329 tests plus 5 skipped;
  - root `scripts/*.test.mjs`: 2 of 2.
- `pnpm -r lint`: 6 of 6 clean.
- `pnpm check:fixtures`: exit 0.
- That `pnpm test` run passed in parallel, so no serial rerun was needed.

**Chromium measurements.** These were taken with Playwright 1.63 (Chromium 1243) and Geist, against a real bridge on 127.0.0.1:4330. The scratch files are in `/tmp/wc-p04e-shots/` (`shoot.ts`, `report-*.json`).
- **T11.** At 1280, after Try extracting again:
  - the line said "Extracting “Platform Engineer at Harbor”…" at 33 ms;
  - the row and the detail showed the job as running at 38 ms;
  - the result, "Extracted “Platform Engineer · Harbor”.", was announced once, at 2011 ms.

  A capture the page didn't start joined the list after 4.5 s, with no announcement.
- **T15.** Contrast of the border against the card, then against the field's background:
  - light: normal `oklch(0.44 0 0)` 7.81:1 and 7.62:1; invalid `#b91c1c` 6.47:1 and 6.31:1;
  - dark: normal `oklch(0.72 0 0)` 7.99:1 and 8.42:1; invalid `rgb(248 113 113)` 7.2:1 and 7.59:1.

  The field-error text is 6.47:1 light and 7.2:1 dark. In both themes the invalid colour is the computed border.
- **T16.** Fields were made to arrive above an open diff and an open, focused "Full posting text" toggle. The same node kept focus, and both sections stayed open. The page scrolled 178 px at 390 and 154 px at 1280 to hold the toggle, which moved 0.125 px and 0.875 px: `scrollY` moves in whole pixels.
- **T17.** With the text open and scrollable, axe (WCAG 2.2 AA and best practice) reported no violations and no incompletes in all four combinations. The region's ring is `2px solid` in `--ring`.
- **T18.** At 390, in both themes:
  - 13 line messages of 57–88 characters each fit two lines, unclipped;
  - a 303-character line clamps to exactly two lines (36 px), with nothing of a third.

  Measuring budgets, realistic job names fit two lines at 80 and at 85 characters, but at 90, 9 of 24 did not. So a line that names a job is fitted to 80.
- **T19.** For a long detail, an opened heading sits 12 px under the line, at both 390 light and 1280 dark, with `:focus-visible` and the theme's 2 px ring. A short job at the end of the page can't scroll that far: the page is at its end, and the gap is 318 px (390) or 331 px (1280).

**Screenshots (T20).** There are 41 files in `docs/screenshots/`: the 29 existing names, retaken, and 12 new ones.
- `P04-jobs-{empty,list,revisions,diff,not-run,paste-refused,refused-private}-{light,dark}-{390,1280}.png`: 28 full-page shots.
- `P04-jobs-not-run-viewport-light-390.png`: a viewport shot of the not-run detail, with the line pinned at the top.
- New: `P04-jobs-{running,paused,unreadable}-{light,dark}-{390,1280}.png`, 12 full-page shots.

How they were taken:
- Each shot used a real bridge on 127.0.0.1:4330 with its own scratch workspace. A scripted eve's turns call the real `extract_job` check.
- The data is fictional: Northwind Labs, Ledgerkit, Harbor, Quill and Fernwood. There is no "anchor".
- Full-page shots size the viewport to the page's height, repeated until stable, instead of stitching. So the pinned line sits where it belongs, under the header (292 px down at 390, 210 px at 1280), and never over content.
- The diff shots show both a removed line and an added one.

Checks before each capture:
- `clientWidth` was exactly 390 or 1280, and `scrollWidth` was the same (no sideways scroll).
- Nothing was hovered.
- axe (WCAG 2.2 AA and best practice) found no violations.

axe left "incomplete" (needs review) results, which aren't violations, on 5 shots:
- in the four diff shots, the "−" marker: it is `aria-hidden` and a symbol, so axe can't rate it as text;
- in the viewport shot, the line's text: the pinned line overlaps the scrolled content, so axe can't find its background. The same line passes axe's contrast check in every full-page shot.

The console was clean apart from Chrome's own "Failed to load resource: … 400 (Bad Request)" in the four refused-private shots, for the deliberately refused private address. I checked every committed `P04-*.png` against its name (`/tmp/wc-p04e-shots/reviewed-hashes.txt`). No obsolete file remained, so nothing needed `git rm`.

**Mutation proofs (T21).** Each mutation is one exact text replacement in one file, run with its named Vitest files. The original, held in memory, was then written back, and a byte-for-byte comparison confirmed the restore. `git diff` was clean afterwards. The scripts and results are in `/tmp/wc-p04e-mutations/` (`mutations.mjs`, `drive.mjs`, `results.json`).

| Mutation | File | Failed | Killed by |
|---|---|---|---|
| L14-1: only the first hop is checked | safe-fetch.ts | 1 of 92 | "re-validates on every redirect hop …" |
| L14-2: accept `http:` on the fetch path | captures.ts | 1 of 61 | "refuses a plain http:// URL" |
| L14-3a: the text moved out of the boundary block | captures.ts | 1 of 61 | "the posting text sits only between a matching START/END marker pair …" |
| L14-4: no content-hash dedupe | jobs.ts | 2 of 26 | "captured twice with unchanged text …"; the concurrent same-text capture test |
| L14-5: a turn that isn't ok counts as extracted | captures.ts | 4 of 61 | the failed Re-extract, not-ok, provider-limit and T3 tests |
| L14-M6b: the pinned lookup answers the hostname | safe-fetch.ts | 5 of 92 | the `nodeHttpsRequest` pin test; the TLS DNS-name, slow-drip, endless and redirect-drip tests |
| L14-M7: the pin removed | safe-fetch.ts | not run | see "Not done" |
| L14-M8: the cap checked after buffering | safe-fetch.ts | 2 of 92 | both endless-body tests |
| L14-mapped: `::ffff:0:0/96` allowed | safe-fetch.ts | 6 of 92 | five mapped `isBlockedAddress` cases; the bracketed mapped metadata literal |
| L14-await: the extraction awaited before responding | captures.ts | 6 of 61 | the event-response timing test; T1, T2, T3 (2) and T9 queue tests |
| L14-keepfailed: a failed turn clears the fields | captures.ts | 2 of 61 | the failed Re-extract test; "an ok turn that found nothing keeps the fields already saved" |
| T1: the tool writes during the turn | extract-job-logic.ts | 7 of 118 | 3 route tests, 2 `checkExtractedJob` tests, and `job-tools` for both agents |
| T2: an earlier process's state stays as it is | captures.ts | 3 of 61 | the T2 `it.each` |
| T3: the budget checked only at queue time | captures.ts | 1 of 61 | "the first turn hits a provider limit …" |
| T4: a reset mid-body is `too_large` | safe-fetch.ts | 3 of 92 | "a reset mid-body gives request_failed …" (TLS) and the two unit tests |
| T5: paste skips the normalizer | captures.ts | 4 of 61 | both three-routes tests, the whitespace re-paste test and the whitespace-only test |
| T6: a damaged latest revision hides the job | jobs.ts | 6 of 123 | 2 store, 2 route and 2 page tests |
| T7: the transport gets the hostname | safe-fetch.ts | 6 of 92 | the recording-transport test; the TLS DNS-name, drip, endless and redirect-drip tests; the IPv6-literal test |
| T8: `RUNNER_WORKSPACE` not kept in step | eval-workspace.ts | 2 of 4 | the two tests where both variables are set |
| T9: a waiting revision is queued again | captures.ts | 1 of 61 | "two concurrent Re-extracts of one revision queue one turn …" |
| T11-row: the open row doesn't follow its detail | jobs.js | 1 of 36 | "the open job's row never disagrees with its detail …" |
| T18: names fitted to 90 again | jobs.js | 1 of 36 | "every line message is one sentence of 90 characters or fewer, and 80 or fewer when it names a job …" |

**Not done.**
- **M7 wasn't run.** Without the pin, Node asks the real resolver for the test's hostname, and the brief forbids the real network. Stubbing DNS needed a `NODE_OPTIONS="--import …"` preload, and the harness refused that command (its worktree-isolation check). As the rules say, I stopped there and didn't work around it. The pinned `lookup` lines are unchanged since `f3cdec8`, where the round-2 reviewer's M7 failed a test. M6b and T7 break the same pin from the other side, and 5 and 6 tests kill them.
- Proof 3b wasn't re-broken, as in revision 1. Its coverage, the eval's check that the injected action never becomes a field value, passed again (job-extraction 20 of 20).

**Choices worth a look.**
- The paste form's address stays required: the paste route and the snapshot both need a URL. T19's scheme check and wording are in.
- An ok turn with no fields, or with an empty accepted result, counts as `no_fields_found` and keeps the fields already saved.
- When a job's newest revision can't be read, its row is named from the URL's path, because that revision has no readable text. The detail heading names the newest readable revision, and the detail says which revision that is.
- "Can't reach the runner. Is it still running?" is two short sentences. It is the runner's shared wording, also used by the Runs and Settings pages.
- If the queue hasn't started the turn by the first refresh after a retry, the job reads "Waiting to extract…" until the next refresh; that is the server's true state. In the measured run the job showed as running at 38 ms. In an earlier run the first refresh caught it still waiting, and it showed as running at 2083 ms.
- At 390, synthetic worst-case names (runs of W and M, or one very long hyphenated word) can still need a third line at 80 characters. The clamp cuts them cleanly, and the whole sentence stays in the text node and its `title`.

**Notes.**
- No orchestrator message arrived during this revision, genuine or not, and nothing claimed to be the orchestrator without 4488ee.
- These MCP servers need authentication and weren't used: claude.ai Dice, Excalidraw and Slack, and plugin:cloudflare (api, bindings, builds, observability). They stay unavailable until someone authorizes them: claude.ai connectors in the claude.ai connector settings, the others with `claude mcp` (`/mcp`) in an interactive session.
- The harness refused the `NODE_OPTIONS` preload above, and a few compound shell commands as too complex; I split those. No deny rule refused anything.
- Integration has moved to `2c32776` since `2d725f4`: three commits touching only `logs/` (P02.2's review and checkpoints). I didn't merge them. `git merge-tree` shows the branch merges with no conflicts.
- The P02.2 implementer ran at the same time in its own worktree. I didn't interact with it.
- Every server and browser I started was stopped. The only port used was 127.0.0.1:4330.

### 2026-09-23 — Job capture, single round (iter 006 implementer)

**PR:** [#14](https://github.com/radroid/workflow-catalog/pull/14) `packet/P04` → `overnight/integration`.

| Commit | What |
|---|---|
| `3287083` | Claim |
| `67bc034` | `safe-fetch.ts`, `readable-text.ts`, `JobsStore`, the `extract_job` tool (both roots), `captures.ts` routes, and their tests |
| `b8dbb52` | Jobs page: `ui/jobs.html`, `assets/jobs.js`, `assets/jobs.css`, `test/jobs-page.test.ts` |
| `ce903de` | `runner/README.md`: the Jobs page write-up and the corrected P04 row of "Extending the runner" |
| `5f3308d` | Fixed the job-extraction eval's `RUNNER_WORKSPACE` race; moved the profile-safety proof to a private-workspace Vitest test |
| `033a663` | Strengthened the "count a non-ok turn as extracted" mutation-proof test (it wasn't actually exercising the guard it claimed to) |
| `3e2c48d` | The 20 Jobs-page screenshots |
| (this commit) | This report |

**Deliverables → where.** Three capture paths (extension `job_capture` event, paste, `https://` fetch) all funnel through `JobsStore.captureJob` (`runner/store/jobs.ts`), so they share one dedupe-by-URL/revision-by-content-hash rule (F6). The URL-fetch path alone goes through `runner/lib/safe-fetch.ts` (https only; loopback/RFC1918/link-local/`169.254.169.254` refused, checked after DNS resolution and again on every redirect hop; a redirect limit, a size cap, a timeout) and `runner/lib/readable-text.ts` to turn HTML into plain text. Structured extraction is the `extract_job` tool (`runner/agent/tools/extract_job.ts`, re-exported for the eval agent), a thin `"use step"` wrapper over the directive-free `runner/agent/lib/extract-job-logic.ts::persistExtractedJob`, which takes only `jobId`/`revision` back and writes through `JobsStore.recordStructured` — the posting text itself only ever travels as user-turn data (`hard-problems.md` #3), never a system-prompt interpolation. The Jobs page (`runner/ui/jobs.html`, `assets/jobs.js`, `assets/jobs.css`) lists jobs, opens a detail panel with revision history, and renders a capped LCS line diff between adjacent revisions with no dependency.

**Acceptance → tests.**

| Acceptance item | Proved by |
|---|---|
| Three paths produce identical snapshot records for the same fixture text | `captures.test.ts` (corrected in round-1 revision: `jobs-store.test.ts` was also cited here, but it exercises `JobsStore.captureJob` directly, never the three HTTP paths — round-1 review L7 found the property this row claims was actually unproven, and false, at the time of this entry: only the URL-fetch path trimmed its text, so the same posting hashed differently depending on which path captured it) |
| Same URL, changed text → revision 2, revision 1 retained | `jobs-store.test.ts` ("a second capture of the same URL with different text creates revision 2 and keeps revision 1") |
| Hostile posting: extraction returns fields only, no action tool called, profile unchanged (hash before/after) | `extract-job-logic.test.ts` ("never touches the career profile — hostile posting fixture (hard-problems.md #3, assert store hash before/after)"); `job-extraction.eval.ts`'s `notCalledTool`/no-leaked-phrase assertions |
| Rejected: `javascript:`/`file:` on every path, `http:` on the URL-fetch path | `captures.test.ts` (corrected in round-1 revision: this row previously also cited `job-tools.test.ts`, which tests the `extract_job` tool wrappers' persist behaviour and has no URL-scheme assertions at all — a wrong citation, not merely an imprecise one) |
| Rejected: loopback/RFC1918/link-local/`169.254.169.254`, including after a redirect or a DNS answer | `safe-fetch.test.ts` (injected resolver + local fake server, never the real network) |
| Rejected: bodies over the cap, text over 200 KB | `safe-fetch.test.ts`; `captures.test.ts` (at the time of this entry, only the paste path's 200 KB cap actually had a test — the URL-fetch path's identical check was untested despite the citation implying otherwise; both paths are covered as of round-1 revision L11) |
| `job_capture` gets a real handler (was `no_handler`); `route-modules.test.ts` needs no edit (D2) | `captures.test.ts`; confirmed by running the existing `route-modules.test.ts` unedited |

**Mutation proofs — 5 of 5, each applied → red → reverted → `git diff` clean → green.**

| # | Mutation | File | Killed by |
|---|---|---|---|
| 1 | Drop the post-redirect address check | `lib/safe-fetch.ts` | `safe-fetch.test.ts`: redirect-to-loopback/link-local/metadata cases |
| 2 | Accept `http:` on the fetch path | `server/routes/captures.ts` | `captures.test.ts`: URL-fetch scheme rejection |
| 3 | Put the posting text into the instructions | `agent/tools/extract_job.ts` (both roots) | `eval-agent/evals/job-extraction.eval.ts`'s no-leaked-phrase assertion |
| 4 | Skip the content-hash dedupe | `store/jobs.ts` | `jobs-store.test.ts`: same URL + same text → no new revision |
| 5 | Count a non-ok turn as extracted | `server/routes/captures.ts` / `agent/lib/extract-job-logic.ts` boundary (the `result.status !== "ok"` guard in the turn-outcome interpreter) | `captures.test.ts` — see below |

Proof 5 exposed a real gap in its own test before it proved anything: the original test scripted a *failed* turn that never called `extract_job` at all, so removing the status guard changed nothing (there was no tool result for the code to wrongly accept either way) — applying the mutation left all tests green, which is not what a mutation proof is supposed to show. Fixed by rewriting the test to script a successful-looking `extract_job` action result for the exact `jobId`/revision, immediately followed by `turn.failed`: now the guard is the only thing standing between that scenario and a wrongly-reported "extracted" outcome. Re-verified: red with the mutation applied, green after revert, `git diff` clean.

**Two eval-infrastructure races found, root-caused, and fixed (empirically diagnosed against eve's own docs, not guessed).**
- `eve eval` discovers every `.eval.ts` file by importing it, then runs all of them concurrently against **one shared dev-host process with one process-wide environment** (`node_modules/eve/docs/evals/*.mdx`; no per-eval `maxConcurrency` — `defineEval`'s only options are `description, judge, tags, metadata, timeoutMs, reporters`). `job-extraction.eval.ts`'s original top-level `process.env.RUNNER_WORKSPACE = ...` raced `onboarding-extraction.eval.ts`'s identical unconditional top-level assignment; whichever file's import finished last won, and the other's tool calls landed against the wrong workspace (`store.recordStructured` returned "No snapshot revision 1 for that job."). Fixed by resolving the workspace reactively inside `test()` (`openOrCreateWorkspace()`), reading `process.env.RUNNER_WORKSPACE` rather than setting it unconditionally.
- With that fixed, a second race remained, reproducing on every run, not intermittent: the "career profile is unchanged" before/after hash check was reliably poisoned because `onboarding-extraction.eval.ts`'s own concurrent tool calls write real, different content into the *same* shared `career-profile.md` inside the same run. This is an architectural property of `eve eval` (one shared workspace when both files' top-level code resolves to it, no per-eval isolation available), not a defect in this packet. Alternatives considered and rejected: a per-eval concurrency option (doesn't exist); temporarily swapping `RUNNER_WORKSPACE` around just this file's turn (would corrupt onboarding's own concurrent calls — harmful to another packet's eval); a global `maxConcurrency: 1` in `evals.config.ts`/`cli/eval.ts` (outside this packet's `Owns`, slows every packet's eval run, and does not even fix the import-time env race). Resolved by moving the profile-safety assertion to `extract-job-logic.test.ts`'s new "never touches the career profile" test, which uses its own private, non-shared workspace and therefore gets a deterministic answer — a stronger guarantee than the racy eval check ever gave, not a weakened one. The eval keeps its tool-call-identity assertions, which are valid regardless of shared state. Verified reliably green across repeated full `pnpm test` runs, including the one in this session's chain (`job-extraction` 15/15, `onboarding-extraction` 65/65, together, in the same process).

**Screenshots.** 20 files, `docs/screenshots/P04-jobs-{empty,list,revisions,diff,refused-url}-{light,dark}-{390,1280}.png`, full page. Harness: a throwaway seed+serve script under `/tmp/wc-p04-screenshots/` (never committed), calling `createBridgeApp`/`createRunnerContext`/`loadRouteModules(ROUTES_DIR)` directly (never `cli/{setup,doctor,runner}.ts`), bridge on `127.0.0.1:4330` only, `eve` left unset (none of the five required states need a live extraction turn — structured fields were seeded directly through `JobsStore`), signed in through the real `/ui/login?nonce=` flow (`ctx.uiLogin.issue(origin)`, redeemed by a real browser navigation). Fixture data is fictional: Northwind Labs, Ledgerkit, Harbor, all under a shared `jobs.example` host (an ATS-style shared hostname, matching this repo's own existing fixture convention rather than a bug). The refused-URL shot submits `http://169.254.169.254/...` through the real URL-fetch form and captures the real refusal it produces ("The runner only fetches https:// links…") — one of the acceptance list's required rejections (`http:` on the fetch path), reached end-to-end rather than staged.
- Caught and fixed during this pass: `resize_page(390, …)` does not actually yield a 390 CSS-pixel viewport on this Chrome build — it floors at an `innerWidth` of 500 (a native-window minimum), which would have silently mislabeled every "390" shot. Switched to `emulate({ viewport: "390x844x2" })` (CDP device-metrics override), confirmed `window.innerWidth === 390` before capturing, and redid all ten affected files (the empty pair needed a second, separate empty workspace, since the first had already been seeded).
- Verified: all 20 SHA-256 checksums unique (no accidental duplicates); `document.documentElement.scrollWidth === clientWidth` at both 390 and 1280 (no horizontal scroll) on the content-heaviest state (diff) and re-checked after the viewport fix.
- Harness stopped after use; confirmed nothing listening on 4310/4320/4330/4340/4350 afterward. Scratch data stayed under `/tmp/wc-p04-screenshots/`.

**Tests run, real output.** All from the repo root at `3e2c48d`, `git status --porcelain` clean before and after.
- `pnpm install --frozen-lockfile`: already up to date.
- `pnpm typecheck`: all 6 workspaces done.
- `pnpm test`: contracts 16 files/235 tests; job-assistant 6 files/153 tests; runner 43 files/668 tests, plus `eve eval` 6/6 files and 100/100 gates (`tool-surface` 4/4, `approval` 4/4, `missing-tools` 8/8, `skills` 4/4, `job-extraction` 15/15, `onboarding-extraction` 65/65); catalog 26 files/168 tests; extension 21 files/329 tests plus 1 file/5 tests skipped; root `scripts/*.test.mjs` 2/2.
- `pnpm -r lint`: 6 of 6 clean, `--max-warnings 0`.
- `pnpm check:fixtures`: exit 0.
- CI on PR #14 head `3e2c48d`: run [35940266893](https://github.com/radroid/workflow-catalog/actions/runs/35940266893), success (5m8s), including the extension build/vitest/Playwright e2e step. See the reply for this report commit's own head SHA and CI run.

**What was skipped, and why.**
- The 5 mutation proofs' apply/red/revert cycles were performed during the implementation commits (`67bc034`–`033a663`), not re-run a second time in this closing session; this session instead re-confirmed they hold by running the full suite green on the final code with a clean `git diff`, rather than re-breaking and re-fixing already-proven code. The detail above reflects what was actually done at the time, including proof 5's test-coverage gap.
- No screenshot of a live "extraction in progress" or "just re-extracted" transient state: the five required states (empty, list, revisions, diff, refused-url) don't call for one, and all five are reachable without a live `eve` connection, so the harness never wired one up.
- `runner/server/run-harness.ts`'s `events` field on `TurnResult` is additive only (one field, one test); no other caller of `TurnResult` was touched.

**Assumptions.**
- The screenshot naming convention follows P03's precedent (`P0N-<page>-<state>-<theme>-<width>.png`) since the packet didn't give exact file names.
- "Full page" screenshots are taken with `fullPage: true` at 1x DPR content scale reported by `window.innerWidth`/`clientWidth` (actual PNG pixel dimensions are 2x that, per this machine's device pixel ratio); this matches how the acceptance criterion reads ("at 390 and 1280") as CSS pixels, not raw PNG pixels.

**The one thing to sharpen in this packet next time.** The `RUNNER_WORKSPACE`-is-process-wide hazard is not really a P04 problem — it's a standing trap for every future packet that adds a new `.eval.ts` file alongside existing ones (P03.1, P05, and beyond will all hit it the moment two eval files' top-level code both want a fresh workspace, or two evals' tool calls touch the same shared file). Worth a short, explicit convention note in `docs/spec/research/eve-runtime.md` or the packets' `README.md` — "resolve `RUNNER_WORKSPACE` reactively inside `test()`, never assign it at top level; never assert on shared-workspace state that another eval file's tools can also write" — so the next packet doesn't have to re-diagnose this from scratch the way this one did.

### 2026-09-24 — Revision 1 (round-1 review response: L1–L14)

**Review:** `logs/handoff/P04-round-1-review.md`, reviewing head `e8b74de` (code head `3e2c48d`). Reviewer: REVISE, 9 issues + nits + mutation-proof findings. UI critic: REVISE, 9 issues + polish + committed-screenshot findings. Orchestrator decisions: L1–L14 (`## Revision 1: the orchestrator's decisions` in that file), same worktree/implementer.

**PR:** same [#14](https://github.com/radroid/workflow-catalog/pull/14), `packet/P04` → `overnight/integration`.

| Commit | L item(s) | What |
|---|---|---|
| `1562ad3` | L1, L2, L3, L4, L8 (M8 half) | Production transport handles both `lookup` callback shapes (Node 24 `autoSelectFamily`); IPv6 literals stripped of brackets and checked numerically via a hand-written parser + `net.BlockList` (loopback/unspecified in any notation, IPv4-mapped, IPv4-compatible, NAT64, `fc00::/7`, `fe80::/10`, `fec0::/10`, multicast); every body read in `safe-fetch.ts` guarded (never throws); one overall deadline across DNS/every hop/body; redirect bodies cancelled not drained; `accept-encoding: identity`; declared charset honoured; `readable-text.ts` rewritten as one linear `indexOf` pass (was quadratic backtracking) |
| `bea13fb` | L5 | Capture responds once the snapshot is saved; extraction queued and run in the background, one turn at a time per workspace; `ExtractionState` side-channel (waiting/running/done/not_run/failed + reason, "interrupted" derived at read time); `extractionPreflight` decides not-run synchronously; retry route now async |
| `1ff5b0a` | L6 | Only uuid-named directories scanned (`isJobId`); a damaged snapshot reads as absent, never throws; per-job try/catch in list/find as defense in depth |
| `20c910b` | L7 | One `normalizeCapturedText` (trim) applied inside `captureAndExtract`, the shared choke point for all three paths; URL-fetch route's fetch made injectable via a factory, not `context.ts` |
| `c927285` | L8 (prompt half) | New prompt-boundary test: START/END markers share one token, posting text appears exactly once, strictly inside the block |
| `98bbb40` | L9 | New shared `eval-agent/evals/eval-workspace.ts`; both eval files call `openOrCreateEvalWorkspace()` from their own top level, deciding fresh-vs-reuse via the env var itself (idempotent against eve's independent per-file module loading); new route-level hostile-fixture test in `captures.test.ts` (private workspace, checks fields-only/one-tool-call/profile-hash-unchanged together) |
| `1c2eefc` | L10 | `stripUrlForStorage` (drop userinfo + fragment) applied once inside `captureAndExtract`; fetch path's final URL (post-redirect) re-validated against the contract's bounded URL schema |
| `a712376` | L11 | `run-harness.ts`'s `events` only accumulates when `collectEvents` is true; `javascript:`/`file:` tests added to the event and paste paths (previously only URL-fetch had both); URL-fetch path's own 200 KB-after-extraction refusal tested; two wrong citations in the round-0 report corrected |
| `fb2aa1a` | L12 | Full Jobs-page rebuild: sticky "Last action" line; `aria-disabled` + delayed busy word; job naming from first non-empty line/URL path, never bare hostname; extraction-state sentences with reason + next step, never "structured fields"; `morphChildren`/`morphNode` keyed reconciliation (never destroys a focused node); client-side paste pre-flight with field-scoped errors; exact duplicate wording; `overflow-wrap: anywhere`; accessible diff markup; all 9 polish items |
| `9bd7009` | L13 | 29 screenshots retaken (20 stale files replaced, 4 obsolete `refused-url` files `git rm`'d, replaced by `refused-private` + 1 new viewport shot); 2 real production bugs found and fixed via the screenshot process itself (see below) |
| `4c3d38c` | L14 | 5 original mutation proofs re-run + M6b/M7/M8 + 3 new proofs, all applied→red→reverted→green; one new permanent test added |
| `77e8445` | (L14 follow-up) | Lint fix for the new test (`no-non-null-asserted-optional-chain`) |
| `f08c52a` | found during this revision's own CI verification, not in the original L1–L14 list | Fixed a CI-only failure in L9's own file — see below |
| (this commit) | — | This report |

**Reviewer's 9 issues → fix and test.**

| # | Issue | Fixed by | Proved by |
|---|---|---|---|
| 1 | Production transport throws `ERR_INVALID_IP_ADDRESS` for every real fetch (Node 24 `autoSelectFamily` calls `lookup` with `{ all: true }`) | `1562ad3`, `safe-fetch.ts`'s `nodeHttpsRequest` | `safe-fetch.test.ts`'s new production-transport test, driving `nodeHttpsRequest` directly against a local listener |
| 2 | IPv6 forms slip through (bracketed literals go to the resolver as hostnames; string-prefix matching missed most of the table) | `1562ad3`, rewritten `isBlockedIPv6` | `safe-fetch.test.ts`'s IPv6 table, one `it.each` case per form |
| 3 | `readable-text` quadratic on hostile HTML (~10s/160KB, ~1.7h at the real cap) | `1562ad3`, linear `indexOf` pass | `readable-text.test.ts`'s three 2MiB hostile-shape cases, single-digit ms |
| 4 | `safeFetch` throws despite "never throws" (unguarded body reads) | `1562ad3` | `safe-fetch.test.ts`'s slow-drip body/redirect-body tests |
| 5 | `job_capture` holds `POST /events` open for the whole model turn (extension's 5s timeout races a 90s turn) | `bea13fb`, background extraction queue | `captures.test.ts`'s "the event response arrives before a slow fake turn finishes" |
| 6 | A stray `.DS_Store` (or any non-uuid entry) in `jobs/` breaks every Jobs path | `1ff5b0a`, `isJobId` filter | `jobs-store.test.ts`'s new "JobsStore resilience" describe |
| 7 | "Three paths produce identical records" unproven, and false (only the fetch path trimmed) | `20c910b`, shared `normalizeCapturedText` | `captures.test.ts`'s new three-paths-identical test against the real Northwind fixture |
| 8 | Two security properties untested: M3a (text outside the boundary), M8 (size cap after full buffering) | `c927285` (M3a), `1562ad3` (M8, folded into the L4 deadline rework) | `extract-job-logic`'s prompt-boundary test (M3a); `safe-fetch.test.ts`'s endless-body test (M8) |
| 9 | Hostile-fixture check weaker than written; eval workspace fallback (assigning `RUNNER_WORKSPACE` inside `test()`) can't reach eve's dev-host Worker | `98bbb40`, shared `eval-workspace.ts` + route-level hostile test | `captures.test.ts`'s new hostile-fixture route test (fields-only, one tool call, profile hash unchanged); `job-extraction.eval.ts`/`onboarding-extraction.eval.ts` still 15/15 + 65/65 |

**Reviewer's nits → fix.** `events.push` gated on `collectEvents` (`a712376`); URL userinfo/fragment stripping (`1c2eefc`); one overall deadline covering DNS (`1562ad3`); gzip refused, charset honoured (`1562ad3`); `</script >` closes (`1562ad3`); `extract_job` can't overwrite an unrelated revision — already guarded by `persistExtractedJob`'s "running" precondition, exercised by L9's new hostile test and L5's background-queue tests; a turn that fails after the tool ran keeps its fields — new L14 test (below); wrong citations corrected (`a712376`). Extraction still runs outside `withRun` — **not fixed, by design**: the review lists this as carried to **P08-B**, not part of L1–L14.

**UI critic's 9 issues → fix, all in `fb2aa1a` (L12).**

| # | Issue | Fix |
|---|---|---|
| 1 | Outcomes land off-screen (250–1500px from the pressed button) | Sticky "Last action" line, `scroll-padding-top` tracks its height |
| 2 | Busy is invisible for up to 90s+10s | `aria-disabled` + "Saving…"/"Fetching…"/"Extracting…" after ~300ms; a new request clears the old message |
| 3 | Unextracted jobs all called "jobs.example" | Named from first non-empty line (capped ~80 chars) or URL path, never bare hostname |
| 4 | Extraction messages give no reason/next step; "not run" and "failed" read the same; "structured fields" leaks an internal key | Plain sentences per reason code, next step spelled out (`<code>` where relevant), never "structured fields" |
| 5 | A focused node is rebuilt (`detail-body.replaceChildren()` drops the pressed button, focus falls to `<body>`) | `morphChildren`/`morphNode` keyed reconciliation, never removes a focused node |
| 6 | Paste refusals don't say what's wrong (wrong sentence at 210K/300K chars, empty paste, wrong form referenced, no field marked invalid) | Client-side pre-flight (empty/oversize checks before send); field-scoped `aria-invalid`/`aria-describedby` |
| 7 | Duplicate paste doesn't say nothing was duplicated | Exact wording: "Already saved: this posting hasn't changed since revision N, so nothing was duplicated." |
| 8 | Horizontal scroll at 390 (175-char address, `overflow-wrap: normal`) | `overflow-wrap: anywhere` on the detail address line |
| 9 | Diff relies on punctuation; "removed" marker broken (CSS `content` escape eats the space; strikethrough crosses the minus sign) | Visually-hidden "Added:"/"Removed:" prefix, `aria-hidden` marker span, `.diff-text` alone carries strikethrough |

**UI critic's polish → all 9 done in `fb2aa1a`:** open row marked + heading scrolled into view; theme field borders/focus ring; `javascript:`/`file:` refusals no longer borrow the http-specific "paste instead" sentence; `https://` in `<code>`; diff toggles name both revision numbers; "a private or local network address"; timestamps drop seconds, deadline formatted as a UTC-safe long date; success messages name the job; new-tab links say so.

**Committed-screenshots findings → fixed in `9bd7009` (L13):** all 29 files retaken at a verified `document.documentElement.clientWidth` of exactly 390 or 1280 (not the old 375/1265-with-scrollbar); the refused-url set replaced with a `refused-private` `https://` state shown at the form, field-scoped; the diff shot now shows both an added and a removed line; the two pre-extracted seed jobs replaced so the all-hostname-list state genuinely appears; the "revisions" hover-underline artefact re-shot after moving the pointer off the just-clicked control.

**Two real production bugs found and fixed while taking L13's screenshots** (not on the L-item list; caught visually/empirically, not predicted):
1. `keepClear()` used `instanceof HTMLElement` — throws in any DOM-lib-less context (this repo's own runner `tsconfig` has no DOM lib; the jobs-page test's happy-dom window doesn't put `HTMLElement` on `globalThis` either), silently degrading to a "refused" last-action reading the exception's own message. Fixed by duck-typing (`typeof node.getBoundingClientRect === "function"`).
2. `refuseField()`'s `.focus()` relied on the global `focusin` listener's `keepClear`, which self-suppresses for 500ms after a `pointerdown` — correct when a click focuses itself, wrong here (the person clicked the submit button; focus moves to a *different* field). A field error could land directly under the sticky line, invisible without scrolling — caught visually in the first "refused-private" screenshot. Fixed by calling `keepClear()` unconditionally from `refuseField()` itself.

**Mutation proofs — 11 of 11, each applied → red → reverted → `git diff` clean → green** (`4c3d38c`; the "keep a failed turn's fields" proof leaves behind one new permanent test, `captures.test.ts`'s 35th):

| # | Mutation | Killed by |
|---|---|---|
| 1 (re-run) | Drop the post-redirect address check | `safe-fetch.test.ts`: re-validates-on-every-redirect-hop test (`blocked_address` → `http_status`) |
| 2 (re-run) | Accept `http:` on the fetch path | `captures.test.ts`: refuses-plain-http test (`https_required` → `fetch_scheme_not_https`) |
| 3a / M3a (re-run) | Move the posting text out of the boundary block | `captures.test.ts`'s L8 boundary test (text no longer between START/END) |
| 4 (re-run) | Skip the content-hash dedupe | `jobs-store.test.ts`, two tests (unchanged capture gets a new revision; concurrent same-URL/same-text race produces two revisions) |
| 5 (re-run) | Count a non-ok turn as extracted | `captures.test.ts`'s own mutation-target test ("extracted" → "not_extracted") |
| M6b | Hand the transport the hostname instead of the pinned address | `safe-fetch.test.ts`'s `nodeHttpsRequest` test (pinned local listener sees 0 connections) |
| M7 | Remove the DNS pin entirely | Same test, same reason |
| M8 | Check the size cap only after buffering the whole body | `safe-fetch.test.ts`'s endless-body test (resolves in ~22s instead of under 1s) |
| New | Allow the IPv4-mapped metadata address (`::ffff:169.254.169.254`) | `safe-fetch.test.ts`: 6 failures (the bracketed-literal test + 5 `it.each` IPv6-table cases) |
| New | Await the extraction before responding (`void serialise(...)` → `await`) | `captures.test.ts`'s slow-fake-turn test times out at 20s instead of returning early |
| New | Keep a failed turn's fields (`runQueuedExtraction` calling `recordStructured(jobId, revision, {})` on the failure branch) | New permanent test: "a failed retry keeps the fields an earlier, successful turn already wrote" (`captures.test.ts`, 35th test) |

**Proof 3b scope decision (documented, not re-broken).** Proof 3b ("posting text folded into the fields, not merely nearby") was not separately re-broken this revision. Its own coverage — `job-extraction.eval.ts`'s no-leaked-phrase assertion — was untouched by any round-1 change apart from L9's workspace-sharing fix, and was re-confirmed passing (job-extraction 15/15) in every full chain run this session. Re-breaking it would have meant editing the eval fixture/prompt path outside what L14 asked for; re-verifying the existing, unmodified assertion is the accurate claim, not a fabricated fresh break/fix cycle.

**A discovery outside the L1–L14 list, found during this revision's own CI verification (`f08c52a`).** After L14 went green locally and pushed, CI's "Test" step failed — and, on investigation, had been failing since `98bbb40` (L9), on every subsequent commit, always at the same step, never locally. Root cause: GitHub Actions sets its own `RUNNER_WORKSPACE` environment variable in every job (the runner's work folder, one level above the checkout, e.g. `/home/runner/work/workflow-catalog`) before anything in this repo runs. L9's `openOrCreateEvalWorkspace()` used that same variable as its "did I already create the eval workspace this run" signal (necessary because eve's build cache loads each `*.eval.ts` file's dependency graph independently, so plain module-level caching doesn't survive across the two eval files — see that module's own comment). The very first call in any CI run therefore saw a pre-set value it had never written, assumed an eval workspace already existed, and called `Workspace.open()` on GitHub's checkout-parent directory — which has no `workspace.json`, failing with "Run `npm run setup` in runner/." every time. Invisible locally, because a plain shell never has `RUNNER_WORKSPACE` set ambiently. `RUNNER_WORKSPACE` itself is a pre-existing, deeply-wired production contract (`lib/settings.ts`, `agent/lib/extract-job-logic.ts`, `agent/lib/onboarding-store.ts`, several tests) that has to keep being set for the real tool code, so the fix coordinates via a new private `WORKFLOW_CATALOG_EVAL_WORKSPACE` variable — a name nothing else could ever set, steering clear of GitHub's other reserved `RUNNER_*` names too — while still setting `RUNNER_WORKSPACE` itself alongside it, for that real tool code to keep reading. Verified by reproducing the failure locally (`RUNNER_WORKSPACE` pre-set to an unrelated directory before running the runner's test script, which then failed identically) and confirming the fix resolves it under that same reproduction, then re-confirming the normal (unset) path is still green.

**Owns discipline.** Everything above stayed inside P04's existing `Owns`, plus L9's one grant (the workspace lines of `onboarding-extraction.eval.ts`, exercised: its own top-level `RUNNER_WORKSPACE` assignment was replaced with a call into the new shared module) — nothing else was added. The `f08c52a` fix stayed inside the same granted file (`eval-workspace.ts` is the new module L9 itself created).

**Tests run, real output.** From the repo root at `f08c52a`, `git status --porcelain` clean before and after.
- `pnpm install --frozen-lockfile`: already up to date.
- `pnpm typecheck`: all 6 workspaces done.
- `pnpm test` (= `pnpm -r test && node --test scripts/*.test.mjs`, CI's exact "Test" step): contracts 16 files/235 tests; job-assistant 6 files/153 tests; runner 43 files/731 tests (668 at round 0 → 731, +63 across L1–L14) plus `eve eval` 6/6 files and 100/100 gates (`tool-surface` 4/4, `approval` 4/4, `missing-tools` 8/8, `skills` 4/4, `job-extraction` 15/15, `onboarding-extraction` 65/65); catalog 26 files/168 tests; extension 21 files/329 tests plus 1 file/5 tests skipped; root `scripts/*.test.mjs` 2/2.
- `pnpm -r lint`: 6 of 6 clean, `--max-warnings 0`.
- `pnpm check:fixtures`: exit 0.
- CI on `packet/P04` head `f08c52a`: run [35953700163](https://github.com/radroid/workflow-catalog/actions/runs/35953700163), **success** (4m23s), including the extension build/vitest/Playwright e2e step — confirmed via one blocking `gh run watch 35953700163 --exit-status` plus `gh run view --json status,conclusion`. See the reply for this report commit's own head SHA and CI run.

**What was not done.**
- Nothing from L1–L14 was skipped or descoped.
- Per the review's own routing, not this packet's job: the e2e bridge loading no route modules (carried to **P07-C**), and extraction turns running outside `withRun` (carried to **P08-B**) — both already flagged in `logs/handoff/P04-round-1-review.md`'s "Carried to other packets", unchanged by this revision.
- The `f08c52a` fix is additional work this revision found and closed (a real, previously-undetected CI-only regression from L9), not part of the original L1–L14 list; included here since it touches L9's own file and blocked an honest "CI is green" claim until fixed.

**Assumptions.** Unchanged from round 0: screenshot naming follows `P0N-<page>-<state>-<theme>-<width>.png`; "full page" is `fullPage: true` at the CSS-pixel viewport width reported by `clientWidth` (L13 additionally verified this is exactly 390 or 1280 before every capture, per the round-1 instruction).
