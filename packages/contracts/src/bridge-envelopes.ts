import { z } from "zod";
import { httpUrlSchema, isoDateTimeSchema, nonEmptyStringSchema, protocolVersionSchema, uuidSchema } from "./primitives.js";

/**
 * The four bridge envelopes, shaped per
 * `docs/spec/research/browser-boundary.md` ("Minimal protocol contract").
 * Every envelope carries `protocol: 1` (mvp-spec §5).
 *
 * `deviceId` is deliberately absent from the three `/events` envelopes
 * (`JobCapture`, `BrowserCommandResult`, `ApplicationStatusChanged`): per
 * mvp-spec §5, "Every request: `Authorization: Bearer <device token>`" —
 * the bridge derives the sending device from the authenticated request, not
 * from a client-supplied body field ("Server derives identity from
 * authentication" — browser-boundary.md, "Minimal protocol contract"). A
 * body-level `deviceId` the server merely trusted would let one paired
 * device claim to be another. `OpenApplicationGroup` is the one envelope
 * that flows the other direction (runner → extension) and browser-boundary.md's
 * own illustrative JSON includes `deviceId` there, so it is kept.
 */

/** browser-boundary.md's acceptance gates require rejecting "unknown or partial results" and an oversized group; picked to comfortably cover a single day's applications while staying well short of a runaway group. */
export const MAX_APPLICATION_GROUP_SIZE = 20;

export const openApplicationGroupItemSchema = z
  .object({
    taskId: uuidSchema,
    jobRevision: z.number().int().positive(),
    url: httpUrlSchema,
  })
  .strict();
export type OpenApplicationGroupItem = z.infer<typeof openApplicationGroupItemSchema>;

export const openApplicationGroupPayloadSchema = z
  .object({
    title: nonEmptyStringSchema,
    items: z.array(openApplicationGroupItemSchema).min(1).max(MAX_APPLICATION_GROUP_SIZE),
  })
  .strict();
export type OpenApplicationGroupPayload = z.infer<typeof openApplicationGroupPayloadSchema>;

/**
 * Runner → extension command. browser-boundary.md: "Allowlisted commands
 * are capture after local invocation, open approved group, and report
 * explicit status" — this is "open approved group." `workflowVersion`
 * mirrors browser-boundary.md's example (`"job-assistant@1"`): the package
 * name plus its major version, so the extension can refuse a command from a
 * package major version it doesn't understand.
 */
export const openApplicationGroupSchema = z
  .object({
    protocol: protocolVersionSchema,
    type: z.literal("open_application_group"),
    commandId: uuidSchema,
    deviceId: uuidSchema,
    sessionId: uuidSchema,
    workflowVersion: nonEmptyStringSchema,
    expiresAt: isoDateTimeSchema,
    payload: openApplicationGroupPayloadSchema,
  })
  .strict();

export type OpenApplicationGroup = z.infer<typeof openApplicationGroupSchema>;

/**
 * Extension → runner event (posted to `POST /events`). "Report explicit
 * status" for a command: what happened when the extension tried to act on
 * an `OpenApplicationGroup`. `status` is the overall outcome;
 * `items[].status` is per task, since a group can partially succeed
 * (browser-boundary.md acceptance gate: "Unknown or partial results require
 * review").
 */
export const browserCommandResultStatusSchema = z.enum(["completed", "failed", "partial"]);
export type BrowserCommandResultStatus = z.infer<typeof browserCommandResultStatusSchema>;

export const browserCommandItemStatusSchema = z.enum(["opened", "failed", "skipped"]);
export type BrowserCommandItemStatus = z.infer<typeof browserCommandItemStatusSchema>;

export const browserCommandResultItemSchema = z
  .object({
    taskId: uuidSchema,
    status: browserCommandItemStatusSchema,
  })
  .strict();
export type BrowserCommandResultItem = z.infer<typeof browserCommandResultItemSchema>;

export const browserCommandResultSchema = z
  .object({
    protocol: protocolVersionSchema,
    type: z.literal("browser_command_result"),
    eventId: uuidSchema,
    commandId: uuidSchema,
    status: browserCommandResultStatusSchema,
    items: z.array(browserCommandResultItemSchema).min(1),
    occurredAt: isoDateTimeSchema,
  })
  .strict();

export type BrowserCommandResult = z.infer<typeof browserCommandResultSchema>;

/**
 * Extension → runner event. browser-boundary.md: "Separate `job_capture`
 * carries capture ID, URL, timestamp, bounded text, extractor version, and
 * content hash." No `jobId`/`revision`: the runner — not the extension —
 * owns matching a captured URL to an existing job and deciding whether this
 * is a new job or a new revision of one it already has (F6). This envelope
 * is untrusted *data*: see hard-problems.md #3 and job-snapshot.ts's
 * hostile-content test, which this shape shares its bounded-text
 * reasoning with.
 */
export const MAX_JOB_CAPTURE_TEXT_LENGTH = 200_000;

export const jobCaptureSchema = z
  .object({
    protocol: protocolVersionSchema,
    type: z.literal("job_capture"),
    eventId: uuidSchema,
    url: httpUrlSchema,
    text: nonEmptyStringSchema.max(MAX_JOB_CAPTURE_TEXT_LENGTH),
    extractorVersion: nonEmptyStringSchema,
    contentHash: z.string().regex(/^[0-9a-fA-F]{8,}$/, "must be a hex digest string"),
    occurredAt: isoDateTimeSchema,
  })
  .strict();

export type JobCapture = z.infer<typeof jobCaptureSchema>;

/**
 * Extension → runner event. browser-boundary.md: "Separate
 * `application_status_changed` carries task ID, expected revision, and
 * explicit user-selected status." The side panel's two buttons are
 * "Applied / Deferred" (F9); `status: "deferred"` records that the person
 * chose not to act yet and never advances `Application.stage` — only
 * `"applied"` does. `expectedRevision` is `Application.revision` as the
 * extension last saw it, so the runner can reject a stale write (mvp-spec
 * §5: "stale revisions rejected").
 */
export const applicationStatusChangedStatusSchema = z.enum(["applied", "deferred"]);
export type ApplicationStatusChangedStatus = z.infer<typeof applicationStatusChangedStatusSchema>;

export const applicationStatusChangedSchema = z
  .object({
    protocol: protocolVersionSchema,
    type: z.literal("application_status_changed"),
    eventId: uuidSchema,
    taskId: uuidSchema,
    expectedRevision: z.number().int().positive(),
    status: applicationStatusChangedStatusSchema,
    occurredAt: isoDateTimeSchema,
  })
  .strict();

export type ApplicationStatusChanged = z.infer<typeof applicationStatusChangedSchema>;
