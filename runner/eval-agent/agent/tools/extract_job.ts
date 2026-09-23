import { defineWorkflowTool } from "eve/tools";
import { openJobsStore, persistExtractedJob } from "../../../agent/lib/extract-job-logic.ts";
import { extractJobInputSchema, extractJobOutputSchema, extractJobToolDescription, type ExtractJobInput, type ExtractJobOutput } from "../../../agent/lib/extract-job-schema.ts";

// The eval agent's own thin wrapper around the shared extract_job logic.
// Directives compile per app root (docs/spec/research/eve-runtime.md §8 item
// 14): within one root, imports of "use workflow" executors and step modules
// work; across roots, a re-exported workflow tool fails discovery and an
// imported step fails at run time. So this root keeps its own executor and a
// one-line step wrapper that calls the directive-free
// runner/agent/lib/extract-job-logic.ts, exactly as
// runner/agent/tools/extract_job.ts does. The logic is never copied here.

async function persistJob(input: ExtractJobInput): Promise<ExtractJobOutput> {
  "use step";
  return persistExtractedJob(input, await openJobsStore());
}

export default defineWorkflowTool({
  description: extractJobToolDescription,
  inputSchema: extractJobInputSchema,
  outputSchema: extractJobOutputSchema,
  async execute(input) {
    "use workflow";
    return persistJob(input);
  },
});
