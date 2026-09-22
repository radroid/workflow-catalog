import { sourceCategorySchema, claimKindSchema } from "@workflow-catalog/contracts";
import { z } from "zod";

/**
 * `extract_claims`'s input/output shape and description, split out from
 * `agent/tools/extract_claims.ts` (P03 revision-1 report nit: this comment
 * previously named a `extract-claims-workflow.ts` that never existed) on
 * purpose: this file contains no `"use step"`/`"use workflow"` directive
 * anywhere, so eve's bundler takes the fast, directive-free path for it
 * (`mayContainWorkflowDirective`, in
 * `node_modules/eve/dist/src/internal/workflow-bundle/authored-workflow-directives.js`)
 * regardless of which of the two app roots (`agent/` or `eval-agent/agent/`)
 * imports it. Empirically, keeping these consts in the SAME file as the
 * `"use step"` function made them intermittently unresolvable
 * ("MISSING_EXPORT") to whichever tool module imported them by the longer,
 * cross-app-root relative path — see the P03 report. The verify-then-persist
 * logic itself is shared the same way, via `extract-claims-logic.ts`
 * (P03 revision 1, R5).
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
    added: z.number().int().nonnegative(),
    rejected: z.array(z.string()),
    message: z.string(),
  })
  .strict();

export type ExtractClaimsOutput = z.infer<typeof extractClaimsOutputSchema>;

export const extractClaimsToolDescription =
  "Record candidate claims extracted from one provided career source (resume, cover letters, portfolio, repositories, social export, work samples, or preferences). Pass the source category and the claims you drafted, each with an evidence quote copied verbatim from the source. Every claim starts as a candidate; nothing is confirmed here.";
