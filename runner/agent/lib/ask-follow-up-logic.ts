/**
 * P03 revision 1, R6: whether an eve HITL answer counts as evidence for
 * `ask_follow_up`'s claim, shared the same way R5 shared `extract_claims`'s
 * verify-then-persist logic (`extract-claims-logic.ts`'s header comment) —
 * directive-free, so it is importable from both `agent/tools/ask_follow_up.ts`
 * and `eval-agent/agent/tools/ask_follow_up.ts`, and unit-testable with no
 * eve runtime at all (`test/ask-follow-up-logic.test.ts`).
 *
 * Before this existed, both tool files inlined `answer.optionId === "confirmed"`
 * directly. `ctx.ask`'s own contract (eve/client's `.d.ts`: `ToolInputResponse
 * { optionId?: string; text?: string }`) has no third `optionId` value for a
 * freeform answer — `allowFreeform: true` means `optionId` is simply absent
 * and `text` is set instead — so that inline check mapped every freeform-only
 * answer to "no evidence" and silently excluded the claim, no matter what the
 * person actually wrote.
 */
export function hasEvidenceFromAnswer(answer: { readonly optionId?: string; readonly text?: string }): boolean {
  // Explicitly choosing "Exclude" always wins over any accompanying free
  // text (a person who picks Exclude and also types a caveat is still
  // excluding). Otherwise, a non-blank freeform answer counts as evidence.
  if (answer.optionId !== undefined) return answer.optionId === "confirmed";
  return Boolean(answer.text?.trim());
}
