import { z } from "zod";
import {
  hexDigestSchema,
  isoDateSchema,
  isoDateTimeSchema,
  httpUrlSchema,
  nonEmptyStringSchema,
  utf8BoundedTextSchema,
  uuidSchema,
} from "./primitives";

/**
 * mvp-spec §5: `jobs/<jobId>/snapshot-<rev>.json` — "structured" data only,
 * e.g. title/company/location/requirements[]. Every field, `niceToHave`
 * included, is optional because extraction from an arbitrary posting can
 * legitimately fail to find any one of them — the same reasoning that lets
 * a hostile or garbled posting extract to `structured: {}` (see
 * `job-snapshot.test.ts`'s hostile-posting test): the schema never guesses
 * a value, and partial or empty extraction is never itself a validation
 * failure. `niceToHave` mirrors `requirements` (a "should have but not
 * required" bucket split from the same qualifications section) and
 * `deadline`/`applyUrl` describe facts that may not exist for a given
 * posting at all (not every posting states a deadline or links a separate
 * apply URL).
 *
 * This is *typed data*, never a place for free-form instructions — see
 * hard-problems.md #3 and the "no field that could be mistaken for an
 * action" test in `job-snapshot.test.ts`.
 */
export const jobStructuredSchema = z
  .object({
    title: nonEmptyStringSchema.optional(),
    company: nonEmptyStringSchema.optional(),
    location: nonEmptyStringSchema.optional(),
    requirements: z.array(nonEmptyStringSchema).optional(),
    niceToHave: z.array(nonEmptyStringSchema).optional(),
    /** The posting's stated application deadline, if any — a calendar date, not a time (postings essentially never state a time of day). Distinct from `Application.deadlines[]` (application.ts), which is the person's own tracked, labeled deadlines and may be copied from here or entered by hand. */
    deadline: isoDateSchema.optional(),
    /** A separate "apply here" URL, when the posting itself is a listing (e.g. an aggregator) that links out to the employer's own application form. Absent when the posting URL (`JobSnapshot.url`) *is* the apply URL. */
    applyUrl: httpUrlSchema.optional(),
  })
  .strict();

export type JobStructured = z.infer<typeof jobStructuredSchema>;

/**
 * Cap on `JobSnapshot.text`, measured the same way as `JobCapture.text`: the
 * UTF-8 bytes of `JSON.stringify(text)`, quotes included
 * (`utf8BoundedTextSchema`, primitives.ts). A snapshot is a workspace file,
 * not a bridge body, so the bridge's 256 KB body cap does not apply to it; the
 * cap that keeps a `POST /events` body under 256 KB is on the JobCapture
 * envelope (bridge-envelopes.ts). This cap equals
 * `MAX_JOB_CAPTURE_TEXT_BYTES`, so text that arrived in a valid JobCapture
 * always fits a snapshot, and pasted or fetched text (F6's other two capture
 * paths) is held to the same limit.
 */
export const MAX_JOB_SNAPSHOT_TEXT_BYTES = 200_000;

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
    text: utf8BoundedTextSchema(MAX_JOB_SNAPSHOT_TEXT_BYTES),
    structured: jobStructuredSchema,
  })
  .strict();

export type JobSnapshot = z.infer<typeof jobSnapshotSchema>;
