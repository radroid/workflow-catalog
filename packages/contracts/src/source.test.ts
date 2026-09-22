import { describe, expect, it } from "vitest";
import { SOURCE_CATEGORIES, sourceCategorySchema, sourceSchema } from "./source";

function fullyAccounted() {
  return {
    resume: { status: "provided" as const },
    previousCoverLetters: { status: "not_applicable" as const },
    portfolioSite: { status: "provided" as const },
    repositories: { status: "provided" as const },
    socialProfiles: { status: "unavailable" as const, note: "export not ready yet" },
    workSamples: { status: "not_applicable" as const },
    targetRolesAndPreferences: { status: "provided" as const },
  };
}

describe("SOURCE_CATEGORIES / sourceCategorySchema", () => {
  it("has exactly the seven F4 categories, and sourceSchema requires exactly those keys", () => {
    expect(SOURCE_CATEGORIES).toHaveLength(7);
    expect(Object.keys(sourceSchema.shape).sort()).toEqual([...SOURCE_CATEGORIES].sort());
  });

  it("sourceCategorySchema accepts every category", () => {
    for (const category of SOURCE_CATEGORIES) {
      expect(sourceCategorySchema.safeParse(category).success).toBe(true);
    }
  });
});

describe("sourceSchema", () => {
  it("accepts a fully-accounted-for source object", () => {
    expect(sourceSchema.safeParse(fullyAccounted()).success).toBe(true);
  });

  // hard-problems.md #1 / F4: "nothing is skipped silently" — omitting even
  // one of the seven categories must fail, not silently default.
  it("rejects an object missing one category", () => {
    const { workSamples: _workSamples, ...rest } = fullyAccounted();
    void _workSamples;
    expect(sourceSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects an unknown top-level key (strict)", () => {
    expect(sourceSchema.safeParse({ ...fullyAccounted(), extraCategory: { status: "provided" } }).success).toBe(
      false,
    );
  });

  it("rejects an invalid status value", () => {
    const bad = { ...fullyAccounted(), resume: { status: "skipped" } };
    expect(sourceSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a status left at its category label with no explicit value (no default)", () => {
    const bad = { ...fullyAccounted(), resume: {} };
    expect(sourceSchema.safeParse(bad).success).toBe(false);
  });
});
