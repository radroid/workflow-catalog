import type { ProfileStore } from "../../store/profile.ts";
import type { ExtractClaimsInput, ExtractClaimsOutput } from "./extract-claims-schema.ts";

/**
 * P03.2 (deliverable 5): the verify-only behaviour behind `extract_claims`.
 * Checks every evidence quote the model drafted against the workspace's
 * actual source text for that category (claim-extraction/SKILL.md: "every
 * claim must have a real evidence.quote drawn from the actual source"),
 * drops anything that does not match verbatim, and returns what survived.
 * Never writes to the profile store: the caller (today, only
 * `runner/server/routes/onboarding.ts`'s extraction route, after confirming
 * the whole turn was "ok") persists `claims` through
 * `ProfileStore.extractClaims`, which is where the idempotent-per-`(source,
 * evidence)` de-duplication happens (`profile-reducer.ts`'s `extractClaims`
 * action). Before this packet the tool persisted here, mid-turn, which is
 * the bug P04's T1 rule fixed: a turn that verified claims, then failed or
 * was cancelled, still left them saved.
 *
 * Read-only on the store (only `sourceText`, never a write), so the
 * parameter is narrowed to that one method: nothing here can accidentally
 * grow a second write path.
 *
 * Directive-free, so both tool roots (`agent/tools/extract_claims.ts` and
 * `eval-agent/agent/tools/extract_claims.ts`) call it from a one-line
 * `"use step"` wrapper, and `test/extract-claims-logic.test.ts` tests it
 * against a real store's source text. Directives compile per app root
 * (docs/spec/research/eve-runtime.md §8 item 14), which is why the logic
 * lives here and not in either tool file.
 */
export async function verifyExtractedClaims(input: ExtractClaimsInput, store: Pick<ProfileStore, "sourceText">): Promise<ExtractClaimsOutput> {
  const sourceText = await store.sourceText(input.sourceCategory);
  const claims: ExtractClaimsInput["claims"] = [];
  const rejected: string[] = [];
  for (const claim of input.claims) {
    if (sourceText.includes(claim.evidenceQuote)) claims.push(claim);
    else rejected.push(claim.evidenceQuote);
  }
  const message =
    claims.length === 0
      ? rejected.length > 0
        ? "No claim's evidence quote was found in the source text."
        : "No claims supplied."
      : `${claims.length} claim${claims.length === 1 ? "" : "s"} verified${rejected.length > 0 ? `; ${rejected.length} rejected` : ""}.`;
  return { sourceCategory: input.sourceCategory, claims, rejected, message };
}
