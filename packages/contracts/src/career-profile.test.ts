import { describe, expect, it } from "vitest";
import { careerProfileSchema } from "./career-profile";
import { SOURCE_CATEGORIES } from "./source";

function emptySources() {
  return Object.fromEntries(SOURCE_CATEGORIES.map((c) => [c, { status: "not_applicable" as const }]));
}

function minimalProfile() {
  return {
    claims: [],
    sources: emptySources(),
    preferences: [],
    boundaries: [],
    presentation: [],
    approval: null,
    revisions: [],
  };
}

describe("careerProfileSchema", () => {
  it("accepts a freshly-onboarded, not-yet-approved profile", () => {
    expect(careerProfileSchema.safeParse(minimalProfile()).success).toBe(true);
  });

  it("accepts an approved profile with claims, preferences, boundaries, and revisions", () => {
    const profile = {
      ...minimalProfile(),
      claims: [
        {
          id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
          text: "Led the payments infrastructure team",
          kind: "title" as const,
          status: "confirmed" as const,
          source: "resume" as const,
          evidence: { kind: "passage" as const, ref: "resume.md#exp", quote: "Led the payments infrastructure team" },
        },
      ],
      preferences: [{ id: "a1b2c3d4-58cc-4372-a567-0e02b2c3d479", text: "Prefers remote roles" }],
      boundaries: [{ id: "b1b2c3d4-58cc-4372-a567-0e02b2c3d479", text: "Never invent a metric that wasn't confirmed" }],
      presentation: [
        { id: "d1b2c3d4-58cc-4372-a567-0e02b2c3d479", text: "Emphasise backend work for infrastructure roles." },
        { id: "e1b2c3d4-58cc-4372-a567-0e02b2c3d479", text: "Reorder projects by relevance; rewrite bullets, keep meaning." },
      ],
      approval: { version: 1, at: new Date().toISOString() },
      revisions: [
        {
          id: "c1b2c3d4-58cc-4372-a567-0e02b2c3d479",
          summary: "Added a confirmed credential",
          proposedAt: new Date().toISOString(),
          status: "accepted" as const,
          resultingVersion: 2,
          decidedAt: new Date().toISOString(),
        },
      ],
    };
    expect(careerProfileSchema.safeParse(profile).success).toBe(true);
  });

  it("rejects a profile with an incomplete sources accounting", () => {
    const { resume: _resume, ...incompleteSources } = emptySources();
    void _resume;
    expect(careerProfileSchema.safeParse({ ...minimalProfile(), sources: incompleteSources }).success).toBe(
      false,
    );
  });

  it("rejects an unknown top-level key (strict)", () => {
    expect(careerProfileSchema.safeParse({ ...minimalProfile(), notes: "hi" }).success).toBe(false);
  });

  it("rejects approval missing (undefined) rather than explicitly null", () => {
    const { approval: _approval, ...rest } = minimalProfile();
    void _approval;
    expect(careerProfileSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects presentation missing entirely (profile-level wording rules, not a claim status)", () => {
    const { presentation: _presentation, ...rest } = minimalProfile();
    void _presentation;
    expect(careerProfileSchema.safeParse(rest).success).toBe(false);
  });

  it("accepts presentation entries independent of claims — wording rules, not evidence-backed facts", () => {
    const profile = {
      ...minimalProfile(),
      presentation: [{ id: "d1b2c3d4-58cc-4372-a567-0e02b2c3d479", text: "Emphasise backend work for infrastructure roles." }],
    };
    expect(careerProfileSchema.safeParse(profile).success).toBe(true);
  });
});
