import { z } from "zod";
import { isoDateTimeSchema, nonEmptyStringSchema, uuidSchema } from "./primitives";

/**
 * F8: "Local UI board with stages Saved → Preparing → Ready → Applied →
 * Interviewing → Offer / Rejected / Withdrawn."
 */
export const applicationStageSchema = z.enum([
  "saved",
  "preparing",
  "ready",
  "applied",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
]);
export type ApplicationStage = z.infer<typeof applicationStageSchema>;

/**
 * F8: "Processing state (a failed run) is shown separately and never moves
 * the stage." Kept as its own nested object (rather than folded into
 * `stage`) precisely so a failed `runId` can never overwrite `stage` by
 * construction — there is no stage value a processing failure could set.
 */
export const applicationProcessingStatusSchema = z.enum(["idle", "running", "failed"]);
export type ApplicationProcessingStatus = z.infer<typeof applicationProcessingStatusSchema>;

export const applicationProcessingSchema = z
  .object({
    status: applicationProcessingStatusSchema,
    runId: uuidSchema.optional(),
    error: nonEmptyStringSchema.optional(),
  })
  .strict();
export type ApplicationProcessing = z.infer<typeof applicationProcessingSchema>;

/** mvp-spec §5: `applications/<taskId>/docs/ resume-v<n>.md/.docx/.pdf, cover-v<n>.*, diff-v<n>.md`. */
export const applicationDocumentKindSchema = z.enum(["resume", "cover_letter", "diff"]);
export type ApplicationDocumentKind = z.infer<typeof applicationDocumentKindSchema>;

export const applicationDocumentFormatSchema = z.enum(["md", "docx", "pdf"]);
export type ApplicationDocumentFormat = z.infer<typeof applicationDocumentFormatSchema>;

export const applicationDocumentSchema = z
  .object({
    kind: applicationDocumentKindSchema,
    version: z.number().int().positive(),
    format: applicationDocumentFormatSchema,
    /** Workspace-relative path under `applications/<taskId>/docs/`, e.g. `resume-v2.pdf`. */
    path: nonEmptyStringSchema,
    createdAt: isoDateTimeSchema,
    /** F7: "each document records profile version + job revision + idempotency key." */
    profileVersion: z.number().int().positive(),
    jobRevision: z.number().int().positive(),
    idempotencyKey: nonEmptyStringSchema,
  })
  .strict();
export type ApplicationDocument = z.infer<typeof applicationDocumentSchema>;

export const applicationDeadlineSchema = z
  .object({
    label: nonEmptyStringSchema,
    at: isoDateTimeSchema,
  })
  .strict();
export type ApplicationDeadline = z.infer<typeof applicationDeadlineSchema>;

/**
 * mvp-spec §5: `applications/<taskId>.json` — `{ jobId, stage, revision,
 * documents[], notes, deadlines }`. `revision` is this *task's own*
 * optimistic-concurrency counter — incremented on every write to this
 * application record, not the job posting's. `application_status_changed`
 * events carry `expectedRevision` as the extension last saw it, so the
 * runner can reject a stale write (mvp-spec §5: "stale revisions
 * rejected"; see `applicationStatusChangedSchema`, bridge-envelopes.ts).
 *
 * The job-posting revision a given prepared document used is tracked
 * per-document instead, on `ApplicationDocument.jobRevision` below (F6:
 * "the old preparation still says it used revision 1" after the posting
 * changes underneath it) — a single application can hold documents
 * prepared against different `JobSnapshot` revisions over time, so that
 * number cannot live on the application record itself.
 */
export const applicationSchema = z
  .object({
    taskId: uuidSchema,
    jobId: uuidSchema,
    stage: applicationStageSchema,
    revision: z.number().int().positive(),
    documents: z.array(applicationDocumentSchema),
    /** Freeform notes text the person writes; empty string means "no notes yet," not "field absent." */
    notes: z.string(),
    deadlines: z.array(applicationDeadlineSchema),
    processing: applicationProcessingSchema,
  })
  .strict();

export type Application = z.infer<typeof applicationSchema>;
