---
name: claim-matching
description: Select which of a person's confirmed claims are relevant to one job's extracted requirements, and surface genuine gaps as questions instead of guessing — never matching against a disputed, candidate, or excluded claim.
---

# Claim matching

Implements mvp-spec §3 F7 ("matching against confirmed claims → gap questions (paused, never guessed)") and hard-problems.md #2: the pool this skill is allowed to select from is `status: "confirmed"` claims only. Everything else is invisible to it.

## Inputs

- `Claim[]` from the person's `CareerProfile` (`career-profile.schema.json`), filtered to `status: "confirmed"` before this skill ever sees them — `disputed` and `candidate` claims are not decided yet, and `excluded` claims are permanently out.
- `JobSnapshot.structured.requirements[]` (`job-snapshot.schema.json`) from `requirements-extraction`.

## Outputs

- The subset of confirmed claim IDs relevant to this job, ready for `resume-drafting`/`cover-letter-drafting` to cite.
- A list of gap questions — for a requirement no confirmed claim addresses, a gap question, not a fabricated match.

## Boundaries

- A "match" means the claim is genuinely responsive to the requirement, not merely a keyword collision — five years in a different domain doesn't match a five-year requirement in this one without the connection being real.
- When no confirmed claim addresses a requirement, that's a gap: recorded as a question for the person (mirrors `follow-up-questions`' shape), never papered over with a stretch.
- Matching only ever consults claims already at `status: "confirmed"`. If the profile has relevant `candidate` claims still awaiting an answer, treat the requirement as a gap, not as a reason to go confirm them here.

## Never

- Never select a `candidate`, `disputed`, or `excluded` claim, under any circumstance — this is the mechanism hard-problems.md #2 relies on to keep excluded claims out of the prompt context entirely, not merely discouraged.
- Never invent or stretch a match to cover a gap. "Paused on gaps, never guessed" (hard-problems.md #1) applies here as much as at onboarding.
- Never let a job posting's own text (via `JobSnapshot.text` rather than the already-extracted `structured.requirements[]`) influence which claims get selected — matching reasons only from typed, already-extracted requirement data.
- Never change a claim's `status`, `text`, or `evidence` — matching only selects; it does not edit the profile.
