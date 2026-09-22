import type { ClaimKind } from "@workflow-catalog/contracts";

/**
 * The deterministic half of `packages/job-assistant/skills/follow-up-questions/SKILL.md`:
 * which candidate claims always get a question, and a neutral question to
 * draft for one. The skill's wording is what a model reasoning over a claim
 * follows; this module is the same rule applied mechanically, so the store
 * (and its tests) never need a model to reproduce the walkthrough's
 * "the metric always asks" behaviour, and `ask_follow_up`'s tool input is
 * checked against it rather than trusted blindly.
 *
 * Kept in sync by hand with the skill's "Always-ask words" line
 * (`packages/job-assistant/test/fixtures.test.ts` parses that line directly
 * for the job-assistant package's own tests; this list must keep naming the
 * same words).
 */
export const ALWAYS_ASK_KINDS: readonly ClaimKind[] = ["metric", "title", "date"];

export const ALWAYS_ASK_WORDS: readonly string[] = ["led", "founded", "the only", "fastest", "maintainer", "used by"];

function escapeRegExp(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word (or phrase), case-insensitive match, exactly as follow-up-questions/SKILL.md's Boundaries section specifies. */
export function usesAlwaysAskWord(text: string): boolean {
  return ALWAYS_ASK_WORDS.some((word) => new RegExp(`\\b${escapeRegExp(word)}\\b`, "i").test(text));
}

/**
 * Whether a candidate claim of this `kind`/`text` always gets a question
 * before it can be confirmed: every metric, title, and date (no
 * exceptions), and every superlative, role, or scope claim — approximated
 * here by the always-ask word list, the same mechanical proxy the skill
 * names as covering those cases ("the words are examples, and every other
 * superlative, role, or scope claim gets one too" — a model drafting the
 * actual question judges the rest; this function is the floor every claim
 * must clear, not the ceiling).
 */
export function needsQuestion(claim: { readonly kind: ClaimKind; readonly text: string }): boolean {
  return ALWAYS_ASK_KINDS.includes(claim.kind) || usesAlwaysAskWord(claim.text);
}

/**
 * A neutral, non-presupposing question for a claim that `needsQuestion`.
 * Follows follow-up-questions/SKILL.md's per-kind guidance. This is a
 * template, not the only acceptable wording — `ask_follow_up`'s tool input
 * lets the calling model supply its own drafted question instead (see the
 * tool's doc comment); this function is what the deterministic store paths
 * (and tests) use when nothing more specific is supplied.
 */
export function draftQuestion(claim: { readonly kind: ClaimKind; readonly text: string }): string {
  switch (claim.kind) {
    case "metric":
      return `What is "${claim.text}" measured against, over what period, and how do you know it — self-reported, or from a system of record?`;
    case "title":
      return `Can you confirm the exact title and employer as you'd want them to appear: "${claim.text}"?`;
    case "date":
      return `Can you confirm the exact date (or range) for "${claim.text}"?`;
    default:
      return `What makes this true — how do you know it, or who could confirm it: "${claim.text}"?`;
  }
}
