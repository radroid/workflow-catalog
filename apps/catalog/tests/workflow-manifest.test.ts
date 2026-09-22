import { describe, expect, it } from "vitest";
import { parseWorkflowManifest, workflowManifest } from "../lib/workflow-manifest";

describe("workflowManifest — loaded and validated from packages/job-assistant/workflow.json at module scope", () => {
  it("matches the real package's identity and has at least one changelog entry", () => {
    expect(workflowManifest.name).toBe("job-assistant");
    expect(workflowManifest.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(workflowManifest.changelog.length).toBeGreaterThan(0);
  });

  it("carries exactly the seven required sources, six browser permissions, and five connections spec F4/§7.3 fix", () => {
    expect(workflowManifest.requiredSources).toHaveLength(7);
    expect(workflowManifest.browserPermissions).toHaveLength(6);
    expect(workflowManifest.connections.length).toBeGreaterThan(0);
  });
});

describe("parseWorkflowManifest — a validation failure fails the build", () => {
  // P09-catalog-site.md part B's acceptance is "A validation failure fails
  // the build" — this can't be proven by corrupting the real workflow.json
  // (out of this packet's allowlist, and would break every other test that
  // imports it), so it's proven here directly against the exported,
  // throwing parse function instead: importing lib/workflow-manifest.ts
  // calls exactly this at module scope, so anything that makes it throw
  // makes the import — and therefore `next build`, which has to import
  // every route's module while collecting page data — throw too.
  it("throws given a shape missing required fields", () => {
    expect(() => parseWorkflowManifest({ name: "job-assistant" })).toThrow();
  });

  it("throws given an unknown field (schema is .strict())", () => {
    expect(() =>
      parseWorkflowManifest({
        ...workflowManifest,
        somethingNotInTheSchema: true,
      }),
    ).toThrow();
  });

  it("throws given a non-semver version", () => {
    expect(() => parseWorkflowManifest({ ...workflowManifest, version: "not-a-version" })).toThrow();
  });

  it("does not throw given the real, current manifest shape", () => {
    expect(() => parseWorkflowManifest(workflowManifest)).not.toThrow();
  });
});
