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
 *
 * Round-1 review decision L5 ("the tool validates and the route writes"):
 * before writing anything, this checks that `jobId`/`revision`'s own
 * extraction state is currently `running` — the queue in `captures.ts` sets
 * it to `running` for the one revision it is actually extracting, and back
 * to `done`/`failed` only after this turn finishes. A model call for a
 * revision that isn't (a stale tool call from an already-finished turn, or
 * an id a hostile posting talked the model into inventing) is refused the
 * same way an id that names no real snapshot already was — this is
 * `JobsStore.recordStructured` itself unconditionally accepting any
 * existing jobId/revision (by design: it is also the plain store operation
 * `jobs-store.test.ts` exercises directly with no extraction in flight at
 * all), so the "only while actually being extracted" rule belongs here, one
 * layer up, where the caller is specifically a model turn.
 */
export async function persistExtractedJob(input: ExtractJobInput, store: JobsStore): Promise<ExtractJobOutput> {
  const state = await store.getExtractionState(input.jobId, input.revision);
  if (state?.status !== "running") {
    return { jobId: input.jobId, revision: input.revision, persisted: false, message: "This job isn't currently being extracted." };
  }
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
