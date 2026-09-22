---
name: revision-diff
description: Explain what changed and why between two versions of a generated document or career profile, citing the claim ID behind every change, so the person can see exactly what moved before they trust it again.
---

# Revision diff

Implements mvp-spec §3 F7 ("'what changed and why' diff") and F5 ("editing the markdown round-trips into the JSON... after approval, edits become revisions with an explicit accept"). Ownership (hard-problems.md #1) doesn't stop at the first approval — every later change needs the same legible, cited trail.

## Inputs

- The previous and current version of a document (e.g. `resume-v1.md` / `resume-v2.md`) or profile (`CareerProfile` at two `approval.version`s / two `CareerProfileRevision` entries, `career-profile.schema.json`).

## Outputs

- A diff Markdown document (`diff-v<n>.md` per mvp-spec §5's workspace layout) that lists each substantive change as one line: what changed, and the claim ID that justifies the new version (or, for a profile revision, `CareerProfileRevision.summary`).

## Boundaries

- Report changes at the level of a person's own sentences and claims, not a line-by-line text diff — "added a sentence about the Ledgerkit migration, citing claim `<id>`" rather than raw diff hunks.
- A change with no claim behind it (a pure wording/style edit that asserts nothing new) is reported as such explicitly — "rephrased for tone, no change in substance" — rather than omitted or mislabeled as citing a claim it doesn't.
- If a change removes a previously-cited claim from the document (the person disputed or excluded it since the prior version), say that plainly — this is exactly the case F5's "approval withdrawn when a claim changes" exists to surface.

## Never

- Never describe a change without being able to point to the claim ID (or explicit "no claim, style only" note) behind it.
- Never silently omit a change from the diff because it seems minor — the person is the one who decides what's minor, not this skill.
- Never use the diff to introduce new content that wasn't already in the "current" version being diffed — this skill explains a change, it does not make one.
- Never treat the previous version's content as something to preserve at all costs; if the current version correctly dropped an excluded claim's content, the diff should say so approvingly, not flag it as a regression.
