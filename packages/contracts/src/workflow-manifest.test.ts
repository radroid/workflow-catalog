import { describe, expect, it } from "vitest";
import { SOURCE_CATEGORIES } from "./source";
import {
  BROWSER_PERMISSIONS,
  WORKFLOW_ACTIONS,
  workflowManifestSchema,
} from "./workflow-manifest";

function validManifest() {
  return {
    name: "job-assistant",
    version: "0.1.0",
    description: "Prepare and track job applications from confirmed claims.",
    requiredSources: [...SOURCE_CATEGORIES],
    connections: ["file_upload", "pasted_text", "url_import", "github", "social_export_files"] as const,
    browserPermissions: [...BROWSER_PERMISSIONS],
    actions: [...WORKFLOW_ACTIONS],
    schemas: ["claim.schema.json", "job-snapshot.schema.json"],
    adapters: ["eve"] as const,
    changelog: [{ version: "0.1.0", date: "2026-09-22", notes: ["Initial package."] }],
  };
}

describe("workflowManifestSchema", () => {
  it("accepts the real package shape", () => {
    const result = workflowManifestSchema.safeParse(validManifest());
    expect(result.success).toBe(true);
  });

  it("rejects a non-semver version", () => {
    expect(workflowManifestSchema.safeParse({ ...validManifest(), version: "1.0" }).success).toBe(false);
  });

  it("rejects a permission outside the allowlisted six", () => {
    const bad = { ...validManifest(), browserPermissions: [...BROWSER_PERMISSIONS, "debugger"] };
    expect(workflowManifestSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an action outside the allowlisted three", () => {
    const bad = { ...validManifest(), actions: [...WORKFLOW_ACTIONS, "submit_application"] };
    expect(workflowManifestSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a second adapter — non-goal is exactly one runtime adapter", () => {
    const bad = { ...validManifest(), adapters: ["eve", "langchain"] };
    expect(workflowManifestSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects duplicate entries in an allowlist array", () => {
    const bad = { ...validManifest(), actions: ["capture_job", "capture_job", "open_application_group"] };
    expect(workflowManifestSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an empty changelog", () => {
    expect(workflowManifestSchema.safeParse({ ...validManifest(), changelog: [] }).success).toBe(false);
  });

  it("rejects an unknown top-level key (strict)", () => {
    expect(workflowManifestSchema.safeParse({ ...validManifest(), checksum: "sha256-abc" }).success).toBe(
      false,
    );
  });
});
