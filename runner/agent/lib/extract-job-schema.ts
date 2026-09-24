import { jobStructuredSchema, uuidSchema, type JobStructured } from "@workflow-catalog/contracts";
import type { MessageStreamEvent } from "eve/client";
import { z } from "zod";

/**
 * `extract_job`'s input/output shape and description, and the one reader of
 * its result. Directive-free, so both tool roots (`agent/` and
 * `eval-agent/agent/`), the bridge's capture route and the eval import it:
 * directives compile per app root, and only directive-free modules can be
 * shared across roots (docs/spec/research/eve-runtime.md §8 item 14). The
 * tool's logic is shared the same way, via `extract-job-logic.ts`.
 *
 * Model tools take IDs only (iter-003 decision): the input is the snapshot's
 * `jobId`/`revision`, never its url or raw text, plus the structured fields
 * the model drafted after reading the posting text as user-turn data
 * (`captures.ts` delivers that text; it is never placed in a system prompt).
 * `structured` reuses the contract's own `jobStructuredSchema`
 * (job-snapshot.ts), so the tool can never drift from what a
 * `JobSnapshot.structured` may hold.
 *
 * Round-2 T1: the tool validates the fields and returns them; it never
 * writes. The capture route writes them, from this call's `action.result`
 * (`extractedJobFields` below), and only after the turn ended ok. So a turn
 * that calls the tool and then fails leaves the fields already saved
 * untouched, and a running Re-extract shows the previous fields until it
 * finishes.
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
    /** True when this jobId/revision is a real snapshot currently being extracted and the fields match the contract. Nothing is saved yet either way. */
    accepted: z.boolean(),
    message: z.string(),
    /** The validated fields, present only when `accepted`. */
    structured: jobStructuredSchema.optional(),
  })
  .strict();

export type ExtractJobOutput = z.infer<typeof extractJobOutputSchema>;

export const extractJobToolDescription =
  "Report the structured fields extracted from one job posting snapshot: title, company, location, requirements, niceToHave, deadline, applyUrl. Pass the snapshot's jobId and revision exactly as given in the prompt, and only the fields you actually found in the posting text below them. Omit any field you cannot find; never guess or invent one. The runner saves the fields once this turn finishes.";

/**
 * The fields to save for exactly `jobId`/`revision`, read from a turn's own
 * events: the last `extract_job` call that completed without error and whose
 * output accepted fields for that jobId and revision. Undefined when there is
 * none. It says nothing about whether the turn ended ok: the caller checks
 * that first (a turn that isn't ok saves nothing, whatever its events hold).
 */
export function extractedJobFields(events: readonly MessageStreamEvent[], jobId: string, revision: number): JobStructured | undefined {
  let found: JobStructured | undefined;
  for (const event of events) {
    if (event.type !== "action.result" || event.data.status !== "completed") continue;
    const result = event.data.result;
    if (result.kind !== "tool-result" || result.toolName !== "extract_job" || result.isError) continue;
    const output = extractJobOutputSchema.safeParse(result.output);
    if (!output.success || !output.data.accepted || output.data.jobId !== jobId || output.data.revision !== revision || !output.data.structured) continue;
    found = output.data.structured;
  }
  return found;
}
