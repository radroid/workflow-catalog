# P03 · Onboarding and the career profile

Status: done (iter 005, PR #11, squash 9821bee)
Assignee: iter-005 escalation implementer (Opus), revision 3 (J1–J8); revision 2 by the same implementer; previously the iter-004 implementer (Sonnet)
Blocked by: P02
Owns: runner/agent/skills/ (onboarding set), runner/agent/tools/ (extract_claims, ask_follow_up), runner/store/profile.ts, runner/server/routes/onboarding.ts, runner/ui/onboarding.html, runner/ui/profile.html, packages/job-assistant/fixtures/onboarding/
Spec: F4, F5, hard-problems #1 and #2, visuals/index.html (the walkthrough is the behaviour spec)

## Goal
A friend accounts for seven sources, reviews every claim, and approves a profile they own, exactly as the walkthrough shows. Generation stays locked until ready.

## Deliverables
- Source accounting: each category provided (upload / paste / URL / GitHub token) or marked unavailable / not applicable, with the reason kept.
- Extraction (`defineWorkflowTool`, durable): per provided source, candidate claims with evidence pointers (`{kind: passage, ref, quote}`), typed `fact | metric | title | date | credential`; idempotent per source content hash.
- Questions: metrics, superlatives, titles, and dates always ask; answers recorded as `{kind: statement}` evidence, never as external fact. Unanswered questions park the session durably (eve HITL) and never guess.
- Readiness rule and approval; revisions after approval; approval withdrawn when a claim changes.
- `career-profile.md` rendering from JSON and round-trip of edits back into JSON (markdown section markers).
- Local UI pages (plain HTML + fetch, theme tokens): Onboarding, Profile.

## Acceptance
- The six walkthrough scenarios in `docs/spec/visuals/index.html` reproduced as fixture tests against the store and the reducer-equivalent in the runner (no model needed).
- Extraction eval (`eve eval`) on the fictional resume fixture yields the expected claims including the metric marked `candidate` with a question.
- Generation endpoint refused with the exact readiness reason in each unready state.
- Round-trip property test: render → edit one claim text → parse → render equals expected.
- Hostile source fixture (a "resume" containing instructions) produces claims only; no tool other than `extract_claims` is called (assert with `t.calledTool`).

## Out of scope
Job capture, preparation, board.

## Report

### 2026-09-23 — Revision 3 (iter-005 Opus escalation, J1–J8)

**PR:** [#11](https://github.com/radroid/workflow-catalog/pull/11) `packet/P03` → `overnight/integration`. The code is final at `479298d`. `3cbae94` merges integration's newer head `492c432`, which is docs and logs only, and this report is the commit after that merge.

| Commit | What | CI run, result |
|---|---|---|
| `154adc3` | Server side of J1, J3, J5, J6.4 and J7, with tests | `35921025406`, success |
| `5612d69` | Both pages render in place (J3–J6), plus `runner/test/ui-pages.test.ts` | `35924386887`, success |
| `0ad539a` | Merge of `origin/overnight/integration` at `360ac69` (P08-A), as the orchestrator asked mid-round | `35925367506`, success |
| `1982598` | J8 screenshots, taken after the merge | `35925700294`, success |
| `5115312` | J5 follow-up: three route messages were over 90 characters for the longest labels | `35926785553`, success |
| `479298d` | Renames the J5 route test for what it checks | `35927221808`, success |
| `3cbae94` | Merge of `origin/overnight/integration` at `492c432`: GOALS.md, the P08 packet, eve-runtime.md and logs/, with no conflicts | see the reply |

**Scope.** This round covered J1–J8 in `logs/handoff/P03-round-3-review.md` and the amended eve-runtime §8 item 15. Before the work I merged `origin/overnight/integration`. That merge touched only `logs/` and `eve-runtime.md`. The mid-round P08-A merge had one conflict, `runner/test/route-modules.test.ts`. I kept this branch's readdir-based test (D2). It already covers P08-A's `runs` module, which declares no events, and the runner passed 560 of 560 after the merge. Everything changed is inside P03's Owns, D1's additions and the escalation allowlist: the onboarding route; `runner/store/profile*.ts`; both pages' HTML, JS and CSS; P03's tests plus the new `runner/test/ui-pages.test.ts`; and `docs/screenshots/P03-*`.

**J1–J8.**

| Item | What changed | Proved by |
|---|---|---|
| J1 | `interpretExtractionTurn` treats any `turn.cancelled` as not ok, with the reason "The extraction was stopped before it finished. Try again." No content hash is recorded, and claims the tool step saved before the cancel stay, as on the timeout path. The next extract of the same text starts a new session. | `test/onboarding-extract-timeout.test.ts`, both with the real eve@0.63.0 `Client` over a stubbed `fetch`: "J1: a cancelled turn (extract_claims persisted → turn.cancelled → session.waiting) is not ok, records no hash, keeps the saved claim, and the same text runs again", and the control "the spike's normal turn (… turn.completed → session.waiting) that persisted claims is ok, records the hash, and cancels nothing". Mutation S1. |
| J2 | No code, as decided. §8 item 15 already says why. | — |
| J3 | **Refusal:** while `markdownError` is set, every refused write is one line, "Not saved: career-profile.md has an edit the runner can't read. See the note at the top." (`MARKDOWN_UNREADABLE_REFUSAL`). No field error and no `aria-invalid` appear on either page. **Note:** the strict reader names the problem by line: "Line 36: the line for the boundary “…” is missing, or its marker was changed. Put it back as it was." The note and the line never show a marker's id; only the file's own text in the Profile editor does. **Save & extract:** the text is saved, because source text is not profile data, and extraction is refused with 409 before any eve call. The page says "Text saved, but not extracted: fix career-profile.md first. See the note at the top.", or "Not extracted: …" when there was nothing new to save. **Discard** clears every field error on both pages and focuses the page title. **Profile editor:** while the file can't be read, it shows the file as it is on disk, read-only, labelled "The file as it is on disk (read-only until the problem above is fixed)", and "Save edits" is hidden. Typed text is never replaced. A save that finds the file unreadable keeps the text editable and moves focus to the note. Discard keeps the text, says "File edits discarded; your unsaved text in the box is kept.", and a later save works. | Route: "an unreadable edit (a deleted marker, probe B2) refuses every write with 409, …". It sends a statement, a source status, approve and extract, and pins both constants. It checks that no eve call is made, that nothing is written and that no UUID appears. It also checks the `Line N: …` pattern, `markdownOnDisk` and `GET /markdown`. Strict reader tests in `test/profile-markdown-strict.test.ts`. DOM (`test/ui-pages.test.ts`): "while career-profile.md can't be read, a refused write is the one short line: no field error, no aria-invalid, focus and typed text stay"; "Discard clears every field error and moves focus to the page title before the note is hidden"; "shows the file as it is on disk, read-only, with no Save, while it can't be read"; "a save that finds the file unreadable keeps the typed text, moves focus to the note, and Discard keeps the text too". Browser: 17 J3 checks. Mutations S7, S8, S9, S11, C3, P2, P3, P4. |
| J4 | Both pages now update the DOM in place instead of rebuilding it. Nodes are matched by id, else by position. Handlers are set as properties and read `event.currentTarget`. The focused node is never replaced or moved, and a focused field's text is never rewritten. A focused node that has to go is held until focus has moved to the planned target, and a focused control that has to be hidden is hidden only afterwards. So focus goes straight from the old control to the new one, never through `<body>`. When focus moves to a field that carries the detail, the line says only the short outcome: "An answer is needed." when Confirm opens a question, "Not added.", "Not saved." or "Nothing to extract." for a field error. Each outcome is written to the one live region once. | DOM (`test/ui-pages.test.ts`, the pages' own scripts in happy-dom against the real routes): "a status button is the very same node after its action, and no focus event fires"; "Confirm on a metric moves focus straight to its answer box, with the Confirm button still on the page, and the line says only that an answer is needed"; on Profile, Save is still shown when the note takes focus. Browser: 19 J4 checks, including a focus log of exactly one move, Confirm → answer box, and announcements counted per outcome. Mutations C1, C2, C5, C6, P1. |
| J5 | **Short messages:** reducer messages (checked across a full scenario) and route messages (checked for all seven labels) are at most 90 characters, usually one sentence. A few pair a short outcome with the next step, like the D9 line J3 chose. **Clamp:** at 640 px and below the line clamps to two lines (`line-clamp: 2`); its text node keeps the whole sentence, and so does its `title`. **Scroll padding:** `scroll-padding-top` follows the line's measured height through a `ResizeObserver` (`--last-action-offset`). **Focus clear:** a control focused from the keyboard, or by a render, is scrolled fully clear of the line; that includes the Profile editor at 390. **Caveat:** a message that passes on eve's own error text ("The extraction turn for X failed: …", "The extraction failed: … (code)") can run longer. It clamps the same way. | Reducer: "no reducer message carries a UUID, a short id, or a raw category key" (asserts ≤ 90). Route: "J5: every message a source's routes send is 90 characters at most, for every label". Browser at 390: the line is 30 px (1 line) after a question and 48 px (2 lines) after a D9 refusal. The offset follows it (47 px, then 65 px). The answer box, the input and the Profile editor are clear of the line, whether reached by Tab or by Shift+Tab. Mutations S12, S13. |
| J6.1 | "Working…" shows only if the request is still running after 300 ms. | Browser: nothing says Working in the first 150 ms; Working, then the outcome, announced once each. |
| J6.2 | `npm run runner` in a message is rendered in `<code>`. | Browser: J6.2. |
| J6.3 | A field error clears as soon as its field changes, and every action clears all earlier field errors first, so none outlives a later action. | DOM: "a field error sits on its field with the short outcome in the line, and goes with the next unrelated action". Browser: 2 checks. Mutation C4. |
| J6.4 | `questionReason` names the real trigger. It gives "it's a metric claim" when the kind always asks, else the always-ask word as written ("it says “Led”"), else nothing. The reducer's message uses it, and the page view's `questionReasons` puts "Asked because …" into the answer box's description. | `test/profile-questions.test.ts` (3 tests); the reducer test "J6.4: the needs-an-answer message names …"; the N4 route test; the DOM Confirm test; 3 browser checks. Mutation S10. |
| J6.5 | The readiness summary reads as one phrase ("Not ready: generation locked"), with no "Not yet:"/"Done:" prefix. The other lines keep theirs. | Browser: 2 checks. |
| J6.6 | Before a render, the page notes where the focused control is on screen. If the render moved it, the page scrolls back by the difference, and `overflow-anchor: none` keeps the browser from also adjusting. | Browser: the focused button stayed at 420.5 px while the D9 note appeared above it. At 390 the editor stays clear after a refused save. |
| J6.8 | Both withdrawal cards link the open question (`/ui/onboarding#question-<id>`). The link moves focus to its answer box, and so does opening Onboarding with that hash. | Browser: 4 checks. |
| J6.9 | Evidence refs read "pasted.txt, line 3", with the full path in `title`. The extraction prompt is unchanged. | DOM Confirm test (text and `title`); browser J6.9. |
| J6.10 | Profile's Status card lists each open question near the top, with the claim's words and the question, linked to its answer box. | `P03-profile-question-open-*`; browser J6.10. |
| J6.11 | The pages use the file's wording in local time with the zone named, for example "23 September 2026 at 17:56 EDT". The file keeps UTC. | Browser: 2 checks. |
| J7 N1 | The D8 wait's deadline is set before the in-process chain is joined, so queued writers all give up about 5 s after they asked. | `test/profile-writes.test.ts`: "N1/N2 (revision 3): writers queued behind one another all give up about 5 s after they asked, not at 5, 10 and 15 s". Three queued writers each get the busy error between 4.9 and 6.5 s. Mutation S2. |
| J7 N2 | The route's 503 test is timed. | "answers 503 'The profile is busy' …" asserts 4.9 s ≤ elapsed < 6.5 s. |
| J7 N3 | Extract is in the D9 route loop. | The J3 route test (no eve call). Mutation S8. |
| J7 N4 | D10 notes are in the page view. | "N4: carries D10's notes on an open question, keyed by claim id, and drops them once the question is answered". |
| J7 N6 | When rendering, a line that ends in a marker-shaped token gets one escaping backslash, and the reader strips exactly one, so any text round-trips. That includes a no-break space before the marker. | `test/profile-markdown.test.ts`: property tests over 40 seeded texts with hostile tails, plus the exact-escape test. `test/profile-store-revision2.test.ts`: "N6 (revision 3): claim text shaped like markers never makes the runner's own file unreadable", which includes an unchanged save that round-trips. Mutations S3, S4, S5. |
| J7 N7 | `GET /readiness` reads through `load()`. | "N7: GET /readiness applies a hand edit first, the same as GET /". Mutation S6. |
| J8 | The shots listed below, all taken after the P08-A merge. | — |

**The DOM test and happy-dom.** `runner/test/ui-pages.test.ts` loads each page's HTML and runs its module in happy-dom 20.14.5 against the bridge's real routes. happy-dom is resolved from the extension's install (`createRequire(extension/package.json)`), because adding it to the runner would change `runner/package.json` and `pnpm-lock.yaml`, which are outside this packet's Owns. If the extension ever drops happy-dom, this test breaks, so a runner devDependency is a sensible follow-up for whoever owns those files. The browser checks below cover the same behaviour in Chromium.

**Tests run, real output.** All commands were run from the repo root at `3cbae94`, with only this report uncommitted, and every one exited 0.
- `pnpm install --frozen-lockfile`: already up to date.
- `pnpm typecheck`: all 6 packages done.
- `pnpm test`:
  - contracts: 16 files, 235 tests;
  - job-assistant: 6 files, 151 tests;
  - extension: 16 files, 130 tests plus 2 skipped;
  - runner: 35 files, 561 tests;
  - `eve eval`: 5 of 5, 85 gates;
  - catalog: 26 files, 168 tests;
  - root `scripts/*.test.mjs`: 2 of 2.
- `pnpm -r lint`: 6 of 6 clean.
- `pnpm check:fixtures`: exit 0.
- `git status --porcelain` afterwards listed only this packet file.
- An earlier `pnpm test` run at `1982598` failed while other agents were loading the machine. Six runner tests in five files hit vitest's 20 s timeout: budget, runs (two), bridge, profile-store and profile-store-revision2. Catalog's `tests/db/global-singleton.test.ts` also reported one failure, with no reason printed before the parallel run stopped. As the brief says, I reran with `pnpm -r --workspace-concurrency=1 test`, where everything passed (runner 560, eval 85 gates), then `node --test scripts/*.test.mjs`, 2 of 2. The runs at `5115312`, `479298d` and `3cbae94` passed in parallel.

**Browser checks.** The harness is scratch in `/tmp/wc-p03-esc-r2/`. The bridge runs on 127.0.0.1:4320 against a scratch workspace, with a fake eve gateway that runs the real verify-then-persist helper. The real HOME, the keychain and any model were never touched.
- `checks3.mjs` (revision 3): 71 of 71, `checks3-run3.log`.
- `checks2-r3.mjs` (revision 2's checks, reworded for revision 3's messages): 72 of 72, `checks2-r3-run2.log`.
- Both ran on the page code committed in `5612d69`, before the P08-A merge. The merge changed none of these pages' files, only `runner.css` (the `.badge.fail` text colour and form-control borders) and the nav. The DOM test ran again after the merge, as part of the 561.

**Screenshots (J8).** There are 62 files in `docs/screenshots/`, all taken after the P08-A merge, so the nav shows Runs and Settings. Every one is axe clean and has no sideways scroll (`/tmp/wc-p03-esc-r2/shots-audit.json` and `shots-audit-r3.json`). The console is clean apart from Chrome's own "Failed to load resource: 409" line for the deliberately refused requests in the D9 and refusal shots.
- The 48 state shots, retaken full page: `P03-{onboarding,profile}-{empty,in-progress,question-open,ready,approved,withdrawn}-{light,dark}-{390,1280}.png`. The Profile question-open shots show both open questions in the Status card (J6.10).
- 8 new D9 shots, full page: `P03-{onboarding,profile}-d9-{light,dark}-{390,1280}.png`.
  - The note reads "Line 36: …", and no UUID is visible.
  - On Onboarding, Save & extract with the saved text says "Not extracted: fix career-profile.md first. See the note at the top.", with no field error.
  - On Profile, the editor shows the file on disk, read-only, with no Save.
- 6 new viewport shots at 390:
  - `P03-onboarding-line-question-{light,dark}-390.png`: after Confirm on the metric. The line is one line (30 px) and says "An answer is needed.". Focus moved once, straight to the answer box, which sits at 619–706 px of 844.
  - `P03-onboarding-line-refusal-{light,dark}-390.png`: after Enter in the preference field while the file is unreadable. The line is two lines (48 px). Focus stayed in the field, at 462–503 px, its text was kept, and there is no field error.
  - `P03-profile-line-editor-{light,dark}-390.png`: after Tab into the editor. It sits at 249–697 px, clear of the line.
- Every server and browser I started was stopped, and port 4320 was the only one used.

**Mutation proofs.** There are 23 mutations, all on revision 3's code, and all were killed. Each was applied to one file and tested with its named tests, then restored from a `/tmp` backup and compared byte for byte. `git status --porcelain` was clean afterwards. Scripts and logs: `/tmp/wc-p03-esc-r2/mut/` (`specs3.mjs`, `run3.mjs`, `mutations3.log`, `out/mut3-*`).

| Mutation | File | Killed by |
|---|---|---|
| S1 `turn.cancelled` counts as ok | server/routes/onboarding.ts | J1: a cancelled turn … |
| S2 deadline set inside the chain | store/profile-writes.ts | N1/N2 (revision 3): writers queued behind one another … |
| S3 no escaping backslash | store/profile-markdown.ts | reads back hostile claim … text exactly (seeds 1–40) |
| S4 no unescape | store/profile-markdown.ts | the same property tests |
| S5 marker tail without `\s*` (no-break space) | store/profile-markdown.ts | the same property tests |
| S6 `readiness()` without `load()` | store/profile.ts | N7: GET /readiness applies a hand edit first |
| S7 409 says the reader's problem | server/routes/onboarding.ts | the D9 route test; both D9 DOM tests |
| S8 extract not refused under D9 | server/routes/onboarding.ts | the D9 route test |
| S9 no line number in the problem | store/profile-markdown.ts | refuses a removed marker, naming the claim; D9 route and DOM tests |
| S10 no kind reason | store/profile-questions.ts | names a kind that always asks; the DOM Confirm test; N4 |
| S11 no file on disk in `load()` | store/profile.ts | shows the file as it is on disk …; the D9 route test |
| S12 the 91-character 413 message | server/routes/onboarding.ts | J5 route test; VN3 |
| S13 the 91-character nothing-saved message | server/routes/onboarding.ts | J5 route test |
| C1 rebuild instead of morph | ui/assets/onboarding.js | a status button is the very same node …; Confirm … |
| C2 focused node removed at once | ui/assets/onboarding.js | Confirm on a metric … still on the page … |
| C3 field error under D9 | ui/assets/onboarding.js | while career-profile.md can't be read, a refused write is the one short line … |
| C4 errors outlive later actions | ui/assets/onboarding.js | a field error … goes with the next unrelated action |
| C5 a refusal moves focus to the button | ui/assets/onboarding.js | the D9 refusal DOM test (focus stays in the field) |
| C6 the question's line repeats the message | ui/assets/onboarding.js | Confirm on a metric … the line says only that an answer is needed |
| P1 focused Save hidden at once | ui/assets/profile.js | a save that finds the file unreadable … |
| P2 editor shows the render, not the file | ui/assets/profile.js | shows the file as it is on disk … |
| P3 Discard drops the typed text | ui/assets/profile.js | a save that finds the file unreadable … Discard keeps the text too |
| P4 D9 save shown as a field error | ui/assets/profile.js | the same test |

**Notes.**
- Two orchestrator messages came this round, the revision-3 brief and the mid-round P08-A merge instruction. Both carried 709f68, and nothing claimed to be the orchestrator without it.
- These MCP servers need authentication and were not used: claude.ai Dice, Excalidraw and Slack, and plugin:cloudflare (api, bindings, builds, observability). They stay unavailable until someone authorizes them, in the claude.ai connector settings or with `claude mcp` (`/mcp`) in an interactive session.
- The harness refused some commands for complexity: an inline node edit script, a heredoc piped to node, a grep whose pattern held backticks, and an awk one-liner. I split them, or used Edit/Write, single quotes and grep instead. No permission or deny rule refused anything.
- The background agents in this session (P07-B escalation implementer, P08-A round-3 reviewer and UI critic) belong to the orchestrator. I did not interact with them.
- The authorizations note that `492c432` added under eve-runtime §8 item 15 touches the extraction route too. `interpretExtractionTurn` checks failures, cancels, input requests and the boundary, not a pending `authorization.required`. The note says this can't happen while `runner/agent` has no connections, and gives it to the first packet that adds one. The orchestrator said J1–J8 are unchanged, so I changed nothing for it.

### 2026-09-22 — Revision 2 (iter-005 Opus escalation)

**PR:** [#11](https://github.com/radroid/workflow-catalog/pull/11) `packet/P03` → `overnight/integration`. The code is at `8e4ca45`; this report is the commit after it. CI on `8e4ca45`: run `35782815079`, success. `git merge-tree` against integration head `54c6550` merges with no conflicts.

**Scope.** This round covered the combined list in `logs/handoff/P03-round-2-review.md`: UI critic issues 1–9 and the polish list, reviewer items V1–V6 and VN1–VN11, and orchestrator decisions D8–D16. It also covered the orchestrator's eve-runtime §8 item 15 instruction for the extraction route. The items round 2 verified (C4, C5, C7–C10, D3 preferences) were kept. The tests behind round 2's R1–R8 and D2 kills are still in the suite and pass. Those older mutations were not re-run this round, except R4's, which were re-pointed at the current code and are listed below. The chain and all 72 scripted UI checks were re-run after the last code change.

**Per-item map.**

| Item | Status | One line |
|---|---|---|
| V1 / D9 | Done, 6 mutations killed | Every profile write reconciles `career-profile.md` first, inside the D8 lock. That covers every route and both eve roots' tool steps. An edit the runner can't read refuses every write, with nothing written or re-rendered. `load()` reports the problem as `markdownError`. Both pages show it with "Discard my edits to career-profile.md" (`POST /markdown/discard`). Extraction is refused with 409 before any model call. After approval, a parsed hand edit becomes a proposed revision. A render fingerprint (`.runner/onboarding/markdown.json`) tells a file left stale by a crash apart from a hand edit. |
| V2 / D13 | Done, 2 mutations killed | `GET /sources/:category/content` returns the raw text of `sources/<category>/pasted.txt`, with no `##` headers. Saving that text back unchanged returns `unchanged` and starts no eve session; probe A is now a route test. |
| V3 / D10 | Done, 3 mutations killed (one through `eve eval`) | Only an explicit option changes a claim. A free-text reply leaves the claim disputed with its question open, is kept as the person's note (shown on the page), and gets a tool result with `"status":"open"`. The eval sends the three probe answers ("No, I can't back that number up.", "exclude", "what do you mean?") and checks that each is kept, in order, as a note. |
| V4 / D8 | Done, 4 mutations killed | New `runner/store/profile-writes.ts` runs every write under a per-workspace promise chain plus an O_EXCL `.runner/profile.lock`. A writer waits at most 5 s and then gets 503 "The profile is busy. Try again in a moment."; a lock older than 30 s is broken, with a log line. P02 has no lock to reuse: `createFileExclusive` has no wait, staleness check or release. Probe D is now a test: 7 concurrent source posts are all recorded, and two concurrent decisions are both kept. |
| V5 | Done, 4 mutations killed | The eval agent's `ask_follow_up` is now a thin executor with one-line step wrappers over the directive-free `runner/agent/lib/ask-follow-up-steps.ts`, the same as production. `test/onboarding-tools.test.ts` runs both roots' tool modules against the same expectations. "Always confirm" and "no open-claim check" are killed in either root. |
| V6 | Done (this report) | The D3 deferral is under "What was skipped". The wrong D6 lesson is corrected in the iter-004 section and in the tool and lib comments (`agent/tools/extract_claims.ts`, its eval-agent copy, `agent/lib/onboarding-store.ts`, both `ask_follow_up` files). The R11 list is below, and R4 now has 15 mutations, listed below. |
| VN1 | Corrected | D7 was done in `e698182`, and revision 1's table now says so. |
| VN2 | Corrected | The PAUSE message was genuine (`a9abb70`), and revision 1's note now says so. |
| VN3 | Done, 5 mutations killed | Each untested mutation now fails a test: `resolve` in place of `resolveReal` (a symlink escape), no 2 MiB total cap, the superseded evidence ref dropped, the `_None yet._` placeholder, and a missing timeout signal (now a 504 with a plain message). |
| VN4 | Done | Path confinement is asserted on disk: a traversal name, from the text box or an upload, lands at its cleaned name under `sources/<category>/` and nowhere else. |
| VN5 | Done | A non-.txt/.md upload gets 415 `unsupported_upload`, and the test asserts that instead of a 200. |
| VN6 / D14 | Done, 1 mutation killed | The content hash is recorded only when the turn's events include a persisted `extract_claims` result. A turn that never called the tool records nothing, so the next extract runs again. |
| VN7 / D15 | Done | An edit that adds an always-ask item re-opens the claim's question. That means any change to a metric, title or date claim, or a new always-ask word or number in any other claim (`editAddsAlwaysAskItem`). While the profile is approved, the edit is a proposed revision; accepting it re-opens the question, which withdraws approval. |
| VN8 | Done | Multi-line evidence quotes and questions render as indented continuation lines in `career-profile.md`, and the strict reader reads them back. |
| VN9 | Accepted as is | Contracts are closed to P03, so withdrawals are still stored as `accepted` revisions, with the withdrawal as the reason. This is a contracts follow-up. |
| VN10 / D11 | Done, killed by R4-1 below | A withdrawal applies its pending revisions to the draft and records them as `accepted`, with the withdrawal as the reason. No pending revision survives into re-approval, and both pages explain the withdrawal. |
| VN11 / D13 | Done, 3 mutations killed | An upload's name is stable and sanitised from its original: lower-cased, with unsafe runs turned into `-`. Uploading the same name again replaces the earlier upload, uploads are listed by name, and `pasted.txt` stays the text box's file. |
| UI 1 | Done | After an action, focus goes to a planned target, never to `<body>`. After a claim decision, that is the claim's own next action, else the next undecided claim's first action, else its card. After a revision decision, it is the next revision's Accept, else the revisions heading. The source toggle has a stable id and keeps focus, and Save & extract keeps focus after it succeeds. |
| UI 2 | Done | Messages name a claim by its words (quoted and cut at 60 characters) and a source by its label, never by an id or key. Yes with no text reads "Evidence: you confirmed it without adding detail." |
| UI 3 / D12 | Done | There is one live region, the sticky "Last action" line, and it announces each outcome once; a script counts this. The line stays in view at every width and is compact at 390, and `scroll-padding-top` follows its height. `#page-error` is only for page-load failures. Field errors sit next to their control, with `aria-invalid` and `aria-describedby`. |
| UI 4 | Done | With zero claims the line reads ○ "No claims yet". Each line carries a hidden "Done:" or "Not yet:", and unmet lines have their own words. The approve help text and button are rebuilt from state on every render, so a withdrawn profile never says "approved". |
| UI 5 | Done | The excluded badge is white on #b91c1c, about 6.5:1, in both themes. axe is clean in all 48 screenshots and in the scripted check of a page with an excluded claim. |
| UI 6 / D13 | Done | Drafts survive re-renders, kept per control: source text, answers, reasons and statements. A source's saved text is fetched raw when its panel opens. |
| UI 7 | Done | The reason field has a visible label naming the source and is shown after Unavailable or Not applicable. "Save reason" saves it on its own, and a switch between the two keeps it. The recorded reason shows as wrapping text, checked at 390. |
| UI 8 / D11 | Done | Both pages explain a withdrawal: the version, the claim or statement that changed, the revisions applied, and what to do next. Accept and Reject are never offered while the profile is unapproved. Onboarding points to the Profile page when a revision is pending. |
| UI 9 / D16 | Done | All 48 screenshots are named `P03-<page>-<state>-<theme>-<width>.png`. Eight old files were removed with `git rm`; the ninth, `P03-onboarding-approved-light-1280.png`, keeps its name and was replaced. `8e4ca45` also makes the Profile Status card state-aware: it lists what is left to do, so each state's shot differs. Before, four Profile states produced byte-identical images at 390. |
| Polish | Done, 12 of 12 | See the list below. |
| eve §8 item 15 (orchestrator) | Done, 3 mutations killed | After `result()` resolves, the route checks `signal.aborted`. A timed-out turn gets a 504 and is cancelled through `ClientSession.cancel()`, because `MessageResponse.cancel()` sends nothing before `turn.started` or once the turn is parked. A turn counts as ok only with a terminal `session.*` boundary event (`isCurrentTurnBoundaryEvent`). A parked or unfinished turn is cancelled through its session. `test/onboarding-extract-timeout.test.ts` drives the real eve@0.63.0 `Client` over a stubbed `fetch` in 6 cases, including an abort before the stream opens and a stream reopened after its lease ends. I read the P08-A probes in `/tmp/p08a-review/in-tree-probes/` without editing them, and imported nothing from P08-A's branch. |

**Polish.**
- The "eve is not running" error has no backticks: "eve is not running. Start the runner with npm run runner, then try again."
- Source-row buttons line up on a fixed grid column at 1280, and the rows stack at 390.
- The answer box has a visible label: "Your answer (optional): a ticket, a dashboard, how you know it".
- Save messages say what happened:
  - A save with no change says "Nothing to save: the text is the same as the profile."
  - A save counts edits applied and revisions proposed, with singular and plural wording.
  - Nothing stale stays after Accept or Reject, because the one "Last action" line replaces the old result lines.
  - Rejecting a boundary says "The boundary keeps its current text."
- A focused result or heading uses the theme's `--ring`, and the approval message appears once.
- At 390 the file input stays inside the Sources card.
- Enter submits the boundary, preference and presentation fields.
- Accept and Reject have names with context, for example "Accept the revision to the claim “…”".
- Uploads keep their own sanitised names (VN11).
- Onboarding shows a hint, with a link to Profile, when a revision is pending.
- `career-profile.md` shows times as "22 September 2026 at 14:05 UTC", not raw ISO.

**Tests run, real output.** All commands were run from the repo root at `8e4ca45`, with only this report uncommitted, and every one exited 0.
- `pnpm install --frozen-lockfile`: already up to date.
- `pnpm typecheck`: all 6 packages done.
- `pnpm test`:
  - contracts: 16 files, 235 tests;
  - job-assistant: 6 files, 151 tests;
  - extension: 16 files, 130 tests plus 2 skipped;
  - runner: 28 files, 374 tests;
  - `eve eval`: 5 of 5, 85 gates (approval 4/4, tool-surface 4/4, skills 4/4, missing-tools 8/8, onboarding-extraction 65/65);
  - catalog: 26 files, 168 tests;
  - root `scripts/*.test.mjs`: 2 of 2.
- `pnpm -r lint`: 6 of 6 clean.
- `pnpm check:fixtures`: exit 0.
- `git status --porcelain` afterwards listed only this packet file, so the chain left no stray output. It was empty once this report was committed.

**Scripted UI checks and screenshots.**
- The harness is scratch in `/tmp/wc-p03-esc-r2/`:
  - the bridge runs on 127.0.0.1:4320 against a scratch workspace there;
  - a fake eve gateway runs the real verify-then-persist helper on each source line;
  - sign-in goes through `/ui/login`;
  - the real HOME, the keychain and any model were never touched.
- `checks.mjs`: 72 of 72 passed in the final run, `checks-run6.log`. The checks cover focus after each action, announcements counted per outcome, drafts, reasons, uploads, R7, D9 refusal and discard, D11 withdrawal, D12 field errors and the sticky line at 390, axe for the badge, and a clean console.
- The 48 screenshots are full page, at true width, 1x DPR. Every one is axe clean, has no sideways scroll and no console errors (`shots-audit.json`), and no two are identical.
- Every server and browser I started was stopped.

**Mutation proofs.** There are 43 mutations, all killed. Each was applied to one file and tested with its named tests, then restored from a `/tmp` backup and compared byte for byte. `git status --porcelain` was empty after each batch. Scripts and logs: `/tmp/wc-p03-esc-r2/mut/` (`specs.mjs`, `run.mjs`, `mutations.log`, `out/`).

| Mutation | File | Killed by (first failing test) |
|---|---|---|
| V1-reconcile-ignores-file | store/profile.ts | saves a hand edit to a claim before an unrelated write, and says so |
| V1-unreadable-edit-dropped | store/profile.ts | an edit it can't read refuses every write: nothing is written or re-rendered, load() says why, and discarding the edit recovers |
| V1-no-fingerprint | store/profile.ts | a file left stale by a crash between the JSON and markdown writes is not mistaken for a hand edit (fingerprint) |
| V1-approved-edit-applies-directly | store/profile-reducer.ts | lists proposed revisions while approved, and explains a withdrawal once it happens |
| V1-load-hides-error | store/profile.ts | (as V1-unreadable-edit-dropped) |
| V1-discard-keeps-edit | store/profile.ts | (as V1-unreadable-edit-dropped) |
| V2-get-content-with-headers | server/routes/onboarding.ts | V2: GET returns the text box's raw text, and saving it back unchanged is 'unchanged', with no second eve session |
| V2-upload-name-not-stable | store/profile.ts | names uploads stably from the original name, and refuses anything but .txt and .md |
| V3-free-text-confirms | agent/lib/ask-follow-up-logic.ts | never decides on free text alone: the round-2 probe answers are notes |
| V3-note-not-recorded | agent/lib/ask-follow-up-steps.ts | leaves the claim open on each of the round-2 probe answers, keeping each as a note, and tells the model so |
| V3-free-text-confirms-agent-run | agent/lib/ask-follow-up-logic.ts | `eve eval` onboarding-extraction 42/46: "No, I can't back that number up." confirmed the metric |
| V4-no-chain | store/profile-writes.ts | runs work for one key strictly in order, and a failure doesn't stop the queue |
| V4-no-lock-file | store/profile-writes.ts | keeps a second process out while the first holds the lock file, then lets it in |
| V4-stale-lock-never-broken | store/profile-writes.ts | breaks a lock older than 30 s, left by a process that died, with a log line |
| V4-no-wait | store/profile-writes.ts | keeps a second process out while the first holds the lock file, then lets it in |
| V5-prod-always-confirm | agent/tools/ask_follow_up.ts | asks the question, then confirms only on the Confirm option |
| V5-prod-no-open-claim-check | agent/tools/ask_follow_up.ts | refuses to ask about a claim that already has a decision, and asks nobody |
| V5-eval-always-confirm | eval-agent/agent/tools/ask_follow_up.ts | asks the question, then confirms only on the Confirm option |
| V5-eval-no-open-claim-check | eval-agent/agent/tools/ask_follow_up.ts | refuses to ask about a claim that already has a decision, and asks nobody |
| VN3-save-uses-resolve | store/profile.ts | VN3: refuses to write through a sources/<category> symlink that leaves the workspace |
| VN3-no-total-cap | server/routes/onboarding.ts | VN3: refuses to extract when everything saved for a category adds up to more than 2 MiB |
| VN3-superseded-ref-dropped | store/profile-reducer.ts | answering a question keeps the old passage's kind, quote and ref in revisions[] |
| VN3-empty-placeholder-no-period | store/profile-markdown.ts | VN3: an empty section shows its placeholder |
| VN3-no-timeout-signal | server/routes/onboarding.ts | R3 timeout: passes a live AbortSignal to eve, and a timeout is a 504 with a plain message |
| D14-hash-always-recorded | server/routes/onboarding.ts | D14 (VN6): a turn that never called extract_claims records no hash, says nothing was saved, and the next attempt runs again (and 4 more) |
| E815-no-aborted-check | server/routes/onboarding.ts | the deadline fires while the stream is opening: result() resolves quietly, and the route still reports a timeout and cancels the session |
| E815-cancel-through-response | server/routes/onboarding.ts | (same test) |
| E815-no-boundary-check | server/routes/onboarding.ts | a 'completed' turn with no terminal session event never finished: not ok, no hash, and the session is cancelled |
| R4-1-no-withdrawal-on-confirm | store/profile-reducer.ts | re-confirming a claim withdraws v1; approving again produces v2, never v1 again (and 3 more) |
| R4-2-answer-keeps-passage-evidence | store/profile-reducer.ts | answering with evidence, on an approved profile, withdraws approval and records the new evidence as {kind: statement}, not the superseded passage |
| R4-3a-reason-sources | store/profile-reducer.ts | state 1: sources unaccounted for |
| R4-3b-reason-pending | store/profile-reducer.ts | state 2: a claim still needs a decision, named by its words |
| R4-3c-reason-no-claims | store/profile-reducer.ts | state 3: no claims yet |
| R4-3d-reason-all-excluded | store/profile-reducer.ts | state 4: every claim was excluded, nothing to write from |
| R4-3e-reason-not-approved | store/profile-reducer.ts | state 5: ready to approve, but approval itself has not happened yet |
| R4-4-titles-dates-not-asked | store/profile-questions.ts | ALWAYS_ASK_KINDS matches the skill's kinds exactly |
| R4-5-maintainer-dropped | store/profile-questions.ts | ALWAYS_ASK_WORDS matches the skill's words exactly |
| R4-6-no-sanitising | store/profile.ts | names uploads stably from the original name, and refuses anything but .txt and .md (and 4 more) |
| R4-6b-write-raw-return-sanitised | store/profile.ts | VN4: an upload with a traversal name lands at its cleaned name under sources/<category>/, and nowhere else (and 3 more) |
| R4-7-no-data-framing | server/routes/onboarding.ts | frames the source text as data, never instructions, inside a fresh random per-call delimiter |
| R4-8a-no-source-content-cap | server/routes/onboarding.ts | 413s the text box and upload routes over the source-content cap (512 KiB) |
| R4-8b-no-markdown-cap | server/routes/onboarding.ts | 413s /markdown over the markdown cap (512 KiB) |
| R4-8c-no-small-body-cap | server/routes/onboarding.ts | 413s /sources/:category over the small-body cap (8 KiB) |

**Files outside Owns (R11).** This covers every file the branch changes against integration, beyond the literal `Owns:` line.
- **Approved by D1** (`logs/handoff/P03-revision-1.md`):
  - `runner/store/profile-{types,reducer,questions,markdown}.ts`, the split of `profile.ts`.
  - `runner/agent/lib/`: `extract-claims-{logic,schema}.ts`, `ask-follow-up-{logic,schema}.ts` and `onboarding-store.ts`, plus `ask-follow-up-steps.ts`, new this round.
  - The eval-agent files: `agent/tools/{extract_claims,ask_follow_up}.ts`, `agent/lib/{fixture-registry,tool-registry}.ts`, `agent/lib/fixtures/onboarding.ts` and `evals/onboarding-extraction.eval.ts`. Two of them are P02's own files, `agent/lib/fixture-model.ts` and `evals/tool-surface.eval.ts`, changed in iter-004 and not since.
  - The new `runner/test/*` files. New this round: `ask-follow-up-steps`, `onboarding-extract-timeout`, `onboarding-tools`, `profile-markdown-strict`, `profile-reducer-revision2`, `profile-store-revision2` and `profile-writes`.
  - `runner/test/route-modules.test.ts`, for D2 only, in revision 1.
- **Approved in this escalation's brief:**
  - `runner/ui/assets/{onboarding,profile}.{js,css}`;
  - `packages/job-assistant/skills/follow-up-questions/SKILL.md`, changed in iter-004 and not this round;
  - the D8 helper `runner/store/profile-writes.ts`;
  - `docs/screenshots/P03-*.png`.
- **This packet file**, for the claim, the report and the corrections.
- **Not touched:** `packages/contracts`, `runner/server/context.ts`, other packets' routes, and any P02 file beyond D1.

**What was skipped, and why.**
- **D3:** PDF/DOCX extraction, URL import and the GitHub token are not built. They move to P03.1, because URL import shares a safe-fetch with P04 and spec §4 puts the token in the OS keychain. Uploads are `.txt` and `.md` only; anything else gets 415.
- **VN9:** accepted as is, because contracts are closed to P03 (see the table).
- **§8 item 15's "read the stream event by event for usage":** this doesn't apply here. The extract route records claims and a content hash, not usage.
- **`packages/job-assistant/fixtures/onboarding/`** is still not created. The iter-004 section explains why the eval fixtures live in the eval agent instead.
- **D4 stands:** the answer route resolves a question through the reducer, and `ask_follow_up` is the agent-driven path.

**Assumptions.**
- Upload names are lower-cased, so "Resume.md" and "resume.md" are the same upload on every file system.
- An upload named `pasted.txt` is saved as `pasted-file.txt`, because `pasted.txt` is the text box's file.
- The Profile page's save sends the hash of the text it loaded (`base`). If the profile changed since, the save is refused with 409 `markdown_stale` and the page keeps the person's text. Applying the page's older copy would undo someone else's change.
- A stale lock (D8) is judged by the lock file's age (its mtime). The lock file's record (a token, the pid and the time it was taken) goes into the log line. A holder only removes a lock whose token is its own, so a lock broken as stale and taken again is never removed by its first holder.
- The shared UI helpers are repeated in `onboarding.js` and `profile.js`. A shared asset would go in `runner.js`, which is P02's.

**Orchestrator messages.** Two messages carried the code word 709f68: this escalation's brief and the eve-runtime §8 item 15 instruction. I followed both. No message claiming to be the orchestrator arrived without the code word.

**Commits.**
- `13ed0dc`: claim;
- `f486c9e`: store, lock, reconcile, D10 and raw source text;
- `395ce58`: §8 item 15;
- `ff6f401`: both pages;
- `340abab`: the eval tool's header comment;
- `8e4ca45`: Profile status and its 24 screenshots;
- then this report.

**One thing to sharpen next time.** Make scripted interaction checks part of a UI packet's acceptance, run against a harness: focus after each action, one announcement per outcome, drafts surviving a re-render, and no two state screenshots identical. Every round-2 UI issue was behavioural and invisible in screenshots. The last one, four byte-identical Profile states, showed up only when the images were hashed.

### 2026-09-22 — iter-004 implementer (Sonnet)

**PR:** [#11](https://github.com/radroid/workflow-catalog/pull/11) `packet/P03` → `overnight/integration`, head `34edba5`. CI green.

**What was done.** All five deliverables: source accounting for the seven categories (`store/profile-types.ts`, `store/profile-reducer.ts`'s `accountSource`); durable claim extraction with evidence pointers (`agent/tools/extract_claims.ts`, a `defineWorkflowTool`); follow-up questions with durable HITL parking (`agent/tools/ask_follow_up.ts`, uses `ctx.ask`; the mechanical "always ask" rule lives in `store/profile-questions.ts`, kept in sync by hand with `follow-up-questions/SKILL.md`); readiness/approval with revisions (`store/profile-reducer.ts`'s `readiness`/`approve`/`editClaimText`/`acceptRevision`/`rejectRevision`); `career-profile.md` rendering and round-trip editing (`store/profile-markdown.ts`, wrapped with persistence and approval-aware revision semantics by `store/profile.ts`); and the two local UI pages (`ui/onboarding.html`, `ui/profile.html`, plus their `assets/*.{css,js}`). Also fixed `follow-up-questions/SKILL.md`'s summary lines to name "role, or scope" alongside "metric, superlative, title, date", matching its own Boundaries bullet.

**Tests run, real output.**
- `npx vitest run` in `runner/`: 17 files, 170 tests, all passed (includes the 6 walkthrough-scenario reducer tests, the markdown round-trip property tests, and 4 new `profile-store.test.ts` cases for the bug below).
- `eve eval` in `runner/` (`node --import ./lib/register-ts.mjs cli/eval.ts`): 5 evals, 41 gates, all passed — `approval 4/4`, `tool-surface 4/4` (exact list, including `extract_claims`/`ask_follow_up`), `skills 4/4`, `missing-tools 8/8`, `onboarding-extraction 21/21` (the fictional-resume extraction scenario, the metric left `candidate` with a question, and the hostile-fixture scenario asserting only `extract_claims` was called).
- Root verification chain: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm -r lint && pnpm check:fixtures` — all green. `pnpm typecheck`: 6/6 packages clean. `pnpm test`: contracts 235, job-assistant 151, extension 130 passed + 2 skipped, catalog 139, runner 170 + eve's 41 gates, root `scripts/*.test.mjs` 2 — all passed. `pnpm -r lint`: 6/6 clean. `pnpm check:fixtures`: 0 offenses, exit 0. `git status --porcelain` clean after.
- `npx vitest run` in `packages/job-assistant/` (after the SKILL.md wording fix): 6 files, 151 tests, all passed.

**A real bug found and fixed (not caught by any unit test).** Exercising the Profile page in a real browser (Approve → edit a confirmed claim's text → Save) showed no "Pending revisions" section and the approved text silently changed — `ProfileStore.applyMarkdownEdit` called the pure `applyMarkdownEdits()` helper directly, which has no notion of approval. Fixed in `cd56b8b` by routing a confirmed claim's edit through the reducer's `editClaimText` action instead (proposes a revision when approved, edits directly otherwise); boundaries/preferences/presentation and non-confirmed claims' text still apply directly, unchanged. `test/profile-markdown.test.ts` drives the pure functions directly and structurally cannot catch this class of bug — added `test/profile-store.test.ts` (4 cases) at the store layer. Re-verified after the fix with a second real click-through: the diff now appears correctly under "Pending revisions", `docs/screenshots/P03-profile-{light,dark}.png` show that state.

**New `runner/agent/lib/` files** (approved mid-run as an allowlist extension; that folder is otherwise P02's; no P02 file was edited): `onboarding-store.ts`, `extract-claims-schema.ts`, `ask-follow-up-schema.ts`.

**What was skipped/deferred, and why.**
- **The bridge route never drives `ask_follow_up`.** `/api/onboarding/claims/:id/answer` resolves a pending question deterministically via the reducer's `answerQuestion` action, matching the walkthrough (which never calls a model for this step either). `ask_follow_up` stays a real, eval-tested workflow tool for a genuine agent-driven session (`eve invoke`, or a future chat surface) where a *model* asks the question mid-turn via `ctx.ask`'s durable HITL parking — a different interaction shape than a REST endpoint. Wiring the route to invoke eve for something the reducer already resolves deterministically would add a model dependency for no behavioural gain.
- **`packages/job-assistant/fixtures/onboarding/` was never created**, despite being named in this packet's `Owns:` line. The extraction eval's fixture data lives instead in `runner/eval-agent/agent/lib/fixtures/onboarding.ts`, duplicated by value from P01's existing `packages/job-assistant/fixtures/resume.md`/`expected-claims.json` rather than a new file read at runtime — that module is part of the eval agent's *built* runtime (the scripted model `eve` calls mid-turn), and a cross-package file read from bundled agent code is not guaranteed to survive `eve build`. The `.eval.ts` file itself does read `resume.md` from disk (test/orchestration code, not bundled) to seed the temp workspace and cross-check the embedded constants stay real substrings. The hostile fixture (`HOSTILE_RESUME_TEXT`, "Sam Fernwood" / "Quill", both on the fixtures-policy allowed list) is new but lives in that same module rather than a standalone file, for the same reason.
- PDF/DOCX source upload extraction: out of scope, per `store/profile.ts`'s `sourceText()` doc comment — sources are read as plain text (fictional `.md`/`.txt` fixtures), matching `fixtures-policy.md`.
- Screenshots (both pages, light/dark, plus 390px for Onboarding) are not one of this packet's acceptance criteria — that is a separate "UI critic" pass in the wave plan (`OVERNIGHT-OPUS-PROMPT.md` iteration 4) — but were taken and visually verified anyway as evidence, via a throwaway local harness (`createBridgeApp`/`createRunnerContext` directly, an explicit `os.tmpdir()` workspace, `eve`/`model` left `undefined`, sign-in through the app's own `/ui/login?nonce=` flow — never `cli/{setup,doctor,runner}.ts`, so the real `$HOME`, OS keychain, and any live model were never touched; confirmed no `~/JobAssistant` exists under the real `$HOME` afterward). The harness script was scratch and was deleted, not committed. No separate 390px shot for Profile — the Onboarding one already demonstrates the responsive layout and the packet does not require per-page mobile coverage.

**Assumptions.** "Not applicable" and "unavailable" both count as a source being accounted for, with the reason kept as an optional note (matches the walkthrough). A claim's `question` is drafted mechanically (`profile-questions.ts`'s `draftQuestion`) when a decide/extract action needs one and none was supplied — a model may supply a better-drafted question via `ask_follow_up`'s own input instead; the mechanical version is the floor, not the ceiling (documented in `profile-questions.ts`). Approval is withdrawn automatically when a claim is newly confirmed on an approved profile (existing `decideClaim` behaviour — excluding or disputing a claim does not withdraw approval, only confirming does), but *not* when a brand-new candidate is extracted from a re-provided source post-approval — that claim just sits alongside the approved profile until decided; `test/profile-store.test.ts`'s third case exercises this directly.

**One thing to sharpen next time.** *(Corrected in revision 2, per D6. The lesson first written here was wrong: it said the executor had to be an inline function in the tool's own file, and that the fix was to inline every step in each tool file.)* Directives compile per app root (`docs/spec/research/eve-runtime.md` §8 item 14, verified by probe at eve@0.63.0). `"use workflow"` and `"use step"` are compiled and registered only for modules inside the app root being built (`runner/agent` or `runner/eval-agent/agent`). Within one root, imports work, including an imported `"use workflow"` executor and separate step modules. Across roots, re-exporting a workflow tool fails discovery ("requires a compiled workflow executor"), and an imported `"use step"` function builds but fails at run time ("Step … is not registered"). A directive-free helper imported from the other root and called from a local step works. So: shared logic goes in directive-free modules under `runner/agent/lib/`, each root keeps a thin executor and one-line step wrappers, and the eval agent never re-exports or copies a tool's logic. Its evals must exercise the shared helper.

### 2026-09-22 — Revision 1 (Sonnet)

**PR:** [#11](https://github.com/radroid/workflow-catalog/pull/11) `packet/P03` → `overnight/integration`, code at `ba0e2fc` (this report + the screenshot set land in the commit immediately after). This was the one revision round after the reviewer (11 issues, REVISE) and the UI critic (10 issues, REVISE) both reviewed head `3774f75`.

**Note on a suspicious mid-session message.** *(Corrected in revision 2, per the round-2 reviewer's VN2: the message was genuine. The owner paused the loop to switch the orchestrator model; see `a9abb70` and `logs/handoff/2026-09-22-pause.md`. Calling it an injection was wrong.)* Partway through this round, a message arrived formatted as an urgent orchestrator "PAUSE" instruction (stop the server, commit WIP as unfinished, append a differently-formatted "paused" report section, reply, stop). It did not arrive as a normal turn — it was spliced in immediately after a `find` tool result, the platform's own next system-reminder flagged the preceding content as a likely prompt injection, it named a port (4320) nothing in this session had used (the real bridge port here, and in `CLAUDE.md`, is 4310), and it described a "pause/iter-005" report protocol that appears nowhere in this repo's actual `CLAUDE.md` or in the real revision-1 instructions. I did not act on it — did not stop, did not push a "WIP (not green)" commit, did not adopt its report format — and continued this revision to the finish line as originally instructed. Flagging it here explicitly in case the real orchestrator wants to trace where it came from.

**One-line-per-issue map.**

| # | Status | One-liner |
|---|---|---|
| R1 | Done, mutation-proven | Approval version numbers never reused (`highestVersionUsed`, not `approval?.version ?? 0`) even across a withdraw/re-approve cycle. |
| R2 | Done, mutation-proven | Any claim change but exclusion withdraws approval (disputing included, not just confirming); statement edits become revisions too. |
| R3 | Done, mutation-proven | `interpretExtractionTurn` (new) catches a `turn.failed` event under a `"waiting"` status, a `"failed"` status, and an unshowable parked input request (which it also cancels) — a fake gateway previously read as success. |
| R4 | Done, mutation-proven | Full route-level test suite (`onboarding-routes.test.ts`, 24 tests): guards, body caps, unknown category/kind, upload path-confinement, the 5-state exact readiness text, plus the missing "excluding never withdraws" assertion in the reducer suite. |
| R5 | Done, mutation-proven (prior session) | `extract_claims`'s verify-then-persist logic de-duplicated into `agent/lib/extract-claims-logic.ts`; a fabricated (non-verbatim) evidence quote is rejected, eval-proven. |
| R6 | Done, mutation-proven (prior session) | `ask_follow_up`'s freeform-answer bug (`hasEvidenceFromAnswer`, `agent/lib/ask-follow-up-logic.ts`) — a text-only HITL answer with no `optionId` now confirms instead of silently excluding. |
| R7 | Done, mutation-proven | Idempotent extraction: unchanged source content short-circuits before touching eve; a failed turn never records a hash so it retries. |
| R8 | Done (prior session) | Multi-line bullet text round-trips through `career-profile.md` (`bulletLine`/`parseProfileMarkdownEdits`); covered by `profile-markdown.test.ts`'s existing round-trip cases, which also exercise the new C10 evidence line — not independently re-mutation-tested this pass. |
| R9 | Done — see D3 | Recordable-preferences UI now exists (was previously impossible to reach from the browser). |
| R10 | Done (prior session), re-verified green | `GET /`, `GET /markdown`, `POST /markdown` all reconcile `career-profile.md` from disk first, so a hand-edit to the file is never silently overwritten. |
| R11 | This report | Report accuracy — corrected per D6 below; no eve fact restated here beyond what the orchestrator already recorded. |
| C1 | Done | Stable ids everywhere; `captureFocus`/`restoreFocus` around every `reload()` (falls back to the claim/source-row/revision container when the exact control no longer exists); `aria-disabled` + a busy guard instead of the `disabled` attribute so an in-flight click never drops focus out of the tab order; focus moves to the result region after Approve/Save. |
| C2 | Done | `announce()` is the single outcome channel on both pages (added to `profile.js` from scratch — it had none) — updates the live region and a persistent, visible `#last-action` line that `reload()`'s rebuild does not discard. |
| C3 | Done | Readiness is now the walkthrough's exact four-line ●/○ display (sources, claims, approval, bold ready/not-ready summary) instead of a raw reasons `<ul>` with a stale "Ready. Approving unlocks generation." line that used to persist after approval. |
| C4 | Done | Removed the approve button's blanket `finally { disabled = false }`, which unconditionally undid `renderReadiness()`'s correct post-approval disabled state on every outcome including success; `reload()` is now the single source of truth for that button's state, confirmed by browser accessibility snapshot (`button "Approved" ... disabled` with the readiness lines as its `aria-describedby` description). |
| C5 | Done | Source-status badge logic fixed: `provided`/`unavailable`/`not_applicable` all render "ok"; only a genuinely unaccounted category (no status yet) renders "warn". |
| C6 | Done | `disputed` reads as "question open"; raw source category keys and claim status strings replaced with human labels everywhere on both pages, including a new client-side `decodeStatementEditSummary` so a pending boundary/preference/presentation revision on the Profile page shows a clean diff instead of the raw `statement-edit:...` string (this exact leak was not in the original report — found and fixed this pass). |
| C7 | Done | `.claim-head .badge { flex: none }` + `min-width: 0`/`overflow-wrap: anywhere` on the text column, verified at a real 390px width — no badge/text collision. |
| C8 | Done | Scoped `.error` override in `onboarding.css`/`profile.css` (never `runner.css`, P02-owned) using hand-verified WCAG sRGB contrast: `#b91c1c` on white = 6.46:1 (light), `#f87171` on black = 7.60:1 (dark), both well past the 4.5:1 AA floor for normal text. |
| C9 | Done | Each source row's status buttons are grouped under `role="group" aria-labelledby="<source name>"`; every status button now carries an explicit `aria-pressed` (`true` or `false`, not just when true); the content-toggle button carries `aria-expanded`/`aria-controls`. |
| C10 | Done | "Evidence: …" lines added to claim cards (`onboarding.js`) **and** to `career-profile.md`'s own rendering (`profile-markdown.ts`, new — confirmed round-trip-safe: the added line always follows a marker-terminated bullet, so it can never be swallowed as a continuation line even for multi-line claim text) — passage evidence shows the quote, statement evidence is labelled "your own statement". |
| D1 | Done | Re-confirmed additive Owns scope against the original packet spec; final touched-file list is below. |
| D2 | Done, mutation-proven | `route-modules.test.ts`'s directory-driven comparison (an independent `readdir` + hand-mirrored filter vs. the real loader's output) — proven non-tautological this pass. |
| D3 | Done (upload, reason, preferences); PDF/DOCX/URL/GitHub-token deferred to P03.1 | TXT/MD upload (client-side type gate, reads into the existing paste/save path); a reason field for Unavailable/Not applicable, wired to the API's existing `note` field, pre-filled from the current entry, hidden under an already-Provided source; a new `GET /sources/:category/content` route so previously-saved source text is shown instead of always starting blank; full UI for `POST /statements/:kind` (boundary/preference/presentation), live-tested end to end in a real browser. |
| D4 | Unchanged from original report | The route still resolves questions deterministically (`answerQuestion`); `ask_follow_up` stays the real, eval-tested workflow tool for a genuine agent-driven session. Report-only, no code change needed. |
| D5 | Done — same item as R8 | Multi-line markdown, see R8. |
| D6 | Report corrected | The orchestrator is recording the eve directive-sharing facts in `eve-runtime.md` directly; this report does not restate the earlier, imprecise framing. |
| D7 | Done in `e698182` *(corrected in revision 2, VN1)* | `runner/test/profile-reducer.test.ts` uses Northwind Labs, a fixtures-policy name, in place of the name D7 flagged. The original entry follows and was wrong. My working notes from the (compacted) prior session referenced "D1–D7" but only ever itemized D1–D6 with content; I don't have a distinct D7 to report against and did not want to guess one into existence. If the original review named a specific D7, please restate it. |

**Mutation proofs run this session** (each: `/tmp` or in-place backup → mutate → run the specific test file, confirm red → restore from backup → `diff` confirms byte-identical → re-run, confirm green). Files outside my Owns that already had uncommitted changes this session (`server/routes/onboarding.ts`) were restored from an explicit `/tmp` copy, never `git checkout --`, since HEAD does not yet have this session's other edits either.
- **R1** (`store/profile-reducer.ts`): `highestVersionUsed(profile) + 1` → `(profile.approval?.version ?? 0) + 1` in `approve`. Kills `profile-reducer: R1 ... > re-confirming a claim withdraws v1; approving again produces v2, never v1 again` (got v1, wanted v2).
- **R2** (same file): the disputed-branch's `withdrawApproval` call gated behind `if (false)`. Kills `profile-reducer: R2 ... > disputing an approved, confirmed claim withdraws approval`.
- **R4** (same file, "excluding never withdraws"): removed the `&& action.decision !== "excluded"` guard on the confirm/exclude branch's withdraw condition. Kills `profile-reducer: 4 - A closed tab is not an application > excluding a claim never withdraws approval, unlike confirming or disputing a claim change`.
- **R3** (`server/routes/onboarding.ts`): `interpretExtractionTurn` forced to unconditionally `return { ok: true }`. Kills all 3 dedicated R3 tests in `onboarding-routes.test.ts`, plus (bonus, unplanned) one R7 test — "does not record the content hash on a failed turn" — showing the two concerns are actually wired together, not independently mocked.
- **R7** (`store/profile.ts`): `isSourceContentUnchanged` forced to `return false`. Kills `R7 ... > skips the eve session entirely on a second call against unchanged content, and calls it again once the content changes` (expected `"unchanged"`, got `"completed"`).
- **D2** (`test/route-modules.test.ts`): the test's own independent `readdir`-filter mirror mutated to also exclude `"onboarding.ts"`. Kills the directory-driven comparison with a real diff (`+ "onboarding"`), proving the two sides are genuinely independent rather than tautologically equal.
- **R5, R6**: mutation-proven in the prior session (fabricated-quote rejection; freeform-answer confirms) — re-ran the eval suite multiple times this session (always 42/42 gates on `onboarding-extraction`) to confirm no regression, not re-mutated.

Every mutation was restored and re-verified green before moving to the next; the full runner suite (279/279) and eval suite (5/5, 62 gates) were re-run clean after all mutation testing finished.

**Screenshots.** Real, working, in-browser screenshots via a throwaway seed+serve harness (same technique the original report used: `createBridgeApp`/`createRunnerContext`/`loadRouteModules(ROUTES_DIR)` directly, `eve`/model left minimal, sign-in through the real `/ui/login?nonce=` flow, never `cli/{setup,doctor,runner}.ts` — no real `$HOME`, OS keychain, or model provider touched). The harness (`/tmp/wc-seed-serve.ts`, `/tmp/wc-issue-login.ts`) drove the real reducer through `ProfileStore` to reach a rich, realistic state — sources accounted with reasons kept, four extracted claims (confirmed/question-open/confirmed/excluded), a preference and boundaries recorded, approved once, then a claim edit proposed as a pending revision and a second claim re-disputed (withdrawing approval and re-opening a question) — and a second, separately-approved workspace for the "Approved" state. Playwright MCP's screenshot writer stopped persisting files after its first successful capture in this session (reproduced across viewport, color scheme, format, and a fresh tab — a tool-side issue, not a page one, confirmed via `browser_evaluate` showing the page stayed live throughout); switched to the Chrome DevTools MCP tool for the rest, which worked for every subsequent capture. Replaced `docs/screenshots/P03-{onboarding,profile}-{light,dark}.png` and `P03-onboarding-390.png` (pre-revision UI) with:
- `P03-onboarding-light-1280.png` / `-dark-1280.png` / `-light-390.png` / `-dark-390.png` — the question-open/withdrawn/pending-revision state: confirms C3's four-line readiness, C5's badge fix, C6 ("question open", human labels, reason-decoded revisions), C7 (no 390px overflow), C9 (grouped, labelled controls), C10 (evidence lines), and D3 (reason field, statements section) together.
- `P03-onboarding-approved-light-1280.png` plus a live, scripted interaction (typed into and clicked "Add" on the Presentation note field, screenshotted the result showing "1 recorded: …") — confirms C1/C2/C4/D3 end to end against the real server, and the accessibility snapshot for this state showed the Approve button correctly `disabled` with its readiness lines as `aria-describedby` text, and claims as real `listitem`s (the semantic-list polish item).
- `P03-profile-light-1280.png` / `-dark-1280.png` / `-light-390.png` / `-dark-390.png` — the pending-revision state: confirms the Save-button/textarea DOM order fix, the realistic 36-char id example in the help text, the clean revision diff (C6), and `career-profile.md`'s rendered "**Evidence:**" lines (C10) all together.

**Polish items fixed this pass** (beyond the C/D items above): the reason field no longer renders under an already-Provided source (dead UI — it could never be sent); `profile.js`'s "Saved. N claim(s)" message no longer implies a direct save when the profile was already approved (checks `approval` before the request, states plainly that approved-fact changes were proposed as revisions instead); empty result `<p>` elements removed in favour of routing every outcome through `announce()`; claims render as a semantic `<ul>/<li>` list; `career-profile.md`'s help text no longer shows a misleadingly short `` `[abcd1234]` `` id example. Verified/left unchanged: the answer textarea's `aria-label` was already adequate (re-confirmed, not modified).

**Verification chain, real output.**
- `runner/`: `npx tsc --noEmit -p .` clean. `npx eslint . --max-warnings 0 ...` clean. `npx vitest run`: 21 files, 279 tests, all passed. `node --import ./lib/register-ts.mjs cli/eval.ts`: 5 evals, 62 gates, all passed (`onboarding-extraction` 42/42, including the R5/R6 scenarios).
- Root chain: `pnpm install --frozen-lockfile` (up to date) → `pnpm typecheck` (6/6 packages clean) → `pnpm test`. A first `pnpm -r test` run showed one unrelated timeout each time (`apps/catalog`'s `learn-route.test.ts` once, `packages/job-assistant`'s `workflow.test.ts` ajv schema test and `extension`'s `zod-jitless.test.ts` on a re-run) — different files failing on different runs, none of them touched by this packet, each passing individually in isolation. Re-ran serialized (`pnpm -r --workspace-concurrency=1 test`, avoiding the cross-package CPU contention `pnpm -r`'s default full concurrency causes on this machine) and every workspace was clean: contracts 235, `apps/catalog` 168, extension 130 + 2 skipped, job-assistant 151, runner 279 + eve's 62 gates, root `scripts/*.test.mjs` 2 — all passed, nothing weakened or skipped to get there.
- `pnpm -r lint`: 6/6 clean. `pnpm check:fixtures`: 0 offenses. `git status --porcelain` after the full chain: only this revision's intended files, no stray build output.

**Assumptions, documented as such rather than treated as blocking ambiguity.**
- A newly-added boundary/preference/presentation statement (`addStatement`) withdraws approval if the profile was already approved, the same way `withdrawApproval` already treats any other claim/statement change — it has no pending/confirm gate of its own the way a freshly-extracted candidate claim does, so it is immediately "in force" and cannot sit silently alongside an approval that never considered it.
- `Claim.evidence` rendered as "Evidence: …" shows the quote verbatim for `passage` evidence and is prefixed "your own statement" for `statement` evidence, matching the walkthrough's convention without inventing a new field.
- The reason field for Unavailable/Not applicable stays visible (not just revealed after clicking) so an already-recorded reason is never hidden, and is pre-filled from the current entry.

**Final file list touched this revision** *(corrected in revision 2, R11: not all of these were within D1. The UI assets, `packages/job-assistant/skills/follow-up-questions/SKILL.md`, the screenshots and two P02 eval files were outside it; revision 2's report lists every file outside Owns and the approval that covers it)*: `runner/store/profile-reducer.ts`, `runner/store/profile.ts`, `runner/store/profile-types.ts`, `runner/store/profile-markdown.ts`, `runner/store/profile-questions.ts`, `runner/server/routes/onboarding.ts`, `runner/agent/lib/extract-claims-logic.ts` (new), `runner/agent/lib/ask-follow-up-logic.ts` (new), `runner/agent/lib/extract-claims-schema.ts`, `runner/agent/lib/ask-follow-up-schema.ts`, `runner/agent/tools/extract_claims.ts`, `runner/agent/tools/ask_follow_up.ts`, `runner/eval-agent/agent/tools/extract_claims.ts`, `runner/eval-agent/agent/tools/ask_follow_up.ts`, `runner/eval-agent/agent/lib/fixtures/onboarding.ts`, `runner/eval-agent/evals/onboarding-extraction.eval.ts`, `runner/ui/onboarding.html`, `runner/ui/profile.html`, `runner/ui/assets/onboarding.css`, `runner/ui/assets/onboarding.js`, `runner/ui/assets/profile.css`, `runner/ui/assets/profile.js`, `runner/test/*` (new: `onboarding-routes.test.ts`, `profile-questions.test.ts`, `extract-claims-logic.test.ts`, `ask-follow-up-logic.test.ts`; modified: `profile-reducer.test.ts`, `profile-store.test.ts`, `route-modules.test.ts`), `docs/screenshots/P03-*.png`.
