import { defineWorkflowTool } from "eve/tools";
import { verifyAndPersistExtractedClaims } from "../../../agent/lib/extract-claims-logic.ts";
import { type ExtractClaimsInput, extractClaimsInputSchema, extractClaimsOutputSchema, type ExtractClaimsOutput, extractClaimsToolDescription } from "../../../agent/lib/extract-claims-schema.ts";
import { openStore } from "../../../agent/lib/onboarding-store.ts";

// The real behaviour, not a copy (P03 revision 1, R5 — this comment used to
// make the same claim while this file's own persistExtractedClaims held a
// verbatim duplicate of the verify-then-persist logic; it is corrected here
// to actually be true): schemas, the `openStore` helper, and now the
// verify-then-persist logic itself (`verifyAndPersistExtractedClaims`) are
// all imported from the shared runner/agent/lib module (see
// agent/tools/extract_claims.ts's header comment for the full story). Only
// this tool's "use workflow" executor and "use step" wrapper are necessarily
// duplicated once per eve app root — eve's workflow bundler only recognises
// and registers a directive when it marks a literal function declared in
// the file it is scanning: a step reached only via a cross-app-root import
// builds and compiles, but is left unregistered at runtime ("Step function
// not registered, failing step") — confirmed empirically; see the P03
// report. The evals below still check this tool's real verification and
// persistence behaviour, unchanged.

/** "use step": opens the live store and hands off to the shared, directive-free verify-then-persist logic. */
async function persistExtractedClaims(input: ExtractClaimsInput): Promise<ExtractClaimsOutput> {
  "use step";
  const store = await openStore();
  return verifyAndPersistExtractedClaims(input, store);
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
