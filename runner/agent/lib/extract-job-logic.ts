import { jobStructuredSchema } from "@workflow-catalog/contracts";
import { JobsStore } from "../../store/jobs.ts";
import { Workspace } from "../../store/workspace.ts";
import type { ExtractJobInput, ExtractJobOutput } from "./extract-job-schema.ts";

/**
 * The behaviour behind `extract_job`: check the fields the model drafted and
 * hand them back. Directive-free, so both tool roots
 * (`agent/tools/extract_job.ts` and `eval-agent/agent/tools/extract_job.ts`)
 * call it from a one-line `"use step"` wrapper
 * (docs/spec/research/eve-runtime.md §8 item 14), and
 * `test/extract-job-logic.test.ts` tests it against a real store.
 *
 * Round-2 T1: this never writes. It only reads, to tell the model whether its
 * call named the revision being extracted: that revision's extraction state
 * must be `running` (the capture route's queue sets it for the one revision it
 * is extracting), its snapshot must be readable, and the fields must match the
 * contract. An accepted result carries the validated fields; the capture route
 * saves them from the turn's events once the turn has ended ok, and only for
 * the exact job and revision it was extracting. A call for any other revision,
 * a stale call, or an id a hostile posting talked the model into inventing is
 * answered `accepted: false`, and the route ignores it either way.
 */
export async function checkExtractedJob(input: ExtractJobInput, store: JobsStore): Promise<ExtractJobOutput> {
  const refused = (message: string): ExtractJobOutput => ({ jobId: input.jobId, revision: input.revision, accepted: false, message });
  const state = await store.getExtractionState(input.jobId, input.revision);
  if (state === undefined || state === "unreadable" || state.status !== "running") return refused("This job isn't currently being extracted.");
  const snapshot = await store.readSnapshot(input.jobId, input.revision);
  if (snapshot.kind !== "ok") return refused(`No readable snapshot revision ${input.revision} for that job.`);
  const structured = jobStructuredSchema.safeParse(input.structured);
  if (!structured.success) return refused("The extracted fields did not match the expected shape.");
  return {
    jobId: input.jobId,
    revision: input.revision,
    accepted: true,
    message: "Fields accepted. The runner saves them when this turn finishes.",
    structured: structured.data,
  };
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
