import { jobStructuredSchema, uuidSchema } from "@workflow-catalog/contracts";
import { z } from "zod";

/**
 * `extract_job`'s input/output shape and description. Directive-free, so
 * both tool roots (`agent/` and `eval-agent/agent/`) import it — directives
 * compile per app root, and only directive-free modules can be shared across
 * roots (docs/spec/research/eve-runtime.md §8 item 14). The persist logic is
 * shared the same way, via `extract-job-logic.ts`.
 *
 * Model tools take IDs only (iter-003 decision): the input is the snapshot's
 * `jobId`/`revision` — never its url or raw text — plus the structured
 * fields the model drafted after reading the posting text as user-turn data
 * (`captures.ts` delivers that text; it is never placed in a system prompt).
 * `structured` reuses the contract's own `jobStructuredSchema` (job-snapshot.ts)
 * so the tool can never drift from what a `JobSnapshot.structured` may hold.
 */

export const extractJobInputSchema = z
  .object({
    jobId: uuidSchema,
    revision: z.number().int().positive(),
    structured: jobStructuredSchema,
  })
  .strict();

export type ExtractJobInput = z.infer<typeof extractJobInputSchema>;

export const extractJobOutputSchema = z
  .object({
    jobId: uuidSchema,
    revision: z.number().int().positive(),
    /** True only when a snapshot with this exact jobId/revision existed to write onto. */
    persisted: z.boolean(),
    message: z.string(),
  })
  .strict();

export type ExtractJobOutput = z.infer<typeof extractJobOutputSchema>;

export const extractJobToolDescription =
  "Record the structured fields extracted from one job posting snapshot: title, company, location, requirements, niceToHave, deadline, applyUrl. Pass the snapshot's jobId and revision exactly as given in the prompt, and only the fields you actually found in the posting text below them. Omit any field you cannot find; never guess or invent one.";
