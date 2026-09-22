# P03 (#11): round-2 review of head 9584e93 (iter 005)

Revision 1 was the implementer's one revision round. A REVISE in round 2 therefore goes to a fresh **Opus escalation implementer**, with this file as its combined list. The reviewer's section is added when its verdict lands.

## UI critic (Opus): REVISE — 9 issues

Its scratch is `/tmp/wc-ui5-p03-scratch/`:
- `harness.ts` (port 4340), the seed, login and stage scripts;
- `log.json`, with a focus trail and live-region text for every step;
- `shots/`: state sets `a1`–`f3`, one per theme and width, plus `zoom-*` and `viewport-*` shots.

The clone is `/tmp/wc-ui5-p03`, at 9584e93.

**Overall:** revision 1 brought the pages much closer to the walkthrough.
- Readiness has the four ●/○ lines.
- Only Unaccounted sources are amber, and "question open" replaces "disputed".
- Evidence is shown.
- Source controls are grouped and labelled.
- At 390 nothing scrolls sideways, and the error text passes contrast.
- Approve is busy-guarded and inert once approved.

The walkthrough's central promise is still unmet. In the walkthrough, one sticky "Last action" line stays in view. Here that line is usually off-screen, carries UUIDs and raw keys, and is announced two or three times. Focus drops to `<body>` after claim and revision actions, and re-renders discard typed text.

1. **Focus is still lost after most actions (C1).**
   - Focus drops to `<body>` after every claim Confirm, Exclude, Yes or No (11 of 11 presses), after revision Accept and Reject, and after the "Add / edit source text" toggle.
   - Cause: `captureFocus` matches `[id^='claim-']`/`[id^='revision-']`, but the pressed button's own id (`claim-confirm-…`, `revision-accept-…`) also matches. So the card fallback is never recorded. The toggle has no id.
   - A successful Save & extract moves focus to the row container rather than the button.
   - Fix: look for the container from the button's parent, or give containers their own id prefix. Then focus the claim card or the next claim's first action, and the next revision or the revisions heading. Give the toggle a stable id and restore focus to it.
   - Evidence: `log.json` `C:steps`, `E:steps` (E2, E4, E6), `F:same-session` (F3a), `B:steps` (B7).
2. **Announcements carry full UUIDs and raw keys (C6).**
   - Examples: "355b9193-… confirmed.", "previousCoverLetters marked provided.", "previousCoverLetters's source content is unchanged…".
   - Pressing Yes with no text records "your own statement — "Confirmed by the person, without further detail."".
   - Cause: reducer messages (`profile-reducer.ts` lines 262–263, 297, 309, 315, 328, 350 and 365) and route messages (`onboarding.ts` lines 232, 237 and 248) pass through to the page.
   - Fix: use source labels and the claim text (or a short id). Replace the placeholder with something like "You confirmed it without adding detail."
3. **One outcome is announced two or three times, and feedback is usually off-screen (C2).**
   - Every outcome goes to `#live-region` (polite) and to `#last-action` (`role=status`). Errors also go to `#page-error` (`role=alert`).
   - The visible `#last-action` line sits at the top of a long page, so it is off-screen:
     - at 390: the empty Save & extract, the .pdf refusal and the empty preference Add;
     - at 1280: Save & extract, claim decisions and preferences.
4. **Readiness is wrong in three cases (C3).**
   - With zero claims it shows "● Every claim decided"; it should be ○.
   - ●/○ are hidden from assistive tech and unmet lines use the same words as met ones, so a screen reader hears "…Every claim decided Profile approved Not ready…" on an empty profile. The Approve description has the same ambiguity.
   - After approval is withdrawn, `#approve-result` still says "Career profile v3 approved. Generation is now unlocked." under "○ Not ready: generation locked".
5. **The "excluded" badge fails contrast (new in revision 1).**
   - Light: white on #e54b4f is 3.85:1. Dark: white on #ff5b5b is 3.04:1.
   - axe reports `color-contrast` (serious) in every state with an excluded claim.
   - Fix: a darker fill (#b91c1c with white is about 6.5:1), or an outlined badge with red text at 4.5:1 or better, scoped in the page CSS like the C8 fix.
6. **Typed, uploaded and saved source text disappears.**
   - Any re-render rebuilds every text box empty: after a status press (B6c), the toggle (B7b), or a successful Save & extract (B13b).
   - A typed answer is wiped when another claim is decided (C3b).
   - The "show saved source text" fix doesn't work. On a fresh visit the box is empty although the API returns the text (B14). When the text does load, it includes an internal "## pasted.txt" header that would be saved back.
   - Fix: keep drafts in page state keyed by category or claim, or re-render only the changed row. Fetch the saved text when a panel opens, without the header.
7. **The reason for Unavailable / Not applicable isn't reliably kept (D3).**
   - It is saved only if typed before pressing the status. Typed after, which is the natural order, it is silently dropped (B9b).
   - The only visible label is a placeholder, and the field sits after the buttons it must be filled before.
   - At 390 both the placeholder and a saved reason are cut off.
   - Fix: save the reason on its own, or reveal a labelled field after the choice. Show the recorded reason as wrapping text.
8. **The withdrawn state isn't explained, and Profile offers an Accept that can only fail.**
   - After a dispute withdraws approval, neither page says so; Profile says "Not yet approved".
   - Profile still offers Accept on the pending revision, which returns "…nothing to accept a revision against." The committed `P03-profile-*.png` shots show exactly this state.
   - Fix: explain the withdrawal (which version, which claim, "review and approve again"). Hide or explain Accept while unapproved, or reject pending revisions when approval is withdrawn.
9. **Screenshots: 9 of the 48 requested exist.**
   - Missing for Onboarding: empty, in-progress and ready (×4 each), and approved in dark 1280, light 390 and dark 390.
   - Missing for Profile: empty, in-progress, question-open, ready and approved (×4 each).
   - The critic's `a1`–`f3` set is a template.

**Polish** (not counted):
- The eve error still has literal backticks.
- Row buttons don't line up: the first button sits anywhere from x=480 to x=642 at 1280.
- The answer box's only label is its placeholder; the implementer declined this item.
- Save messages mislead:
  - a no-change save while approved says revisions were "proposed above";
  - "Saved. 7 claim(s)" counts excluded claims;
  - "(s)" wording;
  - the Save result line stays visible after Accept or Reject;
  - rejecting a boundary says "The claim keeps its current text."
- Result lines take focus with Chrome's blue ring instead of the theme's `--ring`, and the approval message appears twice.
- At 390 the file input pokes 8 px past the Sources card.
- Enter does nothing in the preference, boundary and presentation fields.
- Revision Accept and Reject lack context in their accessible names.
- Uploads are always saved as `pasted.txt`.
- Onboarding gives no hint that a revision is pending.
- `career-profile.md` shows a raw ISO timestamp.

**Verified:**

| Item | What was checked |
|---|---|
| C4 | Busy and inert behaviour |
| C5 | Amber placement |
| C7 | Layout at 390 |
| C8 | Error contrast: 6.31:1 light, 7.59:1 dark |
| C9 | Source controls |
| C10 | Evidence |
| D3 | Preferences |
| Polish | The markers, Save after the text box, no empty `<p>`, claims as a list, Approve linked to its reasons |
| axe | Clean apart from issue 5 |
| 390 | Page width is 390 in every state |

**Partial:** C1, C2, C3, D3 upload, D3 reason. **Not fixed:** C6.

## Reviewer (Opus): REVISE — 6 issues

Scratch: `/tmp/p03-r2-review/`:
- chain logs `head-*` and `merge-*`;
- the merge clone in `merge-clone/`;
- `mutations.log` and the pristine copies in `backup/`;
- probes in `zz-reviewer-probe.test.ts` and `probe-evidence.txt`.

**What holds:**
- **Chain at 9584e93: green.**
  - contracts 235, job-assistant 151, extension 130 + 2 skipped, runner vitest 279/279, catalog 168, scripts 2;
  - eve eval 5/5, 62 gates;
  - lint and fixtures clean.
- **The merge onto a9abb70:** no conflicts, with identical counts.
- **Mutations:** 38 of 49 were killed, including R1 ×3, R2 ×3, R3 ×5, all R4, R5's `if (true)`, R6, R7 ×2, R8 ×2 and D2 ×2.
- **Ports:** no test binds a port.
- **Scope:** inside Owns and D1, apart from files the report must list:
  - `runner/ui/assets/{onboarding,profile}.{css,js}`;
  - `packages/job-assistant/skills/follow-up-questions/SKILL.md`;
  - the screenshots;
  - two P02 eval files.

**Issues:**
- **V1. R10 is partial and untested.**
  - Only `GET /`, `GET /markdown` and `POST /markdown` reconcile (`onboarding.ts:143-191`). Every other write goes through `ProfileStore.#mutate` (`profile.ts:141-146`) and re-renders over the person's file: decide, answer, approve, statements, revisions and the eve tool steps.
  - Probe B: a hand-edited boundary followed by `POST /statements/preference` loses the edit.
  - Probe B2: deleting a marker drops the edit silently, with `markdownError: null`. The catch at `profile.ts:318-324` can never fire, and neither page reads `markdownError`.
  - Both R10 mutations survive the suite.
- **V2. The "show saved source text" feature corrupts the source and defeats R7.**
  - `GET /sources/:category/content` returns the prompt rendering with `## <file>` headers (`onboarding.ts:209-213`, `profile.ts:157-167`).
  - The page posts that back as `pasted.txt` (`onboarding.js:242-249, 284`).
  - Probe A: one unchanged save doubles the header and starts a second eve session.
- **V3. `ask_follow_up` guesses.**
  - `hasEvidenceFromAnswer` confirms on any non-blank free text (`agent/lib/ask-follow-up-logic.ts:17-23`).
  - eve@0.63.0 maps an unmatched follow-up message to `{text}` (`dist/src/channel/resolve-text.js`; docs `concepts/sessions-runs-and-streaming.md:213`).
  - Probe C: "No, I can't back that number up.", "exclude" and "what do you mean?" all confirm the metric.
  - The eval enshrines this (`onboarding-extraction.eval.ts:177-198`).
- **V4. The profile store loses writes.**
  - `#mutate` reads, reduces and writes unserialised, with a new `ProfileStore` per request (`onboarding.ts:141`), and the eve tool steps write the same file from another process.
  - Probe D: of 7 concurrent `POST /sources/*` requests, only 1 of 7 was recorded; two concurrent decisions lost one.
- **V5. R5 is not done for `ask_follow_up`.**
  - The eval-agent copy is byte-identical to the production tool (54 lines), and its header says "not a copy".
  - Production mutations ("always confirm", "no open-claim check") survive.
- **V6. The report is still not corrected.**
  - **D3:** the deferral to P03.1 isn't under "What was skipped".
  - **D6:** the old eve lesson remains at packet line 56 and in comments at `agent/tools/extract_claims.ts:29-37`, its eval-agent copy, and `agent/lib/onboarding-store.ts:10-16`.
  - **R11:** the Owns claim is wrong.
  - **R4:** the proofs show one mutation.

**Nits:**
- **VN1.** D7 is marked "Not carried forward", but e698182 did it.
- **VN2.** The PAUSE message is called an injection; it was genuine.
- **VN3.** Mutations that survive untested: `resolveReal` in `saveSourceContent` (`profile.ts:178`), the 2 MiB total cap (`onboarding.ts:236`), the superseded evidence ref (`profile-reducer.ts:342`), `_None yet._`, and the R3 timeout (nothing asserts `lastSignal`).
- **VN4.** The path-confinement test is weak (`onboarding-routes.test.ts:200-220`).
- **VN5.** "refuses a non-TXT/MD upload" asserts a 200 (lines 222-237).
- **VN6.** A turn that never called `extract_claims` still records the content hash (`onboarding.ts:277`).
- **VN7.** Probe G: an edit that adds a metric to a confirmed claim keeps it confirmed with its old evidence.
- **VN8.** Multi-line evidence quotes and questions render unindented in `career-profile.md`.
- **VN9.** Withdrawals are stored as `accepted` revisions, a workaround for the closed status list in contracts.
- **VN10.** Pending revisions survive a withdrawal and re-approval; the walkthrough clears them.
- **VN11.** Unsafe upload names pile up as `upload-<ms>.txt`.

## Orchestrator decisions for the escalation (D8–D16)

- **D8. Profile writes.** Every profile mutation, in the bridge and in the eve process, goes through one shared, directive-free store helper. The helper:
  - serialises in-process with a per-workspace promise chain (compare `CommandQueue.#exclusive`, `runner/store/commands.ts:53-70`);
  - holds a cross-process lock file, `.runner/profile.lock`:
    - created with an `O_EXCL` open;
    - held only for read-reconcile-reduce-write;
    - waited on for at most about 5 s, after which the request is refused with "The profile is busy. Try again in a moment." (HTTP 503);
    - broken, with a log line, if it is older than 30 s;
  - reconciles `career-profile.md` before reducing (D9).
  If P02 already has such a primitive, reuse it.
- **D9. Hand edits (R10).** Reconcile before every mutation, on any route or tool step.
  - When edits can't be parsed, or a marker is missing or damaged:
    - every profile write is refused, and nothing is written or re-rendered;
    - both pages show the error, with an explicit "Discard my edits to career-profile.md" action that re-renders from the JSON.
  - Never drop an edit silently.
  - After approval, parsed hand edits become proposed revisions, as specified in R10.
- **D10. `ask_follow_up` (F4, hard-problems #2).** Only an explicit option changes a claim.
  - A free-text-only answer (`{text}`) leaves the claim disputed with the question open.
  - It records the text as the person's note on the question, shown on the page.
  - The tool result tells the model that the claim stays open.
  - The eval proves it with the three probe answers.
- **D11. Withdrawal and pending revisions.** When approval is withdrawn, its pending revisions are applied to the draft, recorded as `accepted` with the withdrawal as the reason, rather than dropped.
  - This reaches the walkthrough's end state (no pending revision after a withdrawal; `docs/spec/visuals/index.html:246`) without losing the person's edit. Nothing is in force while the profile is unapproved, so there is nothing for an explicit accept to protect.
  - Both pages explain the withdrawal: which version, which claim changed, which revision was applied, and "answer the open question, then approve again".
  - Accept and Reject are never offered while the profile is unapproved.
- **D12. Feedback (U3, C2).** There is one live region: the "Last action" line, `role="status"`, polite.
  - It stays in view at every width. It is compact at 390, and `scroll-padding-top` keeps it from hiding a focused control.
  - `#page-error` (`role="alert"`) is only for page-load failures.
  - Field errors (empty paste, refused file, empty preference, missing reason) also sit next to their control, with `aria-invalid` and `aria-describedby`.
  - Each outcome is announced exactly once.
- **D13. Source text (V2, U6, VN5, VN11).**
  - The textarea edits one paste file per category, `sources/<category>/pasted.txt`. GET content returns its raw text, with no `##` headers.
  - Uploads keep a stable, sanitised name derived from the original, so the same name replaces the earlier upload.
  - The route refuses a name that isn't `.txt` or `.md` with 415.
  - Uploads are listed by name in their row.
  - Unchanged text returns "unchanged" with no eve session (R7).
  - Drafts survive re-renders: typed text, answers and reasons.
- **D14. The content hash (VN6)** is recorded only after an `extract_claims` call in that turn has persisted.
- **D15. Always-ask on edit (VN7).** An edit that adds an always-ask item re-opens a question on that claim. While approved it is a proposed revision, and accepting it re-opens the question, which withdraws approval (D11).
- **D16. Screenshots.** All 48:
  - both pages, in each of empty, in progress, question open, ready, approved and withdrawn;
  - at 390 and 1280, light and dark;
  - full page, at true width, where 1x DPR is fine;
  - named `P03-<page>-<state>-<theme>-<width>.png`;
  - replacing the old nine with explicit `git rm <file>`.
- **VN9** is accepted as is, because contracts are closed to P03. It is logged as a contracts follow-up.
