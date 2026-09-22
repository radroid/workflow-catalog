import { defineWorkflowTool } from "eve/tools";
import { type ExtractClaimsInput, extractClaimsInputSchema, extractClaimsOutputSchema, type ExtractClaimsOutput, extractClaimsToolDescription } from "../lib/extract-claims-schema.ts";
import { openStore } from "../lib/onboarding-store.ts";

/**
 * The real tool module eve discovers under `agent/tools/`.
 *
 * `packages/job-assistant/skills/claim-extraction/SKILL.md`'s tool: turns
 * one provided source's content into candidate claims. Thin and typed, per
 * the P02 rule (README "Extending the runner" §4): the model never passes
 * raw document content or a URL here — only `sourceCategory` (an id) and the
 * candidate claims *it* drafted after reading the source as user-turn data
 * (never as a system prompt; see the onboarding bridge route, which is what
 * hands the model that text). This tool's own job is to check the model's
 * work, not to trust it: every `evidenceQuote` must appear verbatim in the
 * workspace's actual source text for that category, or the claim is
 * dropped — exactly claim-extraction/SKILL.md's "every claim must have a
 * real evidence.quote drawn from the actual source." Durable
 * (`defineWorkflowTool`) and idempotent per source content: re-extracting
 * the same (category, evidence ref, evidence quote) triple adds nothing new
 * (`profile-reducer.ts`'s `extractClaims` action).
 *
 * The schemas live in `../lib/extract-claims-schema.ts`, freely shared with
 * `eval-agent/agent/tools/extract_claims.ts` (that file's header comment
 * says why: they carry no workflow/step directive). This file's own
 * `"use workflow"` executor and `"use step"` helper stay inline and are
 * necessarily duplicated once per eve app root — empirically, eve's
 * workflow bundler only recognises and registers a directive when it marks
 * a literal function declared in the file it is scanning, not one merely
 * referenced via import (see this repo's P03 report for how that was
 * traced and confirmed against eve's own compiled source).
 */

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
