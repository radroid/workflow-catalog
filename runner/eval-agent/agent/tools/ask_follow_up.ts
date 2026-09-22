import { defineWorkflowTool } from "eve/tools";
import { askFollowUpInputSchema, askFollowUpOutputSchema, askFollowUpToolDescription } from "../../../agent/lib/ask-follow-up-schema.ts";
import { openStore } from "../../../agent/lib/onboarding-store.ts";

// The real behaviour, not a copy: schemas and the `openStore` helper are
// imported from the shared runner/agent/lib module. See
// extract_claims.ts (this directory) and agent/tools/ask_follow_up.ts for
// why this tool's "use workflow" executor and "use step" helpers stay
// inline and duplicated once per eve app root. The evals below still check
// this tool's real approval-free HITL parking behaviour, unchanged.

/** "use step": confirms the claim exists and still needs a decision, before anyone is asked anything. */
async function checkClaimIsOpen(claimId: string): Promise<void> {
  "use step";
  const store = await openStore();
  const profile = await store.read();
  const claim = profile.claims.find((c) => c.id === claimId);
  if (!claim) throw new Error(`No claim ${claimId} in the career profile.`);
  if (claim.status !== "candidate" && claim.status !== "disputed") {
    throw new Error(`Claim ${claimId} already has a decision (${claim.status}); there is nothing to ask.`);
  }
}

/** "use step": marks the claim disputed with this question, so it is visibly "needs a decision" while the person is asked. */
async function openQuestion(claimId: string, question: string): Promise<void> {
  "use step";
  const store = await openStore();
  const result = await store.decideClaim(claimId, "disputed", question);
  if (!result.ok) throw new Error(result.message);
}

/** "use step": records the person's answer once it arrives. */
async function recordAnswer(claimId: string, hasEvidence: boolean, statement: string | undefined): Promise<string> {
  "use step";
  const store = await openStore();
  const result = await store.answerQuestion(claimId, hasEvidence, statement);
  if (!result.ok) throw new Error(result.message);
  return result.message;
}

export default defineWorkflowTool({
  description: askFollowUpToolDescription,
  inputSchema: askFollowUpInputSchema,
  outputSchema: askFollowUpOutputSchema,
  async execute({ claimId, question }, ctx) {
    "use workflow";
    await checkClaimIsOpen(claimId);
    await openQuestion(claimId, question);

    const answer = await ctx.ask({
      prompt: question,
      display: "confirmation",
      options: [
        { id: "confirmed", label: "Confirm — I stand by this", style: "primary" },
        { id: "excluded", label: "Exclude — I can't support this" },
      ],
      allowFreeform: true,
    });

    const hasEvidence = answer.optionId === "confirmed";
    const status: "confirmed" | "excluded" = hasEvidence ? "confirmed" : "excluded";
    const message = await recordAnswer(claimId, hasEvidence, answer.text);
    return { claimId, status, message };
  },
});
