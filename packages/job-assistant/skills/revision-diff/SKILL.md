---
name: revision-diff
description: Explain what changed and why between two versions of a prepared document, citing the claim label behind every sentence, so the person can see exactly what moved before they trust it again. The runner writes diff-v<n>.md from the citations; this skill states the contract it follows.
---

# Revision diff

Implements mvp-spec §3 F7 ("'what changed and why' diff") and F5 ("editing the markdown round-trips into the JSON... after approval, edits become revisions with an explicit accept"). Ownership (hard-problems.md #1) doesn't stop at the first approval — every later change needs the same legible, cited trail.

## Inputs

- The version being prepared: its sentences, each with the labels of the confirmed claims it cites, and those claims' text as it read when it was prepared.
- The version it replaces, when there is one, as the runner kept it (`applications/<taskId>/versions/v<n>.json`).

## Outputs

- `diff-v<n>.md` per mvp-spec §5's workspace layout, which the runner writes itself, deterministically, from the citations (runner/export/diff.ts), so a diff can never misreport a change:
  - which profile version and job revision it was prepared from, and which version it replaces;
  - since that version, one line per sentence: added (with the claims it cites), reworded (same claims, new words), removed (named by the labels it cited, and which of those are no longer confirmed claims), and a count of the unchanged ones;
  - every sentence beside the claim it cites (label, kind, text) and its presentation change in plain words: the same words as the claim, shortened from it, reworded from it, or combining several ("leaves out “the”; adds “at”").
- The Applications page shows the same per-sentence view.

## Boundaries

- Report changes at the level of a person's own sentences and claims, not a line-by-line text diff — "Added, Resume, Experience: “…” (cites C3)" rather than raw diff hunks.
- A change with no claim behind it (a pure wording/style edit that asserts nothing new) is reported as such explicitly — "reworded (same claims)" — rather than omitted or mislabeled as citing a claim it doesn't.
- If a change removes a previously-cited claim from the document (the person disputed or excluded it since the prior version), say that plainly — "the sentence that cited C6, and C6 is no longer a confirmed claim" — this is exactly the case F5's "approval withdrawn when a claim changes" exists to surface.
- A removed sentence is named by its labels only, never quoted: if its claim was excluded since, quoting it would carry excluded content into a new document.
- Fixtures that prove this contract: `runner/test/export.test.ts` (the diff document) and `runner/test/applications-routes.test.ts` ("an exclusion keeps the profile's version but still prepares anew").

## Never

- Never describe a change without being able to point to the claim label (or an explicit "same claims, reworded" note) behind it.
- Never silently omit a change from the diff because it seems minor — the person is the one who decides what's minor, not this skill.
- Never use the diff to introduce new content that wasn't already in the "current" version being diffed — this skill explains a change, it does not make one.
- Never quote a removed sentence's words: name it by the labels it cited.
- Never treat the previous version's content as something to preserve at all costs; if the current version correctly dropped an excluded claim's content, the diff should say so approvingly, not flag it as a regression.
