import { describe, expect, it } from "vitest";
import { careerProfileSchema } from "../src/career-profile";
import { SOURCE_CATEGORIES } from "../src/source";
import migration from "./0001-career-profile-backfill-arrays";
import type { MigrationFileIO } from "./types";

function emptySources() {
  return Object.fromEntries(SOURCE_CATEGORIES.map((c) => [c, { status: "not_applicable" as const }]));
}

/** A synthetic "before" fixture: a profile shaped like it predates `presentation`/`revisions` — both required by the current, `.strict()` careerProfileSchema, so a real 0.1.0-written file never actually looks like this; the fixture stands in for a hypothetical earlier shape, which is what a migration test proves against. */
function preMigrationProfile(): Record<string, unknown> {
  return {
    claims: [],
    sources: emptySources(),
    preferences: [],
    boundaries: [],
    approval: null,
    // presentation and revisions: absent.
  };
}

/** An in-memory MigrationFileIO: exactly the seam `runner/upgrade/migrate.ts` implements over the real workspace, staging writes without touching disk. */
function memoryIO(initial: Record<string, unknown> = {}): MigrationFileIO & { files: Record<string, unknown> } {
  const files: Record<string, unknown> = { ...initial };
  return {
    files,
    async readJson(path) {
      return files[path];
    },
    async writeJson(path, value) {
      files[path] = value;
    },
  };
}

describe("0001-career-profile-backfill-arrays", () => {
  it("names 0.1.0 -> 0.2.0", () => {
    expect(migration.from).toBe("0.1.0");
    expect(migration.to).toBe("0.2.0");
  });

  it("is a no-op when there is no career-profile.json yet", async () => {
    const io = memoryIO();
    await migration.migrate(io);
    expect(io.files["career-profile.json"]).toBeUndefined();
  });

  it("backfills presentation and revisions as [] on a profile missing them, producing a schema-valid profile", async () => {
    const io = memoryIO({ "career-profile.json": preMigrationProfile() });
    await migration.migrate(io);
    const migrated = io.files["career-profile.json"];
    expect(migrated).toMatchObject({ presentation: [], revisions: [] });
    expect(careerProfileSchema.safeParse(migrated).success).toBe(true);
  });

  it("never touches a profile's other fields", async () => {
    const before: Record<string, unknown> = { ...preMigrationProfile(), boundaries: [{ id: "b1b2c3d4-58cc-4372-a567-0e02b2c3d479", text: "Never invent a metric" }] };
    const io = memoryIO({ "career-profile.json": before });
    await migration.migrate(io);
    const migrated = io.files["career-profile.json"] as Record<string, unknown>;
    expect(migrated.boundaries).toEqual(before.boundaries);
    expect(migrated.claims).toEqual(before.claims);
    expect(migrated.sources).toEqual(before.sources);
  });

  it("is a no-op on a profile that already has both arrays", async () => {
    const already = { ...preMigrationProfile(), presentation: [], revisions: [] };
    const io = memoryIO({ "career-profile.json": already });
    await migration.migrate(io);
    expect(io.files["career-profile.json"]).toEqual(already);
  });

  it("is idempotent: running it a second time on its own output changes nothing further", async () => {
    const io = memoryIO({ "career-profile.json": preMigrationProfile() });
    await migration.migrate(io);
    const onceMigrated = io.files["career-profile.json"];
    await migration.migrate(io);
    expect(io.files["career-profile.json"]).toEqual(onceMigrated);
  });

  it("refuses (throws) rather than guessing when career-profile.json is not a JSON object", async () => {
    const io = memoryIO({ "career-profile.json": "not an object" });
    await expect(migration.migrate(io)).rejects.toThrow(/not a JSON object/);
  });
});
