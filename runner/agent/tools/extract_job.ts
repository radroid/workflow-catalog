import { defineWorkflowTool } from "eve/tools";
import { checkExtractedJob, openJobsStore } from "../lib/extract-job-logic.ts";
import { extractJobInputSchema, extractJobOutputSchema, extractJobToolDescription, type ExtractJobInput, type ExtractJobOutput } from "../lib/extract-job-schema.ts";

/**
 * The tool module eve discovers under `agent/tools/` (P04).
 *
 * Reports one job snapshot's posting text as typed fields. Thin and typed,
 * per the P02 rule (README "Extending the runner" §4) and the iter-003
 * decision (model tools take IDs only): the model never passes a URL or raw
 * posting text here, only the snapshot's `jobId` and `revision`
 * (`captures.ts`'s extraction turn gives it those, and delivers the posting
 * text as user-turn data in the same prompt, never in a system prompt;
 * mvp-spec §7.2, hard-problems.md #3) and the structured fields it drafted
 * from that text. Round-2 T1: it checks and returns the fields and never
 * writes; the capture route saves them after the turn ends ok. Durable
 * (`defineWorkflowTool`).
 *
 * The logic lives in `../lib/extract-job-logic.ts` and the schemas in
 * `../lib/extract-job-schema.ts`, shared with
 * `eval-agent/agent/tools/extract_job.ts`. Directives compile per app root
 * (docs/spec/research/eve-runtime.md §8 item 14): within one root, imports of
 * `"use workflow"` executors and step modules work; across roots, a
 * re-exported workflow tool fails discovery and an imported step fails at
 * run time. So each root keeps this thin executor and a one-line step
 * wrapper, and the logic is written and tested once.
 */

async function checkJob(input: ExtractJobInput): Promise<ExtractJobOutput> {
  "use step";
  return checkExtractedJob(input, await openJobsStore());
}

export default defineWorkflowTool({
  description: extractJobToolDescription,
  inputSchema: extractJobInputSchema,
  outputSchema: extractJobOutputSchema,
  async execute(input) {
    "use workflow";
    return checkJob(input);
  },
});
