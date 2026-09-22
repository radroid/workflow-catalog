import { describe, expect, it } from "vitest";
import { claimSchema } from "./claim";

function validClaim() {
  return {
    id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    text: "Led the payments infrastructure team at Northwind Labs",
    kind: "title" as const,
    status: "confirmed" as const,
    source: "resume" as const,
    evidence: {
      kind: "passage" as const,
      ref: "resume.md#experience-northwind-labs",
      quote: "Led the payments infrastructure team at Northwind Labs",
    },
  };
}

describe("claimSchema", () => {
  it("accepts a minimal confirmed claim", () => {
    expect(claimSchema.safeParse(validClaim()).success).toBe(true);
  });

  it("accepts a candidate claim with an open question", () => {
    const claim = {
      ...validClaim(),
      status: "candidate" as const,
      question: "You wrote \"grew signups 500%\" — what's that measured against, and over what period?",
    };
    expect(claimSchema.safeParse(claim).success).toBe(true);
  });

  it("rejects a missing required field", () => {
    const { source: _source, ...rest } = validClaim();
    void _source;
    expect(claimSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects an unknown top-level key (strict)", () => {
    const claim = { ...validClaim(), confidence: 0.9 };
    expect(claimSchema.safeParse(claim).success).toBe(false);
  });

  it("rejects an unknown evidence key (strict)", () => {
    const claim = validClaim();
    const withExtra = { ...claim, evidence: { ...claim.evidence, verified: true } };
    expect(claimSchema.safeParse(withExtra).success).toBe(false);
  });

  it("rejects an invalid kind", () => {
    expect(claimSchema.safeParse({ ...validClaim(), kind: "achievement" }).success).toBe(false);
  });

  it("rejects an invalid status", () => {
    expect(claimSchema.safeParse({ ...validClaim(), status: "verified" }).success).toBe(false);
  });

  it("rejects a source outside the seven categories", () => {
    expect(claimSchema.safeParse({ ...validClaim(), source: "linkedin" }).success).toBe(false);
  });

  it("rejects an empty text", () => {
    expect(claimSchema.safeParse({ ...validClaim(), text: "" }).success).toBe(false);
  });
});
