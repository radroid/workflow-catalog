import type { ProfileStore } from "../../store/profile.ts";
import type { ExtractClaimsInput, ExtractClaimsOutput } from "./extract-claims-schema.ts";

/**
 * The verify-then-persist behaviour behind `extract_claims`: checks every
 * evidence quote the model drafted against the workspace's actual source text
 * for that category (claim-extraction/SKILL.md: "every claim must have a real
 * evidence.quote drawn from the actual source"), drops anything that does not
 * match verbatim, then persists what survived through the store (idempotent
 * per `(source, evidence)`: `profile-reducer.ts`'s `extractClaims` action
 * de-duplicates).
 *
 * Directive-free, so both tool roots (`agent/tools/extract_claims.ts` and
 * `eval-agent/agent/tools/extract_claims.ts`) call it from a one-line
 * `"use step"` wrapper, and `test/extract-claims-logic.test.ts` tests it
 * against a real store. Directives compile per app root
 * (docs/spec/research/eve-runtime.md §8 item 14), which is why the logic
 * lives here and not in either tool file.
 *
 * `persisted` (P03 revision 2, D14) is true only when the store accepted the
 * write, so the extraction route records the source's content hash only after
 * a call in that turn actually persisted.
 */
export async function verifyAndPersistExtractedClaims(input: ExtractClaimsInput, store: ProfileStore): Promise<ExtractClaimsOutput> {
  const sourceText = await store.sourceText(input.sourceCategory);
  const verified: ExtractClaimsInput["claims"] = [];
  const rejected: string[] = [];
  for (const claim of input.claims) {
    if (sourceText.includes(claim.evidenceQuote)) verified.push(claim);
    else rejected.push(claim.evidenceQuote);
  }
  if (verified.length === 0) {
    return {
      sourceCategory: input.sourceCategory,
      persisted: false,
      added: 0,
      rejected,
      message: rejected.length > 0 ? "No claim's evidence quote was found in the source text; nothing was added." : "No claims supplied.",
    };
  }
  const result = await store.extractClaims(
    input.sourceCategory,
    verified.map((claim) => ({ text: claim.text, kind: claim.kind, evidenceRef: claim.evidenceRef, evidenceQuote: claim.evidenceQuote })),
  );
  return { sourceCategory: input.sourceCategory, persisted: result.ok, added: result.added, rejected, message: result.message };
}
