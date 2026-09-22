import { sourceCategorySchema, claimKindSchema } from "@workflow-catalog/contracts";
import { z } from "zod";

/**
 * `extract_claims`'s input/output shape and description. Directive-free, so
 * both tool roots (`agent/` and `eval-agent/agent/`) import it: directives
 * compile per app root, and only directive-free modules can be shared across
 * roots (docs/spec/research/eve-runtime.md §8 item 14). The
 * verify-then-persist logic is shared the same way, via
 * `extract-claims-logic.ts`.
 */

const MAX_CLAIMS_PER_CALL = 40;

export const extractClaimsInputSchema = z
  .object({
    sourceCategory: sourceCategorySchema,
    claims: z
      .array(
        z
          .object({
            text: z.string().min(1).max(600),
            kind: claimKindSchema,
            evidenceRef: z.string().min(1).max(200),
            evidenceQuote: z.string().min(1).max(1000),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_CLAIMS_PER_CALL),
  })
  .strict();

export type ExtractClaimsInput = z.infer<typeof extractClaimsInputSchema>;

export const extractClaimsOutputSchema = z
  .object({
    sourceCategory: sourceCategorySchema,
    /** D14 (P03 revision 2): the store accepted the write. The extraction route records a content hash only after a call that persisted. */
    persisted: z.boolean(),
    added: z.number().int().nonnegative(),
    rejected: z.array(z.string()),
    message: z.string(),
  })
  .strict();

export type ExtractClaimsOutput = z.infer<typeof extractClaimsOutputSchema>;

export const extractClaimsToolDescription =
  "Record candidate claims extracted from one provided career source (resume, cover letters, portfolio, repositories, social export, work samples, or preferences). Pass the source category and the claims you drafted, each with an evidence quote copied verbatim from the source. Every claim starts as a candidate; nothing is confirmed here.";
