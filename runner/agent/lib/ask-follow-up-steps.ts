import type { ProfileStore } from "../../store/profile.ts";
import { interpretFollowUpAnswer, type FollowUpAnswer } from "./ask-follow-up-logic.ts";
import type { AskFollowUpOutput } from "./ask-follow-up-schema.ts";

/**
 * The bodies of `ask_follow_up`'s three steps (P03 revision 2, V5). Both tool
 * roots (`agent/tools/ask_follow_up.ts` and
 * `eval-agent/agent/tools/ask_follow_up.ts`) keep only a one-line
 * `"use step"` wrapper that opens the store and calls one of these, because
 * directives compile per app root (docs/spec/research/eve-runtime.md §8
 * item 14): a step imported from another root fails at run time, while a
 * directive-free helper like this one works from either. So the logic is
 * written once, and `test/ask-follow-up-steps.test.ts` tests it directly
 * against a real store.
 *
 * Each store call below runs under the profile lock and reconciles
 * career-profile.md first (D8, D9).
 */

/** Refuses to ask about a claim that doesn't exist or already has a decision. */
export async function checkFollowUpClaimIsOpen(store: ProfileStore, claimId: string): Promise<void> {
  const profile = await store.read();
  const claim = profile.claims.find((c) => c.id === claimId);
  if (!claim) throw new Error(`No claim ${claimId} in the career profile.`);
  if (claim.status !== "candidate" && claim.status !== "disputed") {
    throw new Error(`Claim ${claimId} already has a decision (${claim.status}); there is nothing to ask.`);
  }
}

/** Marks the claim disputed with this question, so it shows as "question open" while the person is asked. */
export async function openFollowUpQuestion(store: ProfileStore, claimId: string, question: string): Promise<void> {
  const result = await store.decideClaim(claimId, "disputed", question);
  if (!result.ok) throw new Error(result.message);
}

/**
 * Records the person's answer (D10). Only an explicit option decides the
 * claim; free text alone is kept as a note and the tool result says the claim
 * is still open, so the model never reports a decision nobody made.
 */
export async function recordFollowUpAnswer(store: ProfileStore, claimId: string, answer: FollowUpAnswer): Promise<AskFollowUpOutput> {
  const decision = interpretFollowUpAnswer(answer);
  switch (decision.kind) {
    case "confirm": {
      const result = await store.answerQuestion(claimId, true, decision.statement);
      if (!result.ok) throw new Error(result.message);
      return { claimId, status: "confirmed", message: result.message };
    }
    case "exclude": {
      const result = await store.answerQuestion(claimId, false);
      if (!result.ok) throw new Error(result.message);
      return { claimId, status: "excluded", message: result.message };
    }
    case "note": {
      const result = await store.recordQuestionNote(claimId, decision.text);
      if (!result.ok) throw new Error(result.message);
      return {
        claimId,
        status: "open",
        message:
          "The claim stays open. The person replied without choosing Confirm or Exclude, so nothing was decided; their reply is saved as a note on the question. Do not describe the claim as confirmed or excluded.",
      };
    }
    case "none":
      return {
        claimId,
        status: "open",
        message: "The claim stays open. The answer chose neither Confirm nor Exclude, so nothing was decided. Do not describe the claim as confirmed or excluded.",
      };
    default: {
      const _exhaustive: never = decision;
      throw new Error(`Unknown decision: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
