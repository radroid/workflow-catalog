import { z } from "zod";
import { isoDateTimeSchema, nonEmptyStringSchema, semverSchema, uuidSchema } from "./primitives.js";
import {
  applicationStatusChangedSchema,
  browserCommandResultSchema,
  jobCaptureSchema,
  openApplicationGroupSchema,
} from "./bridge-envelopes.js";
import { scheduleKindSchema } from "./run.js";

/**
 * mvp-spec §5, "Bridge (runner HTTP on 127.0.0.1:4310, loopback only)":
 *
 * ```
 * POST /pair                 { code } → { deviceId, token }
 * GET  /commands?since=      device-scoped, expiring lease; returns pending open_application_group commands
 * POST /events                job_capture | browser_command_result | application_status_changed
 * GET  /status                { version, workspaceId, budget, schedules }   (no personal data)
 * ```
 *
 * These are the JSON bodies P02's bridge server validates every request
 * against — "JSON schema validated, no other routes" (§5). `since` on
 * `GET /commands` is a query parameter, not a body, so it has no schema
 * here.
 */

/** browser-boundary.md, "Pairing and token handling": a short user code shown by `npm run setup`, 10-minute expiry, single use. Not a UUID — it's meant to be read and typed by a person. */
export const pairRequestSchema = z
  .object({
    code: nonEmptyStringSchema,
  })
  .strict();
export type PairRequest = z.infer<typeof pairRequestSchema>;

/** `token` is the opaque, device-scoped bearer credential (browser-boundary.md: "Issue short-lived, device-scoped access tokens"), not itself a UUID. */
export const pairResponseSchema = z
  .object({
    deviceId: uuidSchema,
    token: nonEmptyStringSchema,
  })
  .strict();
export type PairResponse = z.infer<typeof pairResponseSchema>;

export const commandsResponseSchema = z
  .object({
    commands: z.array(openApplicationGroupSchema),
  })
  .strict();
export type CommandsResponse = z.infer<typeof commandsResponseSchema>;

/**
 * `POST /events` body: a discriminated union on `type`, one of the three
 * bridge event envelopes. mvp-spec §5: "unique eventId; stale revisions
 * rejected" applies to all three via their shared `eventId`
 * (`bridge-envelopes.ts`).
 */
export const eventsRequestSchema = z.discriminatedUnion("type", [
  jobCaptureSchema,
  browserCommandResultSchema,
  applicationStatusChangedSchema,
]);
export type EventsRequest = z.infer<typeof eventsRequestSchema>;

export const budgetStatusSchema = z
  .object({
    dailyRunLimit: z.number().int().nonnegative(),
    runsUsedToday: z.number().int().nonnegative(),
    paused: z.boolean(),
    /** Present when `paused` is true — F11: "exceeding it pauses schedules and says so on the board." */
    pausedReason: nonEmptyStringSchema.optional(),
  })
  .strict();
export type BudgetStatus = z.infer<typeof budgetStatusSchema>;

export const scheduleStatusSchema = z
  .object({
    id: nonEmptyStringSchema,
    kind: scheduleKindSchema,
    paused: z.boolean(),
    nextRunAt: isoDateTimeSchema.optional(),
    lastRunAt: isoDateTimeSchema.optional(),
  })
  .strict();
export type ScheduleStatus = z.infer<typeof scheduleStatusSchema>;

/**
 * `GET /status` — mvp-spec §5 explicitly notes "(no personal data)": every
 * field here is either a version, a run count, or a schedule timestamp,
 * never career or job content.
 */
export const statusResponseSchema = z
  .object({
    version: semverSchema,
    workspaceId: nonEmptyStringSchema,
    budget: budgetStatusSchema,
    schedules: z.array(scheduleStatusSchema),
  })
  .strict();

export type StatusResponse = z.infer<typeof statusResponseSchema>;
