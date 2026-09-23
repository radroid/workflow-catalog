/**
 * `ask_follow_up`'s pure logic: the question it puts to the person and what
 * their answer means. No imports at run time, so the `"use workflow"` body of
 * both tool roots can call `followUpRequest` without pulling store or Node
 * code into the workflow bundle, and `test/ask-follow-up-logic.test.ts` tests
 * it with no eve runtime at all.
 *
 * D10 (P03 revision 2; F4, hard-problems #2): only an explicit option changes
 * a claim. eve@0.63.0 turns a typed reply that matches no option's id, label
 * or number into a freeform answer (`{text}`, see
 * `node_modules/eve/dist/src/channel/resolve-text.js` and
 * `docs/concepts/sessions-runs-and-streaming.md`), so "exclude", "No, I can't
 * back that number up." and "what do you mean?" all arrive as text alone.
 * Reading intent into that text is a guess, so a text-only answer never
 * confirms or excludes: the claim stays disputed with its question open, and
 * the text is kept as the person's note on the question.
 */

export const FOLLOW_UP_OPTIONS = [
  { id: "confirmed", label: "Confirm: I stand by this", style: "primary" },
  { id: "excluded", label: "Exclude: I can't support this" },
] as const;

/** The `ctx.ask` request for one follow-up question. Freeform text is allowed, and kept as a note (D10). */
export function followUpRequest(question: string) {
  return {
    prompt: question,
    display: "confirmation" as const,
    options: FOLLOW_UP_OPTIONS.map((option) => ({ ...option })),
    allowFreeform: true,
  };
}

/** eve's answer to a `ctx.ask` request: an option id, free text, or both. */
export interface FollowUpAnswer {
  readonly optionId?: string;
  readonly text?: string;
}

export type FollowUpDecision =
  | { readonly kind: "confirm"; readonly statement?: string }
  | { readonly kind: "exclude" }
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "none" };

/**
 * What an answer does to the claim (D10):
 *
 * - option "confirmed": confirm, with any text as the person's statement;
 * - option "excluded": exclude (any text with it doesn't change that);
 * - no option, some text: a note on the question; the claim stays open;
 * - anything else (an unknown option, nothing at all): nothing changes.
 */
export function interpretFollowUpAnswer(answer: FollowUpAnswer): FollowUpDecision {
  const text = answer.text?.trim() ?? "";
  if (answer.optionId === "confirmed") return text ? { kind: "confirm", statement: text } : { kind: "confirm" };
  if (answer.optionId === "excluded") return { kind: "exclude" };
  if (answer.optionId === undefined && text) return { kind: "note", text };
  return { kind: "none" };
}
