import { describe, expect, it } from "vitest";
import { hasEvidenceFromAnswer } from "../agent/lib/ask-follow-up-logic.ts";

/**
 * P03 revision 1, R6: the exact bug the reviewer found — `answer.optionId
 * === "confirmed"` alone maps every freeform-only answer (`allowFreeform:
 * true`, so `optionId` is absent and `text` is set instead) to "no
 * evidence," silently excluding the claim no matter what the person wrote.
 */
describe("hasEvidenceFromAnswer", () => {
  it("is true when the person picks the Confirm option", () => {
    expect(hasEvidenceFromAnswer({ optionId: "confirmed" })).toBe(true);
    expect(hasEvidenceFromAnswer({ optionId: "confirmed", text: "extra context" })).toBe(true);
  });

  it("is false when the person picks the Exclude option, even with accompanying free text", () => {
    expect(hasEvidenceFromAnswer({ optionId: "excluded" })).toBe(false);
    expect(hasEvidenceFromAnswer({ optionId: "excluded", text: "I don't actually stand by this" })).toBe(false);
  });

  it("is true for a non-blank freeform-only answer (R6's exact bug: this used to be false)", () => {
    expect(hasEvidenceFromAnswer({ text: "I ran this migration myself, from a system-of-record dashboard." })).toBe(true);
    expect(hasEvidenceFromAnswer({ optionId: undefined, text: "confirmed" })).toBe(true);
  });

  it("is false for a blank or whitespace-only freeform answer", () => {
    expect(hasEvidenceFromAnswer({})).toBe(false);
    expect(hasEvidenceFromAnswer({ text: "" })).toBe(false);
    expect(hasEvidenceFromAnswer({ text: "   " })).toBe(false);
  });
});
