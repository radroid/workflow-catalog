import { JobsStore } from "../../store/jobs.ts";
import { Workspace } from "../../store/workspace.ts";
import type { ExtractJobInput, ExtractJobOutput } from "./extract-job-schema.ts";

/**
 * The persist behaviour behind `extract_job`: writes `structured` onto the
 * snapshot named by `jobId`/`revision`, or reports why it could not
 * (`JobsStore.recordStructured`, `store/jobs.ts`). Directive-free, so both
 * tool roots (`agent/tools/extract_job.ts` and
 * `eval-agent/agent/tools/extract_job.ts`) call it from a one-line `"use
 * step"` wrapper (docs/spec/research/eve-runtime.md §8 item 14), and
 * `test/extract-job-logic.test.ts` tests it against a real store.
 */
export async function persistExtractedJob(input: ExtractJobInput, store: JobsStore): Promise<ExtractJobOutput> {
  const result = await store.recordStructured(input.jobId, input.revision, input.structured);
  return { jobId: input.jobId, revision: input.revision, persisted: result.ok, message: result.message };
}

/**
 * Opens the jobs store against the runner's live workspace
 * (`process.env.RUNNER_WORKSPACE`), exactly the pattern
 * `agent/lib/onboarding-store.ts`'s `openStore` uses for the career profile.
 * Directive-free, so either app root can import it.
 */
export async function openJobsStore(): Promise<JobsStore> {
  const dir = process.env.RUNNER_WORKSPACE;
  if (!dir) throw new Error("RUNNER_WORKSPACE is not set; the runner launcher sets it before the agent starts.");
  const workspace = await Workspace.open(dir);
  return new JobsStore(workspace);
}
