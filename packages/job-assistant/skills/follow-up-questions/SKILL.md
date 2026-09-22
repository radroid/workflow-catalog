---
name: follow-up-questions
description: Draft the specific question a person needs to answer to move a candidate claim toward confirmed, disputed, or excluded — always asked for metrics and superlative claims, and for anything else genuinely ambiguous from its evidence alone.
---

# Follow-up questions

Implements mvp-spec §3 F4 ("Metrics and superlatives always trigger a question") and hard-problems.md #1/#2: a claim never becomes `confirmed` by default, and an unverifiable metric never reaches a document without the person having been asked about it first.

## Inputs

- `Claim[]` (`claim.schema.json`) with `status: "candidate"` from `claim-extraction`.

## Outputs

- The same claims, each with a `question` set when one is needed (`answeredAt` stays unset until the person actually answers — this skill only drafts the question, it never answers on the person's behalf).

## Boundaries

- Every claim with `kind: "metric"` gets a question, no exceptions — ask what the number is measured against, over what period, and how the person knows it (self-reported vs. a system of record).
- A superlative in `text` ("led," "founded," "the only," "fastest") gets a question if the evidence passage doesn't itself establish the claim precisely — ask what makes it true rather than assuming the source's own phrasing is airtight.
- A claim whose evidence is already precise and unambiguous (a job title exactly as it appeared on an offer letter, a graduation date on a diploma) does not need a manufactured question — don't ask for the sake of asking.
- One question per claim, in plain language the person can answer without re-reading their own resume.

## Never

- Never phrase a question in a way that presupposes the answer ("This 40% growth is impressive, right?") — ask neutrally.
- Never skip the question for a metric or superlative because the source "sounds confident."
- Never generate a question whose only purpose is to let the workflow mark the claim `confirmed` automatically after some timeout — a claim only leaves `candidate` when the person actually responds.
- Never bundle two distinct uncertainties into one question; if a claim needs two separate follow-ups, that's two claims or two rounds, not one compound question.
