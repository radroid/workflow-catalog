import { defineWorkflowTool } from "eve/tools";
import { followUpRequest, type FollowUpAnswer } from "../../../agent/lib/ask-follow-up-logic.ts";
import { askFollowUpInputSchema, askFollowUpOutputSchema, askFollowUpToolDescription, type AskFollowUpOutput } from "../../../agent/lib/ask-follow-up-schema.ts";
import { checkFollowUpClaimIsOpen, openFollowUpQuestion, recordFollowUpAnswer } from "../../../agent/lib/ask-follow-up-steps.ts";
import { openStore } from "../../../agent/lib/onboarding-store.ts";

// The eval agent's own thin wrapper around the shared ask_follow_up logic.
// Directives compile per app root (docs/spec/research/eve-runtime.md §8 item
// 14), so this root needs its own "use workflow" executor and "use step"
// wrappers; each wrapper is one line that opens the store and calls the
// directive-free helper in runner/agent/lib/ask-follow-up-steps.ts, the same
// call runner/agent/tools/ask_follow_up.ts makes. The logic itself is never
// copied here, so the evals exercise the helpers production runs, and
// test/ask-follow-up-tools.test.ts checks this file and the production one
// behave the same.

async function checkClaimIsOpen(claimId: string): Promise<void> {
  "use step";
  return checkFollowUpClaimIsOpen(await openStore(), claimId);
}

async function openQuestion(claimId: string, question: string): Promise<void> {
  "use step";
  return openFollowUpQuestion(await openStore(), claimId, question);
}

async function recordAnswer(claimId: string, answer: FollowUpAnswer): Promise<AskFollowUpOutput> {
  "use step";
  return recordFollowUpAnswer(await openStore(), claimId, answer);
}

export default defineWorkflowTool({
  description: askFollowUpToolDescription,
  inputSchema: askFollowUpInputSchema,
  outputSchema: askFollowUpOutputSchema,
  async execute({ claimId, question }, ctx) {
    "use workflow";
    await checkClaimIsOpen(claimId);
    await openQuestion(claimId, question);
    const answer = await ctx.ask(followUpRequest(question));
    return recordAnswer(claimId, answer);
  },
});
