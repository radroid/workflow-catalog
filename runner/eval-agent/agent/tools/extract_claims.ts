import { defineWorkflowTool } from "eve/tools";
import { type ExtractClaimsInput, extractClaimsInputSchema, extractClaimsOutputSchema, type ExtractClaimsOutput, extractClaimsToolDescription } from "../../../agent/lib/extract-claims-schema.ts";
import { openStore } from "../../../agent/lib/onboarding-store.ts";

// The real behaviour, not a copy: schemas and the `openStore` helper are
// imported from the shared runner/agent/lib module (see
// agent/tools/extract_claims.ts's header comment for the full story). Only
// this tool's "use workflow" executor and "use step" helper are necessarily
// duplicated once per eve app root — eve's workflow bundler only recognises
// and registers a directive when it marks a literal function declared in
// the file it is scanning: a step reached only via a cross-app-root import
// built and compiled, but was left unregistered at runtime ("Step function
// not registered, failing step") — confirmed empirically; see the P03
// report. The evals below still check this tool's real verification and
// persistence behaviour, unchanged.

/** "use step": verifies every evidence quote against the real source text, then persists. */
async function persistExtractedClaims(input: ExtractClaimsInput): Promise<ExtractClaimsOutput> {
  "use step";
  const store = await openStore();
  const sourceText = await store.sourceText(input.sourceCategory);
  const verified: ExtractClaimsInput["claims"] = [];
  const rejected: string[] = [];
  for (const claim of input.claims) {
    if (sourceText.includes(claim.evidenceQuote)) verified.push(claim);
    else rejected.push(claim.evidenceQuote);
  }
  if (verified.length === 0) {
    return { added: 0, rejected, message: rejected.length > 0 ? "No claim's evidence quote was found in the source text; nothing was added." : "No claims supplied." };
  }
  const result = await store.extractClaims(
    input.sourceCategory,
    verified.map((claim) => ({ text: claim.text, kind: claim.kind, evidenceRef: claim.evidenceRef, evidenceQuote: claim.evidenceQuote })),
  );
  return { added: result.added, rejected, message: result.message };
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
