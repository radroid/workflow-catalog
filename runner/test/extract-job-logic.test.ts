import { describe, expect, it } from "vitest";
import { persistExtractedJob } from "../agent/lib/extract-job-logic.ts";
import { JobsStore } from "../store/jobs.ts";
import { newWorkspace } from "./helpers.ts";

/**
 * `persistExtractedJob` is the persist logic both `agent/tools/extract_job.ts`
 * and `eval-agent/agent/tools/extract_job.ts` share (a thin `"use step"`
 * wrapper in each calls straight into this). Directive-free, so it is tested
 * directly here with a real `JobsStore` over a temp workspace — no eve
 * runtime, no `RUNNER_WORKSPACE` (P03's `extract-claims-logic.test.ts` is the
 * pattern this mirrors).
 */

async function newStore(): Promise<JobsStore> {
  return new JobsStore(await newWorkspace());
}

describe("persistExtractedJob", () => {
  it("persists structured fields onto the named snapshot and reports success", async () => {
    const store = await newStore();
    const { jobId, revision } = await store.captureJob({ url: "https://jobs.example/northwind-labs/staff-platform-engineer", text: "Staff Platform Engineer at Northwind Labs.", extractorVersion: "t", capturedAt: "2026-09-22T09:00:00.000Z" });

    const output = await persistExtractedJob({ jobId, revision, structured: { title: "Staff Platform Engineer", company: "Northwind Labs" } }, store);
    expect(output).toEqual({ jobId, revision, persisted: true, message: "Saved the extracted fields." });

    const snapshot = await store.getSnapshot(jobId, revision);
    expect(snapshot?.structured).toEqual({ title: "Staff Platform Engineer", company: "Northwind Labs" });
  });

  it("reports persisted: false for an id that names no real snapshot — never invents one", async () => {
    const store = await newStore();
    const output = await persistExtractedJob({ jobId: "00000000-0000-4000-8000-000000000000", revision: 1, structured: { title: "Ghost role" } }, store);
    expect(output.persisted).toBe(false);
    expect(output.message).toMatch(/no snapshot/i);
  });

  it("is safe to call twice with the same fields (idempotent overwrite, not an error)", async () => {
    const store = await newStore();
    const { jobId, revision } = await store.captureJob({ url: "https://jobs.example/harbor/platform-engineer", text: "Platform Engineer at Harbor.", extractorVersion: "t", capturedAt: "2026-09-22T09:00:00.000Z" });
    const structured = { title: "Platform Engineer", company: "Harbor" };
    const first = await persistExtractedJob({ jobId, revision, structured }, store);
    const second = await persistExtractedJob({ jobId, revision, structured }, store);
    expect(first.persisted).toBe(true);
    expect(second.persisted).toBe(true);
    expect((await store.getSnapshot(jobId, revision))?.structured).toEqual(structured);
  });
});
