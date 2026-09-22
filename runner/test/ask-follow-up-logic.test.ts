import { describe, expect, it } from "vitest";
import { FOLLOW_UP_OPTIONS, followUpRequest, interpretFollowUpAnswer } from "../agent/lib/ask-follow-up-logic.ts";

/**
 * D10 (P03 revision 2): only an explicit option changes a claim. Revision 1
 * confirmed a claim on any non-blank free text; eve@0.63.0 turns a typed
 * reply that matches no option into free text, so "exclude", "No, I can't
 * back that number up." and "what do you mean?" all confirmed the metric
 * (the round-2 reviewer's probe C). Free text is now a note and nothing more.
 */
describe("interpretFollowUpAnswer", () => {
  it("confirms only on the Confirm option, keeping any text as the person's statement", () => {
    expect(interpretFollowUpAnswer({ optionId: "confirmed" })).toEqual({ kind: "confirm" });
    expect(interpretFollowUpAnswer({ optionId: "confirmed", text: "  From the Harbor deploy dashboard.  " })).toEqual({ kind: "confirm", statement: "From the Harbor deploy dashboard." });
  });

  it("excludes on the Exclude option, whatever text comes with it", () => {
    expect(interpretFollowUpAnswer({ optionId: "excluded" })).toEqual({ kind: "exclude" });
    expect(interpretFollowUpAnswer({ optionId: "excluded", text: "I stand by it after all" })).toEqual({ kind: "exclude" });
  });

  it("never decides on free text alone: the round-2 probe answers are notes", () => {
    for (const text of ["No, I can't back that number up.", "exclude", "what do you mean?", "confirmed", "yes"]) {
      expect(interpretFollowUpAnswer({ text })).toEqual({ kind: "note", text });
    }
  });

  it("does nothing for an empty answer or an option it doesn't know", () => {
    expect(interpretFollowUpAnswer({})).toEqual({ kind: "none" });
    expect(interpretFollowUpAnswer({ text: "   " })).toEqual({ kind: "none" });
    expect(interpretFollowUpAnswer({ optionId: "maybe", text: "Sort of." })).toEqual({ kind: "none" });
  });
});

describe("followUpRequest", () => {
  it("asks the drafted question with exactly two options, and allows free text (kept as a note)", () => {
    const request = followUpRequest("What is this figure measured against?");
    expect(request.prompt).toBe("What is this figure measured against?");
    expect(request.options.map((option) => option.id)).toEqual(["confirmed", "excluded"]);
    expect(request.options).toEqual(FOLLOW_UP_OPTIONS.map((option) => ({ ...option })));
    expect(request.allowFreeform).toBe(true);
  });
});
