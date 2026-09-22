import { defineWorkflowTool } from "eve/tools";
import { askFollowUpInputSchema, askFollowUpOutputSchema, askFollowUpToolDescription } from "../lib/ask-follow-up-schema.ts";
import { openStore } from "../lib/onboarding-store.ts";

/**
 * The real tool module eve discovers under `agent/tools/`.
 *
 * `packages/job-assistant/skills/follow-up-questions/SKILL.md`'s tool: pose
 * the drafted question for one candidate claim and durably wait for the
 * person's own answer (eve HITL — `ctx.ask`, docs/tools/human-in-the-loop.md).
 * Thin and typed: input is a claim id and the question text, never raw
 * source content. The turn parks (`session.waiting`) until the person
 * responds, for as long as it takes; nothing here guesses. The answer is
 * recorded as `{kind: "statement"}` evidence, never as an external fact
 * (mvp-spec §5), and the superseded passage evidence is kept in
 * `revisions[]` (`profile-reducer.ts`'s `answerQuestion` action).
 *
 * The schemas live in `../lib/ask-follow-up-schema.ts`, freely shared with
 * `eval-agent/agent/tools/ask_follow_up.ts` (that file's header comment says
 * why: they carry no workflow/step directive). This file's own
 * `"use workflow"` executor and `"use step"` helpers stay inline and are
 * necessarily duplicated once per eve app root — see
 * `agent/tools/extract_claims.ts`'s header comment for why (confirmed
 * empirically against eve's own compiled source; see the P03 report).
 */

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
