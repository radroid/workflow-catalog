import { defineWorkflowTool } from "eve/tools";
import { followUpRequest, type FollowUpAnswer } from "../lib/ask-follow-up-logic.ts";
import { askFollowUpInputSchema, askFollowUpOutputSchema, askFollowUpToolDescription, type AskFollowUpOutput } from "../lib/ask-follow-up-schema.ts";
import { checkFollowUpClaimIsOpen, openFollowUpQuestion, recordFollowUpAnswer } from "../lib/ask-follow-up-steps.ts";
import { openStore } from "../lib/onboarding-store.ts";

/**
 * The tool module eve discovers under `agent/tools/`.
 *
 * `packages/job-assistant/skills/follow-up-questions/SKILL.md`'s tool: pose
 * the drafted question for one candidate claim and durably wait for the
 * person's answer (eve HITL, `ctx.ask`, docs/tools/human-in-the-loop.md).
 * Input is a claim id and the question, never source content. The turn parks
 * (`session.waiting`) until the person answers, for as long as it takes.
 *
 * Only an explicit option decides the claim (D10): Confirm records the
 * person's words as `{kind: "statement"}` evidence and keeps the superseded
 * passage in `revisions[]`; Exclude excludes it; a reply that chooses neither
 * is kept as a note on the question and the claim stays open.
 *
 * The step bodies live in `../lib/ask-follow-up-steps.ts` and the request and
 * answer rules in `../lib/ask-follow-up-logic.ts`, shared with
 * `eval-agent/agent/tools/ask_follow_up.ts`. This file keeps only the
 * executor and one-line step wrappers, because directives compile per app
 * root (docs/spec/research/eve-runtime.md §8 item 14).
 */

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
