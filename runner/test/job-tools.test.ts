import { afterEach, beforeEach, describe, expect, it } from "vitest";
import productionExtractJob from "../agent/tools/extract_job.ts";
import evalExtractJob from "../eval-agent/agent/tools/extract_job.ts";
import { JobsStore } from "../store/jobs.ts";
import { newWorkspace } from "./helpers.ts";

/**
 * The `extract_job` tool modules themselves, in both app roots (mirrors P03's
 * `onboarding-tools.test.ts`, V5). Outside eve's build the `"use workflow"`
 * and `"use step"` directives are plain strings, so `execute` runs the real
 * wrappers against a real workspace (`RUNNER_WORKSPACE`, as in production).
 * The eval exercises the eval agent's root through a real turn; this file is
 * what makes a change to either production wrapper itself (not the shared
 * logic, already covered by `extract-job-logic.test.ts`) fail.
 */

type ExtractJobTool = { execute(input: unknown, ctx: unknown): Promise<{ jobId: string; revision: number; persisted: boolean; message: string }> };

const ROOTS = [
  { root: "agent (production)", tool: productionExtractJob as unknown as ExtractJobTool },
  { root: "eval-agent", tool: evalExtractJob as unknown as ExtractJobTool },
];

const previousWorkspace = process.env.RUNNER_WORKSPACE;
let store: JobsStore;

beforeEach(async () => {
  const workspace = await newWorkspace();
  process.env.RUNNER_WORKSPACE = workspace.root;
  store = new JobsStore(workspace);
});

afterEach(() => {
  if (previousWorkspace === undefined) delete process.env.RUNNER_WORKSPACE;
  else process.env.RUNNER_WORKSPACE = previousWorkspace;
});

for (const { root, tool } of ROOTS) {
  describe(`${root}: extract_job`, () => {
    it("persists structured fields onto the real snapshot named by jobId/revision", async () => {
      const { jobId, revision } = await store.captureJob({ url: "https://jobs.example/northwind-labs/staff-platform-engineer", text: "Staff Platform Engineer at Northwind Labs.", extractorVersion: "t", capturedAt: "2026-09-22T09:00:00.000Z" });
      const output = await tool.execute({ jobId, revision, structured: { title: "Staff Platform Engineer", company: "Northwind Labs" } }, {});
      expect(output).toMatchObject({ jobId, revision, persisted: true });
      expect((await store.getSnapshot(jobId, revision))?.structured).toEqual({ title: "Staff Platform Engineer", company: "Northwind Labs" });
    });

    it("reports persisted: false for a jobId that names no real snapshot", async () => {
      const output = await tool.execute({ jobId: "00000000-0000-4000-8000-000000000000", revision: 1, structured: { title: "Ghost role" } }, {});
      expect(output.persisted).toBe(false);
    });
  });
}
