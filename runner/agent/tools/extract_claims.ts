import { defineWorkflowTool } from "eve/tools";
import { verifyAndPersistExtractedClaims } from "../lib/extract-claims-logic.ts";
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
 * The schemas live in `../lib/extract-claims-schema.ts`, and the actual
 * verify-then-persist logic in `../lib/extract-claims-logic.ts`, both
 * freely shared with `eval-agent/agent/tools/extract_claims.ts` (those
 * files' header comments say why: they carry no workflow/step directive).
 * This file's own `"use workflow"` executor and `"use step"` wrapper stay
 * inline and are necessarily duplicated once per eve app root —
 * empirically, eve's workflow bundler only recognises and registers a
 * directive when it marks a literal function declared in the file it is
 * scanning, not one merely referenced via import (see this repo's P03
 * report for how that was traced and confirmed against eve's own compiled
 * source). Until P03 revision 1 (R5) this file's `"use step"` function held
 * the real verify-then-persist logic directly, duplicated verbatim in
 * eval-agent's copy of this file; it is now a thin wrapper so the logic
 * itself is written, and tested, exactly once.
 */

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
