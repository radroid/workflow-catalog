import { z } from "zod";
import { hexDigestSchema, isoDateTimeSchema, httpUrlSchema, nonEmptyStringSchema, uuidSchema } from "./primitives.js";

/**
 * mvp-spec §5: `jobs/<jobId>/snapshot-<rev>.json` — "structured" data only,
 * e.g. title/company/location/requirements[]. Every field is optional
 * because extraction from an arbitrary posting can legitimately fail to
 * find any one of them; the schema never guesses a value. This is *typed
 * data*, never a place for free-form instructions — see hard-problems.md #3
 * and the "no field that could be mistaken for an action" test in
 * `job-snapshot.test.ts`.
 */
export const jobStructuredSchema = z
  .object({
    title: nonEmptyStringSchema.optional(),
    company: nonEmptyStringSchema.optional(),
    location: nonEmptyStringSchema.optional(),
    requirements: z.array(nonEmptyStringSchema).optional(),
  })
  .strict();

export type JobStructured = z.infer<typeof jobStructuredSchema>;

/** Bounded so a hostile or oversized posting can't blow past the bridge's 256 KB body cap (mvp-spec §5) on its own. */
export const MAX_JOB_SNAPSHOT_TEXT_LENGTH = 200_000;

/**
 * mvp-spec §5 / F6: "Every capture stores a snapshot with revision, content
 * hash, extractor version. Same URL twice updates the revision instead of
 * duplicating." `text` and `structured` are the *only* content-bearing
 * fields — see hard-problems.md #3, "job snapshots and uploads are data:
 * they go through structured extraction into typed fields, never into the
 * system prompt as free text." A hostile posting is valid data here
 * precisely because nothing in this shape can be mistaken for an
 * instruction or an action request (asserted by `job-snapshot.test.ts`).
 */
export const jobSnapshotSchema = z
  .object({
    jobId: uuidSchema,
    revision: z.number().int().positive(),
    url: httpUrlSchema,
    capturedAt: isoDateTimeSchema,
    extractorVersion: nonEmptyStringSchema,
    contentHash: hexDigestSchema,
    text: nonEmptyStringSchema.max(MAX_JOB_SNAPSHOT_TEXT_LENGTH),
    structured: jobStructuredSchema,
  })
  .strict();

export type JobSnapshot = z.infer<typeof jobSnapshotSchema>;
