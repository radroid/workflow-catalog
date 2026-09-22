import { uuidSchema } from "@workflow-catalog/contracts";
import { z } from "zod";

/**
 * `ask_follow_up`'s input/output shape and description. Split out from
 * `agent/tools/ask_follow_up.ts` (P03 revision-1 report nit: this comment
 * previously named an `ask-follow-up-workflow.ts` that never existed) on
 * purpose — see `extract-claims-schema.ts`'s header comment for why (this
 * file has no `"use step"`/`"use workflow"` directive, so eve's bundler
 * takes the fast, directive-free path for it regardless of which app root
 * imports it).
 */

export const askFollowUpInputSchema = z
  .object({
    claimId: uuidSchema,
    question: z.string().min(1).max(400),
  })
  .strict();

export type AskFollowUpInput = z.infer<typeof askFollowUpInputSchema>;

export const askFollowUpOutputSchema = z
  .object({
    claimId: uuidSchema,
    status: z.enum(["confirmed", "excluded"]),
    message: z.string(),
  })
  .strict();

export type AskFollowUpOutput = z.infer<typeof askFollowUpOutputSchema>;

export const askFollowUpToolDescription =
  "Ask the person the follow-up question a candidate claim needs before it can be confirmed, and wait for their answer. Never guesses or times out into a decision: the claim stays undecided until the person actually responds, even if that takes days.";
