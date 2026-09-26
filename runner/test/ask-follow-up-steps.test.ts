import { describe, expect, it } from "vitest";
import { checkFollowUpClaimIsOpen, openFollowUpQuestion, recordFollowUpAnswer } from "../agent/lib/ask-follow-up-steps.ts";
import { ManualClock } from "../lib/clock.ts";
import { questionNotes } from "../store/profile-reducer.ts";
import { ProfileStore } from "../store/profile.ts";
import { newWorkspace } from "./helpers.ts";

/**
 * V5 (P03 revision 2): `ask_follow_up`'s step bodies, now directive-free
 * helpers both tool roots call from one-line `"use step"` wrappers, tested
 * against a real store with no eve runtime. D10's rule is checked here at the
 * store: free text leaves the claim disputed, with the text as a note.
 */

async function metricClaim(): Promise<{ store: ProfileStore; claimId: string }> {
  const clock = new ManualClock();
  const store = new ProfileStore(await newWorkspace(clock), clock);
  await store.accountSource("resume", "provided");
  const extracted = await store.extractClaims("resume", [
    { text: "Cut the Harbor release time from a day to under an hour.", kind: "metric", evidenceRef: "resume.md#harbor", evidenceQuote: "from a day to under an hour" },
  ]);
  return { store, claimId: extracted.profile.claims[0]!.id };
}

describe("checkFollowUpClaimIsOpen", () => {
  it("allows a candidate or disputed claim, and refuses a missing or decided one", async () => {
    const { store, claimId } = await metricClaim();
    await expect(checkFollowUpClaimIsOpen(store, claimId)).resolves.toBeUndefined();
    await expect(checkFollowUpClaimIsOpen(store, "6f1d2c1e-0000-4000-8000-000000000000")).rejects.toThrow("No claim 6f1d2c1e-0000-4000-8000-000000000000 in the career profile.");
    await store.decideClaim(claimId, "excluded");
    await expect(checkFollowUpClaimIsOpen(store, claimId)).rejects.toThrow("already has a decision (excluded)");
  });
});

describe("openFollowUpQuestion", () => {
  it("marks the claim disputed with the model's question", async () => {
    const { store, claimId } = await metricClaim();
    await openFollowUpQuestion(store, claimId, "Measured against what?");
    const claim = (await store.read()).claims[0]!;
    expect(claim.status).toBe("disputed");
    expect(claim.question).toBe("Measured against what?");
  });
});

describe("recordFollowUpAnswer (D10)", () => {
  it("confirms on the Confirm option, with the person's words as statement evidence", async () => {
    const { store, claimId } = await metricClaim();
    await openFollowUpQuestion(store, claimId, "Measured against what?");
    const output = await recordFollowUpAnswer(store, claimId, { optionId: "confirmed", text: "From the Harbor deploy dashboard." });
    expect(output.status).toBe("confirmed");
    const claim = (await store.read()).claims[0]!;
    expect(claim.status).toBe("confirmed");
    expect(claim.evidence).toMatchObject({ kind: "statement", quote: "From the Harbor deploy dashboard." });
  });

  it("excludes on the Exclude option", async () => {
    const { store, claimId } = await metricClaim();
    await openFollowUpQuestion(store, claimId, "Measured against what?");
    const output = await recordFollowUpAnswer(store, claimId, { optionId: "excluded" });
    expect(output.status).toBe("excluded");
    expect((await store.read()).claims[0]!.status).toBe("excluded");
  });

  it("leaves the claim open on each of the round-2 probe answers, keeping each as a note, and tells the model so", async () => {
    const { store, claimId } = await metricClaim();
    await openFollowUpQuestion(store, claimId, "Measured against what?");
    for (const text of ["No, I can't back that number up.", "exclude", "what do you mean?"]) {
      const output = await recordFollowUpAnswer(store, claimId, { text });
      expect(output).toEqual({
        claimId,
        status: "open",
        message:
          "The claim stays open. The person replied without choosing Confirm or Exclude, so nothing was decided; their reply is saved as a note on the question. Do not describe the claim as confirmed or excluded.",
      });
    }
    const profile = await store.read();
    expect(profile.claims[0]!.status).toBe("disputed");
    expect(profile.claims[0]!.question).toBe("Measured against what?");
    expect(questionNotes(profile)[claimId]?.map((note) => note.text)).toEqual(["No, I can't back that number up.", "exclude", "what do you mean?"]);
  });

  it("changes nothing for an empty answer", async () => {
    const { store, claimId } = await metricClaim();
    await openFollowUpQuestion(store, claimId, "Measured against what?");
    const before = await store.read();
    const output = await recordFollowUpAnswer(store, claimId, {});
    expect(output.status).toBe("open");
    expect(await store.read()).toEqual(before);
  });
});
