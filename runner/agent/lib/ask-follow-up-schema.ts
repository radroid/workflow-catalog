import { uuidSchema } from "@workflow-catalog/contracts";
import { z } from "zod";

/**
 * `ask_follow_up`'s input/output shape and description. Directive-free, like
 * everything `agent/tools/ask_follow_up.ts` shares with the eval agent's
 * root (docs/spec/research/eve-runtime.md §8 item 14).
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
    /** "open" (D10): the person replied without choosing an option, so the claim is still disputed and its question still open. */
    status: z.enum(["confirmed", "excluded", "open"]),
    message: z.string(),
  })
  .strict();

export type AskFollowUpOutput = z.infer<typeof askFollowUpOutputSchema>;

export const askFollowUpToolDescription =
  "Ask the person the follow-up question a candidate claim needs before it can be confirmed, and wait for their answer. Never guesses or times out into a decision: only the person choosing Confirm or Exclude decides the claim. A reply that chooses neither is saved as a note and the claim stays open.";
