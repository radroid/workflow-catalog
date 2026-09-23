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
 * Why a claim gets a question, for a person to read (P03 revision 3, polish
 * 4): "it's a metric claim" when its kind always asks, else the always-ask word
 * its text uses, quoted as written ("it says “Led”"), the earliest one in the
 * text. Undefined when neither applies: a claim disputed by hand, or a
 * question a model asked for reasons of its own.
 */
export function questionReason(claim: { readonly kind: ClaimKind; readonly text: string }): string | undefined {
  if (ALWAYS_ASK_KINDS.includes(claim.kind)) return `it's a ${claim.kind} claim`;
  let first: RegExpExecArray | undefined;
  for (const word of ALWAYS_ASK_WORDS) {
    const match = new RegExp(`\\b${escapeRegExp(word)}\\b`, "i").exec(claim.text);
    if (match && (first === undefined || match.index < first.index)) first = match;
  }
  return first ? `it says “${first[0]}”` : undefined;
}

/** A number in claim text: "30%", "1.2k", "40", "3x". Numbers are how a metric, a date, or a scope ("used by 40 teams") usually enters a claim. */
const NUMBER = /\d+(?:[.,]\d+)*\s*(?:%|percent\b|x\b|×|k\b|m\b|bn\b)?/gi;

/**
 * The always-ask items a claim's text carries: each always-ask word it uses
 * (whole word, any case) and each number in it. D15 (P03 revision 2) compares
 * these before and after an edit.
 */
export function alwaysAskTriggers(text: string): Set<string> {
  const triggers = new Set<string>();
  for (const word of ALWAYS_ASK_WORDS) {
    if (new RegExp(`\\b${escapeRegExp(word)}\\b`, "i").test(text)) triggers.add(`word:${word}`);
  }
  for (const match of text.matchAll(NUMBER)) triggers.add(`number:${match[0].toLowerCase().replace(/\s+/g, "")}`);
  return triggers;
}

/**
 * D15: whether editing a claim's text from `before` to `after` adds an item
 * follow-up-questions/SKILL.md always asks about, so the edited claim needs a
 * question again before it can stay confirmed.
 *
 * - A metric, title, or date claim is itself the always-ask item: any change
 *   to its text changes what the person confirmed.
 * - Any other claim needs one when the edit brings in an always-ask word or a
 *   number the old text did not have ("…team" → "…team used by 40 people").
 */
export function editAddsAlwaysAskItem(kind: ClaimKind, before: string, after: string): boolean {
  if (before === after) return false;
  if (ALWAYS_ASK_KINDS.includes(kind)) return true;
  const had = alwaysAskTriggers(before);
  for (const trigger of alwaysAskTriggers(after)) if (!had.has(trigger)) return true;
  return false;
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
