import type { MigrationFileIO, WorkspaceMigration } from "./types";

/**
 * Fixture migration for P10-B (F12's "fixtures for a schema migration"; no
 * real 0.2.0 release exists yet — `packages/job-assistant/workflow.json`'s
 * changelog has only 0.1.0 — so this is a demonstration of the mechanism,
 * not a change any shipped code needs). It models a plausible one: an
 * earlier `career-profile.json` that predates the `presentation` and
 * `revisions` arrays (both required, non-optional, in the current
 * `careerProfileSchema`) gets them backfilled as `[]`.
 *
 * Idempotent by construction: a profile that already has both arrays (every
 * profile the current runner writes does) is read and, since neither key is
 * missing, staged back unchanged.
 */
const RELATIVE_PATH = "career-profile.json";

async function migrate(io: MigrationFileIO): Promise<void> {
  const raw = await io.readJson(RELATIVE_PATH);
  if (raw === undefined) return; // No career profile yet (onboarding not reached): nothing to migrate.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${RELATIVE_PATH} is not a JSON object; refusing to guess at its shape.`);
  }
  const profile = raw as Record<string, unknown>;
  const missingPresentation = !Array.isArray(profile.presentation);
  const missingRevisions = !Array.isArray(profile.revisions);
  if (!missingPresentation && !missingRevisions) return; // Already has both: no-op (idempotent).
  await io.writeJson(RELATIVE_PATH, {
    ...profile,
    presentation: missingPresentation ? [] : profile.presentation,
    revisions: missingRevisions ? [] : profile.revisions,
  });
}

const migration: WorkspaceMigration = {
  from: "0.1.0",
  to: "0.2.0",
  description: "Backfill career-profile.json's presentation and revisions arrays for a profile written before they existed.",
  migrate,
};

export default migration;
