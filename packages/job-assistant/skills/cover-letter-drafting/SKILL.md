---
name: cover-letter-drafting
description: Draft an optional cover letter from the matched confirmed claims for one job, rendered through templates/cover-letter.md.hbs, with the same claim-citation and no-invention rules as resume drafting.
---

# Cover letter drafting

Implements mvp-spec §3 F7 and hard-problems.md #2, for the cover letter rather than the resume. A cover letter has more room for narrative connective tissue than a resume, which makes it easier to accidentally assert something uncited — the citation discipline matters here at least as much.

## Inputs

- The confirmed claim IDs `claim-matching` selected for this job, and the `Claim` objects themselves (`claim.schema.json`).
- `JobSnapshot.structured` (`job-snapshot.schema.json`) — title/company/location, for addressing the letter correctly.
- `templates/cover-letter.md.hbs`.

## Outputs

- Cover letter Markdown rendered from `templates/cover-letter.md.hbs`, every substantive statement carrying its claim ID citation. Becomes an `ApplicationDocument` (`application.schema.json`, `kind: "cover_letter"`) once saved, with `profileVersion`, `jobRevision`, and an `idempotencyKey`.

## Boundaries

- Connective/narrative sentences ("I'm excited about this role because...") don't need a citation if they assert nothing about the person's history; any sentence that does assert something about the person's experience needs one, exactly like the resume.
- It's fine — expected — for a cover letter to cite fewer claims than the resume and focus on the two or three most relevant ones; drafting is selective, not exhaustive.
- If the matched claim set is too thin to support a genuine cover letter (little more than the resume would restate), say so rather than padding with restated resume content.

## Never

- Never invent or change a metric, date, title, or credential beyond what its cited claim's `text` states.
- Never mirror language from the job posting back as if it were a fact about the person ("As a proven *10x engineer*...") — only the person's own confirmed claims describe the person.
- Never cite a claim that isn't `status: "confirmed"`, or include anything from an excluded claim.
- Never fabricate enthusiasm-as-fact ("I have followed Northwind Labs for years") unless that itself is a confirmed claim with evidence.
