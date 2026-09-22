import type { ProfileStore } from "../../store/profile.ts";
import type { ExtractClaimsInput, ExtractClaimsOutput } from "./extract-claims-schema.ts";

/**
 * The real verify-then-persist behaviour behind `extract_claims`: checks
 * every evidence quote the model drafted against the workspace's actual
 * source text for that category (claim-extraction/SKILL.md: "every claim
 * must have a real evidence.quote drawn from the actual source"), drops
 * anything that does not match verbatim, then persists whatever survived
 * through the store (idempotent per `(source, evidence)` — `profile-reducer.ts`'s
 * `extractClaims` action already de-duplicates; this function does not
 * re-implement that).
 *
 * Directive-free (no `"use step"`/`"use workflow"` anywhere in this file),
 * so — unlike a function carrying one of those — it is freely importable
 * from both `agent/tools/extract_claims.ts` and
 * `eval-agent/agent/tools/extract_claims.ts`, and directly unit-testable
 * with a real `ProfileStore` over a temp workspace: no eve runtime, no
 * `RUNNER_WORKSPACE`, no directive-bundling behaviour to route around
 * (`test/extract-claims-logic.test.ts`).
 *
 * P03 revision 1, R5: before this file existed, this exact logic was
 * duplicated verbatim between the two tool files' `"use step"` functions,
 * even though `eval-agent/agent/tools/extract_claims.ts`'s header comment
 * claimed "the real behaviour, not a copy" — true of the schemas and
 * `openStore` (both already directive-free and already shared), never true
 * of this verification logic until now. Each tool file now keeps only a
 * thin `"use step"` wrapper — a literal, in-file function eve's bundler can
 * discover and register — that does nothing but open a store and call this.
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
    return { added: 0, rejected, message: rejected.length > 0 ? "No claim's evidence quote was found in the source text; nothing was added." : "No claims supplied." };
  }
  const result = await store.extractClaims(
    input.sourceCategory,
    verified.map((claim) => ({ text: claim.text, kind: claim.kind, evidenceRef: claim.evidenceRef, evidenceQuote: claim.evidenceQuote })),
  );
  return { added: result.added, rejected, message: result.message };
}
