import { describe, expect, it } from "vitest";
import { workspaceManifestSchema } from "./workspace";

function validManifest() {
  return {
    workspaceId: "ada-quill-workspace",
    workflowInstanceId: "job-assistant-instance-1",
    packageVersion: "0.1.0",
    createdAt: new Date().toISOString(),
  };
}

describe("workspaceManifestSchema", () => {
  it("accepts a valid manifest", () => {
    expect(workspaceManifestSchema.safeParse(validManifest()).success).toBe(true);
  });

  it("rejects a non-semver packageVersion", () => {
    expect(workspaceManifestSchema.safeParse({ ...validManifest(), packageVersion: "v1" }).success).toBe(
      false,
    );
  });

  it("rejects an unknown top-level key (strict)", () => {
    expect(workspaceManifestSchema.safeParse({ ...validManifest(), providerApiKey: "sk-..." }).success).toBe(
      false,
    );
  });
});
