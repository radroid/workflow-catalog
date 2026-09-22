import { describe, expect, it } from "vitest";
import { sessionManifestSchema } from "./session";

function validManifest() {
  return {
    sessionId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    title: "Apply today",
    items: [
      {
        taskId: "0d3a4b0e-58cc-4372-a567-0e02b2c3d479",
        jobRevision: 3,
        url: "https://jobs.example/apply/123",
      },
    ],
    createdAt: new Date().toISOString(),
  };
}

describe("sessionManifestSchema", () => {
  it("accepts a valid manifest", () => {
    expect(sessionManifestSchema.safeParse(validManifest()).success).toBe(true);
  });

  it("rejects an empty items list", () => {
    expect(sessionManifestSchema.safeParse({ ...validManifest(), items: [] }).success).toBe(false);
  });

  it("rejects a non-http url in an item", () => {
    const bad = { ...validManifest(), items: [{ ...validManifest().items[0], url: "file:///etc/passwd" }] };
    expect(sessionManifestSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown top-level key (strict)", () => {
    expect(sessionManifestSchema.safeParse({ ...validManifest(), status: "open" }).success).toBe(false);
  });
});
