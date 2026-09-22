import { defineWorkflowTool } from "eve/tools";
import { verifyAndPersistExtractedClaims } from "../../../agent/lib/extract-claims-logic.ts";
import { type ExtractClaimsInput, extractClaimsInputSchema, extractClaimsOutputSchema, type ExtractClaimsOutput, extractClaimsToolDescription } from "../../../agent/lib/extract-claims-schema.ts";
import { openStore } from "../../../agent/lib/onboarding-store.ts";

// The eval agent's own thin wrapper around the shared extract_claims logic.
// Directives compile per app root (docs/spec/research/eve-runtime.md §8 item
// 14): within one root, imports of "use workflow" executors and step modules
// work; across roots, a re-exported workflow tool fails discovery ("requires a
// compiled workflow executor") and an imported step fails at run time ("Step
// … is not registered"). So this root keeps its own executor and a one-line
// step wrapper that calls the directive-free
// runner/agent/lib/extract-claims-logic.ts, exactly as
// runner/agent/tools/extract_claims.ts does. The logic is never copied here.

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
