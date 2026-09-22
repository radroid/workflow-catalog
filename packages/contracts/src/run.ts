import { z } from "zod";
import { isoDateTimeSchema, nonEmptyStringSchema, uuidSchema } from "./primitives.js";

/** F10: the two schedules the MVP ships. */
export const scheduleKindSchema = z.enum(["prepare_newly_saved_jobs", "review_open_applications"]);
export type ScheduleKind = z.infer<typeof scheduleKindSchema>;

/**
 * F11: "Every run: kind, inputs, idempotency key, outcome, model, tokens,
 * duration." `kind` is one of the two schedule kinds, or `manual` for a
 * person-triggered run from the board. Kept as a flat enum (rather than
 * deriving from `scheduleKindSchema` via `z.union`) so its JSON Schema is a
 * plain `enum`, not an `anyOf`; `run.test.ts` asserts every
 * `scheduleKindSchema` option is also a `runKindSchema` option so the two
 * can't silently diverge.
 */
export const runKindSchema = z.enum(["prepare_newly_saved_jobs", "review_open_applications", "manual"]);
export type RunKind = z.infer<typeof runKindSchema>;

/**
 * F10/F11 accept: "a run over the cap pauses with a visible reason" —
 * `paused` covers a run that didn't execute because the daily budget was
 * already spent, distinct from a `failure` that did run and errored.
 */
export const runOutcomeSchema = z.enum(["success", "failure", "paused"]);
export type RunOutcome = z.infer<typeof runOutcomeSchema>;

export const runTokenUsageSchema = z
  .object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  })
  .strict();
export type RunTokenUsage = z.infer<typeof runTokenUsageSchema>;

export const runRecordSchema = z
  .object({
    runId: uuidSchema,
    kind: runKindSchema,
    /** CONTEXT.md: "Catch-up run: A scheduled run executed late because the local runner was not available at its scheduled time." */
    isCatchUp: z.boolean(),
    /** Run-kind-specific inputs (e.g. job IDs for a preparation run). Left as an open record — P08 owns the exact per-kind shape. */
    inputs: z.record(z.string(), z.unknown()),
    idempotencyKey: nonEmptyStringSchema,
    outcome: runOutcomeSchema,
    model: nonEmptyStringSchema,
    tokens: runTokenUsageSchema,
    durationMs: z.number().int().nonnegative(),
    startedAt: isoDateTimeSchema,
    finishedAt: isoDateTimeSchema.optional(),
    /** Present when `outcome` is `failure` or `paused`. */
    error: nonEmptyStringSchema.optional(),
  })
  .strict();

export type RunRecord = z.infer<typeof runRecordSchema>;
