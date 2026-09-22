import { defineWorkflowTool } from "eve/tools";
import { verifyAndPersistExtractedClaims } from "../lib/extract-claims-logic.ts";
import { type ExtractClaimsInput, extractClaimsInputSchema, extractClaimsOutputSchema, type ExtractClaimsOutput, extractClaimsToolDescription } from "../lib/extract-claims-schema.ts";
import { openStore } from "../lib/onboarding-store.ts";

/**
 * The tool module eve discovers under `agent/tools/`.
 *
 * `packages/job-assistant/skills/claim-extraction/SKILL.md`'s tool: turns one
 * provided source's content into candidate claims. Thin and typed, per the
 * P02 rule (README "Extending the runner" §4): the model never passes raw
 * document content or a URL here, only `sourceCategory` and the candidate
 * claims it drafted after reading the source as user-turn data (the
 * onboarding bridge route hands it that text). The tool checks the model's
 * work instead of trusting it: every `evidenceQuote` must appear verbatim in
 * the workspace's source text for that category, or the claim is dropped
 * (claim-extraction/SKILL.md). Durable (`defineWorkflowTool`) and idempotent
 * per `(category, evidence ref, evidence quote)`.
 *
 * The logic lives in `../lib/extract-claims-logic.ts` and the schemas in
 * `../lib/extract-claims-schema.ts`, shared with
 * `eval-agent/agent/tools/extract_claims.ts`. Directives compile per app root
 * (docs/spec/research/eve-runtime.md §8 item 14): within one root, imports of
 * `"use workflow"` executors and step modules work; across roots, a
 * re-exported workflow tool fails discovery ("requires a compiled workflow
 * executor") and an imported step fails at run time ("Step … is not
 * registered"). So each root keeps this thin executor and a one-line step
 * wrapper, and the logic is written and tested once.
 */

async function persistExtractedClaims(input: ExtractClaimsInput): Promise<ExtractClaimsOutput> {
  "use step";
  return verifyAndPersistExtractedClaims(input, await openStore());
}

export default defineWorkflowTool({
  description: extractClaimsToolDescription,
  inputSchema: extractClaimsInputSchema,
  outputSchema: extractClaimsOutputSchema,
  async execute(input) {
    "use workflow";
    return persistExtractedClaims(input);
  },
});
