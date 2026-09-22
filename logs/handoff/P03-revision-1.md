# P03 (#11): revision 1 instructions (sent 2026-09-22, iter 004)

This is the exact message the orchestrator sent to the P03 implementer after round-1 review (reviewer REVISE 11, UI critic REVISE 10). **Outcome:** revision 1 completed at 9584e93 (pushed 2026-09-22 ~13:20). The implementer did not stop at the pause. The packet report's "Revision 1" section maps every item. Next is round 2, using this file as the reviewers' checklist.

---

P03 (#11) revision 1: the reviewer (REVISE — 11 issues) and the UI critic (REVISE — 10 issues) both reviewed head 3774f75. This is your one revision round. This message is genuinely from the orchestrator.

SETUP
- Work in your worktree on packet/P03.
- First run `git fetch origin && git merge origin/overnight/integration`. That is a normal merge: no rebase, no amend, no force-push. P02.1 (#9) and P09.1 (#10) landed; the reviewer merged your head onto f06688b with no conflicts.
- Your bridge harness uses port 4320 only. 3000/3001 belong to the owner.
- Standing rules:
  - Write only in your worktree or /tmp, and leave scratch folders in place.
  - No recursive delete through node, find or python.
  - Never test a guardrail, and never reroute after a refusal: stop and report.
  - Stage by explicit path, commit at green steps, plain `git push origin packet/P03`.
  - Fictional data only: Ada Quill; Northwind Labs, Fernwood, Harbor, Quill, Ledgerkit.

ORCHESTRATOR DECISIONS (scope)
D1 Owns. These are approved; list them in your report:
  - `runner/store/profile-{types,reducer,questions,markdown}.ts`, as the split of the owned `runner/store/profile.ts`;
  - `runner/agent/lib/` helpers, including the new directive-free helper in R5;
  - the eval-agent files: re-exports, fixture and tool registries, evals;
  - new `runner/test/*` files for P03 code;
  - `runner/test/route-modules.test.ts`, for D2 only.
  Anything else outside Owns: stop and ask.
D2 route-modules.test.ts: adopt the reviewer's design so that P04, P06, P08 and P10 never edit it:
  - Build the expected names from `readdir(ROUTES_DIR)` using the loader's own filter (still exact).
  - Use `arrayContaining` for P02's four modules.
  - Replace `.size).toBe(0)` with a check that the registry's keys equal the union of each module's declared `events`.
  - Show a mutation that it catches.
D3 Sources. This round adds:
  - File upload for TXT and MD only: read in the page, sent as text through the existing route, with the same caps and file-name confinement. Refuse other types with a plain message.
  - A reason field for Unavailable and Not applicable. The API accepts one; the UI must collect it and show it.
  - Recordable Preferences: the critic found preferences can never be recorded.
  PDF/DOCX extraction, URL import and the GitHub token move to a new packet, P03.1. URL import shares a safe-fetch with P04, and spec §4 puts the token in the OS keychain. Don't build them. State the deferral under "What was skipped".
D4 HITL: deferring eve HITL in the route is accepted for F4, because the question persists and the claim stays disputed. R3 and R6 still apply.
D5 Multi-line text (R8): fix it in the markdown format, not in packages/contracts, which you must not touch.
  - Multi-line claim and statement text must round-trip, e.g. as indented continuation lines.
  - The property test generates its inputs from a seeded generator inside the test file. No new dependencies.
D6 eve lesson: the orchestrator records the facts in eve-runtime.md. Correct your report to match:
  - Directives are compiled and registered only for modules inside the app root being built.
  - Within one root, imports work, including an imported "use workflow" executor and step modules.
  - Across roots, a re-exported workflow tool fails discovery ("requires a compiled workflow executor") and an imported step fails at run time ("Step … is not registered").
D7 Replace "Acme" in `runner/test/profile-reducer.test.ts` with a policy name.

REVIEWER ISSUES
R1 Approval versions are reused, and accepting a revision re-approves without approve().
  - Approve v1, re-confirm a claim, approve: you get v1 again.
  - Approve v1, edit claim A, confirm claim B (which withdraws), accept A's revision: you get `{version:1}` and ready=true with no approve call.
  - P05 keys idempotency on job revision + profile version, so versions must never repeat.
  - Fix: next version = 1 + the highest version ever used (the current approval, every `revisions[].resultingVersion`, and withdrawals, recorded in `revisions[]`). While approval is null, reject pending revisions on withdrawal or refuse `acceptRevision`. Add tests.
R2 Approved content changes without withdrawal or a new version.
  - Disputing an approved claim keeps v1.
  - Answering it with evidence replaces the evidence and stays v1 and ready.
  - A boundary edited through POST /markdown after approval applies directly. F5 says edits after approval become revisions with an explicit accept; your own scenario 4 title says disputing withdraws approval.
  - Fix: withdraw approval in the disputed branch (the walkthrough withdraws on any change that isn't an exclusion), and turn statement edits after approval into proposed revisions.
R3 The extraction route reports success for failed or parked turns.
  - With a fake eve gateway, `{status:"waiting", events:[turn.failed]}` returns `200 {"ok":true}`, and so does a turn parked on an input request. A normal turn also ends "waiting", so `status !== "failed"` can't tell them apart.
  - A hostile source that gets the model to call `open_application_group` parks on an approval the UI can't show, and is reported as success.
  - Fix:
    - Treat failure events or a non-empty `inputRequests` as not ok.
    - Add `AbortSignal.timeout` like `checkModel`.
    - Cancel or close parked sessions if eve@0.63.0 supports it (read `runner/node_modules/eve/docs`). If it doesn't, say so in the report.
R4 Key behaviours have no failing test. All runner tests stayed green under each of these mutations:
  - no withdrawal on confirm;
  - an answer keeping passage evidence instead of `{kind:"statement"}`;
  - changed readiness texts;
  - titles and dates no longer always asking;
  - "maintainer" dropped from the always-ask words;
  - no file-name sanitising (`../../career-profile.json` would land over the profile);
  - the data framing removed from `buildExtractionPrompt`;
  - the body caps ignored.
  Fix:
  - Add `runner/test/onboarding-routes.test.ts` covering the guard (no cookie 401, cross-site/foreign Origin 403, text/plain 415), caps (413), unknown category 404, extra field 400, path confinement, and the exact reason text for all five unready states. Today only 2 are asserted.
  - Add reducer assertions for withdrawal and statement evidence.
  - Add a test that parses `follow-up-questions/SKILL.md` against `ALWAYS_ASK_KINDS`/`ALWAYS_ASK_WORDS`.
  - Add a `buildExtractionPrompt` test.
  - Show each listed mutation now fails.
R5 The eval runs copies of the tools, and the quote check is untested.
  - The eval-agent's `extract_claims` and `ask_follow_up` are code copies, although their comments say "not a copy". With the copy's quote check replaced by `if (true)` the eval still passes 21/21.
  - Fix (the reviewer verified this works): move verify-then-persist into a directive-free helper in `runner/agent/lib`, keep a thin `"use step"` wrapper per root, unit-test the helper, and add a non-verbatim quote to the eval. Correct the comments.
R6 `ask_follow_up` is untested, although the report says it is, and it guesses on a freeform answer.
  - No eval sends the `askFollowUp` prompt. With `allowFreeform: true`, a text-only answer maps to "no evidence" and the claim is excluded.
  - Fix: add the eval. It parks with one input request; answering "confirmed" confirms with statement evidence; a freeform-only answer never excludes the claim.
R7 Extraction isn't idempotent per source content hash, which is a packet deliverable.
  - Hash the source text before the session starts, skip if unchanged, and store the hash under `.runner/`.
  - Test with a counting fake.
R8 The markdown round trip loses multi-line text. Saving unchanged markdown turns "Ran the migration\n- Owned the rollback plan" into "Owned the rollback plan". Fix per D5, with a generated property test.
R9 URL, GitHub-token and upload sources are missing and unreported. Handled per D3.
R10 `career-profile.md` is never written to the workspace. §5, hard-problems #1 and §7.6 all describe it as a file the person can open.
  - Write it atomically (temp file + rename) on every profile write.
  - Edits made directly to the file must round-trip: before serving the Profile page or applying a profile write, if the file differs from the render of the JSON, parse it and apply it through the same path as POST /markdown. After approval that means proposed revisions.
  - A parse error changes nothing and shows the error.
R11 Report accuracy: list the out-of-Owns files, drop "eval-tested" for ask_follow_up unless R6 makes it true, and fix the eve lesson (D6).
Nits:
  - "1 claim still need" → "needs".
  - Readiness reasons show raw keys like `targetRolesAndPreferences`.
  - `saveSourceContent` uses `resolve`, not `resolveReal`: a symlinked `sources/resume` writes outside the workspace while reads refuse it. Fix this one.
  - Empty states read `_None yet_`, but the template says `_None yet._`.
  - Schema headers name `*-workflow.ts` files that don't exist.
  - Superseded evidence in `revisions[]` keeps the quote but not the ref.
  - The `--- SOURCE TEXT END ---` delimiter is guessable (make it per-call random).
  - There is no cap on total source text.

UI CRITIC ISSUES (the walkthrough `docs/spec/visuals/index.html` is the behaviour spec)
C1 Focus is lost after every action: `replaceChildren()` rebuilds the lists, and buttons are disabled during requests. Update rows in place or restore focus by id, use aria-disabled for busy, and after Approve move focus to the result.
C2 Outcomes aren't announced:
  - approval;
  - the extraction success message, which `reload()` replaces;
  - the "eve is not running" and "Paste … first" errors.
  The Profile page never uses its live region, and accept/reject messages go into a card that `reload()` removes. Announce every success and error from one region outside the rebuilt area.
C3 Readiness doesn't match the walkthrough.
  - "Ready. Approving unlocks generation." stays after approval, and there is no generation locked/unlocked line.
  - Raw ids and field names appear.
  - Show the walkthrough's four ●/○ lines, with labels and short ids.
C4 The Approved button still works: `finally { button.disabled = false }` re-enables it after reload(), and pressing it re-approves.
C5 Amber is on the wrong states. `onboarding.js:65` makes Unavailable and Not applicable amber and leaves Unaccounted plain. Amber means "needs a decision", which is Unaccounted.
C6 Raw internal values in announcements and cards:
  - full UUIDs;
  - field names like previousCoverLetters;
  - the badge says "disputed" where the walkthrough says "question open";
  - "the person's own statement" should say "your".
C7 At 390px, claim badges squeeze until the word spills out of the pill, and long tokens scroll the page sideways (436px). Use `flex:none` on the badge, and `min-width:0` plus `overflow-wrap:anywhere` on the text.
C8 Light-mode `.error` is #e54b4f on white, 3.85:1 (axe serious), and #page-error has the same problem. Use a theme token that passes 4.5:1.
C9 Source controls lack context.
  - Buttons read "Provided" etc. with no source name.
  - Only the selected one has aria-pressed.
  - The toggle has no aria-expanded.
  - Group each row under its label.
C10 Evidence is never shown. Claim cards and career-profile.md have no evidence lines, and "Yes — I have evidence" statements aren't shown. The walkthrough shows "Evidence: …".
Polish:
  - "Saved. 7 claim(s)" misleads after a revision was proposed.
  - Row buttons don't line up.
  - Saved source text isn't shown.
  - Help text shows `[abcd1234]` markers, but the real ones are 36-character ids.
  - Save comes before the textarea in keyboard order.
  - Each claim card has an empty <p>.
  - Claims aren't a list.
  - The disabled Approve isn't linked to its reasons (aria-describedby).
  - Literal backticks in the eve error.
  - The answer box's only label is its placeholder.
Screenshots:
  - The committed "390" shot is really 500 wide and top-only.
  - Retake at true 390 and 1280, light and dark, full page.
  - Cover Onboarding and Profile in the empty, in-progress, question-open, ready, approved and withdrawn states.

FINISH
- Full chain from the repo root, and `git status --porcelain` empty afterwards:
  - `pnpm install --frozen-lockfile`
  - `pnpm typecheck`
  - `pnpm test`, including runner eval
  - `pnpm -r lint`
  - `pnpm check:fixtures`
- Mutation proofs for R1, R2, R3, R4 (each listed mutation), R5 (`if (true)` now fails), R6, R7 and D2. Restore each from a /tmp backup, and confirm with `git diff`.
- Append a "Revision 1" section under ## Report:
  - per-issue changes (R1–R11, C1–C10, D1–D7);
  - real test output;
  - mutation proofs;
  - what was skipped and why;
  - assumptions.
- Push, then reply with:
  - the new head SHA;
  - a one-line-per-issue map;
  - the chain result.
- If something can't be done without guessing, write Status: blocked with the exact question and stop.
