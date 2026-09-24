# P05 (#16): round-1 review of head 3130763 (iter 007)

The Opus implementer opened #16. The code head is 7171303; the last commit is the report. CI run 35989224619 on 3130763 is green. An earlier run, 35987564075 on 20c9c8f, failed on a race that 7171303 fixes.

## UI critic (Opus): REVISE, 9 issues

Scratch: `/tmp/wc-ui11-p05-scratch/`. It holds `harness.ts`, `lib.mjs`, the `stage-*.mjs` scripts, `out/`, `log.json`, the `ws-*` workspaces and `downloads/`, plus `shots/` (132) and `sheets/`. The clone is `/tmp/wc-ui11-p05`.

**What holds:**
- The house style, and the walkthrough's copy ("Preparation is locked … The workflow will not guess.", "Already prepared … nothing new").
- axe: 0 violations of any impact in 127 audits over 33 states. Minimum contrast is 6.47:1 light and 6.76:1 dark. No sideways scroll at 390.
- The diff reads in words, without colour.
- Focus is never dropped or rebuilt, including through refreshes on five kinds of focused control.
- `aria-disabled` while busy, and a double press sends one request.
- The CI race is fixed in the browser: with the second write held for 4.5 s, the page reads "running", then announces the real outcome once.
- The exports read cleanly in Markdown, DOCX and PDF, with no markers, field names or posting text.
- All 20 committed screenshots are right.

**Issues:**
1. **A corrected name or contact line never reaches the documents.** The page says "Saved: your documents will carry this name.", but Prepare again answers "Already prepared … nothing new", because the key covers only model inputs. Evidence: `downloads/after-contact/resume-v2.md:3`.
2. **The list row and the amber block stay after every question is answered.** The row keeps "Needs your answer · Waiting for your answer to 2 questions.", which is `processing.error` frozen at park time. Build the line from the answers ("1 question left", "Ready to continue", "Waiting for the evidence you're adding"), and drop amber and the heading once no question is open.
3. **Evidence, sources and approval are sent to the Profile page.** They live on Onboarding; Profile itself says to "use the Onboarding page". Link Onboarding, and keep Profile only for the unreadable-file case.
4. **An outcome is never announced after a reload or a revisit mid-preparation.** Only preparations started by the current page load are watched (`started`). When the list loads, watch every running application and announce its outcome once.
5. **While the runner is down, the page says "Preparing now …" indefinitely.** Failed background refreshes are silent. Show and announce "Can't reach the runner. Is it still running?" once, and clear it on the next good refresh. The Jobs page has the same silence.
6. **Every download has the same anonymous name** (`resume-v1.pdf` for every job). Use a descriptive name in the `download` attribute and in `Content-Disposition`, such as "Ada Quill - Resume - Fernwood Platform Lead.pdf". Workspace file names stay as they are.
7. **Version 1 keeps saying "It cites 1 claim you have since excluded … Prepare again" after version 2 exists.** Show that note only on the latest version, and say "Version 2 replaces it." on older ones.
8. **A name outside Latin-1 prints as "??? ?????" in the PDF, with no warning.** Example: "Ада Квилл". The Markdown is right. Evidence: `shots/pdf-cyrillic-resume-v1.png`.
9. **`career-profile.md` is plain text, not `<code>`,** in "Not prepared: your career-profile.md has an edit…" and in the readiness line. Render `readiness.message` through `renderPieces`, and drop the duplicate "See the Profile page".

**Polish:**
1. Applications list in random-UUID order.
2. The job picker defaults to the newest job even when it isn't extracted, and the `not_extracted` refusal names no next step.
3. "Answer all 2 questions" should be "Answer both questions".
4. The paused-budget readiness line reuses refusal wording, and "Settings" and "the Runs page" aren't links.
5. The daily run limit isn't shown under "Before preparing".
6. With two tabs, a stale amber block stays below a focused answer button.
7. After "add your name … first", focus stays on Prepare instead of moving to the name field.
8. The DOCX Author property is "Job assistant runner".
9. At 390, `diff-v1.md` breaks mid-name.
10. Two claims join with ", " rather than "and".
11. Export links repeat their names across versions.

**Noted, not counted:** versions 1 and 2 both say "career profile version 1", because excluding a claim keeps P03's approval version.

## Reviewer (Opus)

Pending.
