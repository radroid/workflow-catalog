import { z } from "zod";
import {
  boundedHttpUrlSchema,
  httpUrlSchema,
  isoDateTimeSchema,
  MAX_APPLICATION_GROUP_SIZE,
  nonEmptyStringSchema,
  protocolVersionSchema,
  utf8BoundedTextSchema,
  uuidSchema,
} from "./primitives";

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

/**
 * Size caps for the three `POST /events` bodies (`EventsRequest`,
 * bridge-http.ts). With them, every JSON body zod accepts serializes
 * (`JSON.stringify`, UTF-8) to at most `MAX_BRIDGE_BODY_BYTES`
 * (primitives.ts), the bridge's 256 KiB body cap from mvp-spec §5. A body the
 * extension has validated never bounces off that cap.
 *
 * JobCapture is the only body that gets close. Its worst case:
 *
 *     text                200,000 bytes, measured as JSON (quotes included)
 *     url                  12,290 bytes = 2 + 6 × 2,048
 *     extractorVersion        770 bytes = 2 + 6 × 128
 *     contentHash             770 bytes = 2 + 6 × 128
 *     occurredAt              386 bytes = 2 + 6 × 64
 *     everything else         148 bytes (keys, punctuation, protocol, type, eventId)
 *     total               214,364 bytes, under 262,144
 *
 * A string of n UTF-16 code units serializes to at most 2 + 6n bytes: the
 * costliest code unit is a 6-byte escape (`\u0001`, or a lone surrogate).
 * contentHash and occurredAt only admit ASCII, so their real worst cases are
 * smaller. BrowserCommandResult (at most `MAX_APPLICATION_GROUP_SIZE` items)
 * and ApplicationStatusChanged stay under 2 KB. `bridge-body-size.test.ts`
 * recomputes the bound from these exported caps and builds each worst case.
 */
export const MAX_JOB_CAPTURE_TEXT_BYTES = 200_000;
/** UTF-16 code units of the raw `url`, counted before URL parsing (`boundedHttpUrlSchema`, primitives.ts). Room for a posting URL with long tracking parameters. */
export const MAX_JOB_CAPTURE_URL_LENGTH = 2_048;
/** For example `"extractor@0.1.0"`. */
export const MAX_EXTRACTOR_VERSION_LENGTH = 128;
/** 128 hex digits fit a SHA-512 digest; a SHA-256 digest is 64. */
export const MAX_CONTENT_HASH_LENGTH = 128;
/** `z.iso.datetime()` accepts any number of fractional-second digits. `Date#toISOString()` gives 24 characters; nanoseconds plus an offset give 35. */
export const MAX_OCCURRED_AT_LENGTH = 64;

const occurredAtSchema = isoDateTimeSchema.max(MAX_OCCURRED_AT_LENGTH);

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

/**
 * `"closed"`: the person closed the tab themselves without the extension
 * ever observing an applied/deferred action on it. This is informational
 * only — reported so the runner has full visibility into what happened to
 * every task in the group — and, like every `BrowserCommandResultItem`
 * status, it never moves `Application.stage` on its own. Only an explicit
 * `application_status_changed` event with `status: "applied"` does that
 * (see `applicationStatusChangedSchema` below); a closed tab with no
 * status-changed event is exactly the "unknown or partial result" case
 * browser-boundary.md's acceptance gates say requires human review, not an
 * inferred stage transition.
 */
export const browserCommandItemStatusSchema = z.enum(["opened", "failed", "skipped", "closed"]);
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
    /** One entry per task of the `OpenApplicationGroup` command being reported on, so never more than that command could carry. */
    items: z.array(browserCommandResultItemSchema).min(1).max(MAX_APPLICATION_GROUP_SIZE),
    occurredAt: occurredAtSchema,
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
 * reasoning with. Every string is capped; see the size caps above.
 */
export const jobCaptureSchema = z
  .object({
    protocol: protocolVersionSchema,
    type: z.literal("job_capture"),
    eventId: uuidSchema,
    url: boundedHttpUrlSchema(MAX_JOB_CAPTURE_URL_LENGTH),
    text: utf8BoundedTextSchema(MAX_JOB_CAPTURE_TEXT_BYTES),
    extractorVersion: nonEmptyStringSchema.max(MAX_EXTRACTOR_VERSION_LENGTH),
    /** Lowercase hex SHA-256 of `text` as UTF-8: the same digest as `JobSnapshot.contentHash` (job-snapshot.ts). */
    contentHash: z
      .string()
      .regex(/^[0-9a-fA-F]{8,}$/, "must be a hex digest string")
      .max(MAX_CONTENT_HASH_LENGTH),
    occurredAt: occurredAtSchema,
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
    occurredAt: occurredAtSchema,
  })
  .strict();

export type ApplicationStatusChanged = z.infer<typeof applicationStatusChangedSchema>;
