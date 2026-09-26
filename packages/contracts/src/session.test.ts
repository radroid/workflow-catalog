import { describe, expect, it } from "vitest";
import { MAX_APPLICATION_GROUP_SIZE } from "./primitives";
import { sessionManifestSchema } from "./session";

function validManifest() {
  return {
    protocol: 1 as const,
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

  it("rejects protocol values other than 1", () => {
    expect(sessionManifestSchema.safeParse({ ...validManifest(), protocol: 2 }).success).toBe(false);
  });

  it("rejects protocol missing entirely", () => {
    const { protocol: _protocol, ...rest } = validManifest();
    void _protocol;
    expect(sessionManifestSchema.safeParse(rest).success).toBe(false);
  });

  it(`rejects more than MAX_APPLICATION_GROUP_SIZE (${MAX_APPLICATION_GROUP_SIZE}) items — matches the OpenApplicationGroup command ceiling it's derived into`, () => {
    const items = Array.from({ length: MAX_APPLICATION_GROUP_SIZE + 1 }, () => ({
      taskId: "0d3a4b0e-58cc-4372-a567-0e02b2c3d479",
      jobRevision: 1,
      url: "https://jobs.example/apply/123",
    }));
    expect(sessionManifestSchema.safeParse({ ...validManifest(), items }).success).toBe(false);
  });

  it(`accepts exactly MAX_APPLICATION_GROUP_SIZE (${MAX_APPLICATION_GROUP_SIZE}) items`, () => {
    const items = Array.from({ length: MAX_APPLICATION_GROUP_SIZE }, () => ({
      taskId: "0d3a4b0e-58cc-4372-a567-0e02b2c3d479",
      jobRevision: 1,
      url: "https://jobs.example/apply/123",
    }));
    expect(sessionManifestSchema.safeParse({ ...validManifest(), items }).success).toBe(true);
  });
});
