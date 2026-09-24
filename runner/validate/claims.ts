import type { Claim } from "@workflow-catalog/contracts";
import type { ValidationClaim } from "./validator.ts";

/**
 * Claim labels (P05): `C1`, `C2`, … by each claim's place in the career
 * profile's `claims[]`, counting every claim whatever its status. The
 * profile only ever appends claims and changes them in place (P03's
 * reducer), so a claim keeps its label for as long as the profile exists:
 * version 2 of a document cites the same C4 as version 1, and a claim that
 * was excluded simply leaves its label unused ("cites C1, C2, C4–C6 but
 * never C3", docs/spec/visuals/index.html).
 *
 * The model only ever sees the confirmed claims' labels and texts. The
 * others keep their labels here so the validator can name a citation of one
 * without the model ever having been shown it.
 */
export function labelClaims(claims: readonly Claim[]): ValidationClaim[] {
  return claims.map((claim, index) => ({ label: `C${index + 1}`, id: claim.id, kind: claim.kind, status: claim.status, text: claim.text }));
}

/** Label order: C2 before C10. */
export function compareLabels(a: string, b: string): number {
  return Number(a.slice(1)) - Number(b.slice(1));
}
