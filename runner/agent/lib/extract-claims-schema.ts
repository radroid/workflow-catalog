import { sourceCategorySchema, claimKindSchema } from "@workflow-catalog/contracts";
import { z } from "zod";

/**
 * `extract_claims`'s input/output shape and description. Directive-free, so
 * both tool roots (`agent/` and `eval-agent/agent/`) import it: directives
 * compile per app root, and only directive-free modules can be shared across
 * roots (docs/spec/research/eve-runtime.md §8 item 14). The verify-only
 * logic is shared the same way, via `extract-claims-logic.ts`.
 *
 * P03.2 (deliverable 5; P04's T1 rule, `logs/handoff/P04-round-2-review.md`):
 * the tool verifies each claim's evidence quote against the real source text
 * and returns what survived — it never writes to the profile store itself.
 * `runner/server/routes/onboarding.ts`'s extraction route reads `claims` off
 * this call's own `action.result` (the way P04's `captures.ts` reads
 * `extract_job`'s), and persists them through `ProfileStore.extractClaims`
 * only after the whole turn is confirmed "ok" (`run-harness.ts`'s one
 * classifier) — so a turn that verifies claims, then fails or is cancelled,
 * saves nothing. Before this, the tool called `store.extractClaims` itself,
 * mid-turn, which is exactly the bug this fixes: a failed turn could still
 * leave claims behind.
 */

const MAX_CLAIMS_PER_CALL = 40;

const claimSchema = z
  .object({
    text: z.string().min(1).max(600),
    kind: claimKindSchema,
    evidenceRef: z.string().min(1).max(200),
    evidenceQuote: z.string().min(1).max(1000),
  })
  .strict();

export const extractClaimsInputSchema = z
  .object({
    sourceCategory: sourceCategorySchema,
    claims: z.array(claimSchema).min(1).max(MAX_CLAIMS_PER_CALL),
  })
  .strict();

export type ExtractClaimsInput = z.infer<typeof extractClaimsInputSchema>;

export const extractClaimsOutputSchema = z
  .object({
    sourceCategory: sourceCategorySchema,
    /** Verified against the real source text (claim-extraction/SKILL.md), not yet persisted: the route saves these, after an ok turn (D14). */
    claims: z.array(claimSchema),
    /** Evidence quotes that were not found verbatim in the source text; dropped, never persisted. */
    rejected: z.array(z.string()),
    message: z.string(),
  })
  .strict();

export type ExtractClaimsOutput = z.infer<typeof extractClaimsOutputSchema>;

export const extractClaimsToolDescription =
  "Record candidate claims extracted from one provided career source (resume, cover letters, portfolio, repositories, social export, work samples, or preferences). Pass the source category and the claims you drafted, each with an evidence quote copied verbatim from the source. Every claim starts as a candidate; nothing is confirmed here.";
