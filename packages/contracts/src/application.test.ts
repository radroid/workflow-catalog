import { describe, expect, it } from "vitest";
import { applicationSchema } from "./application";

function validApplication() {
  return {
    taskId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    jobId: "0d3a4b0e-58cc-4372-a567-0e02b2c3d479",
    stage: "saved" as const,
    revision: 1,
    documents: [],
    notes: "",
    deadlines: [],
    processing: { status: "idle" as const },
  };
}

describe("applicationSchema", () => {
  it("accepts a freshly-saved application", () => {
    expect(applicationSchema.safeParse(validApplication()).success).toBe(true);
  });

  it("accepts a prepared application with documents and a deadline", () => {
    const app = {
      ...validApplication(),
      stage: "ready" as const,
      documents: [
        {
          kind: "resume" as const,
          version: 1,
          format: "pdf" as const,
          path: "resume-v1.pdf",
          createdAt: new Date().toISOString(),
          profileVersion: 1,
          jobRevision: 1,
          idempotencyKey: "prep-run-1",
        },
      ],
      deadlines: [{ label: "Application closes", at: new Date().toISOString() }],
    };
    expect(applicationSchema.safeParse(app).success).toBe(true);
  });

  // F8: "Processing state (a failed run) is shown separately and never
  // moves the stage" — the schema makes this true by construction: there is
  // no stage value a failed run could set, so this just proves a failed
  // `processing` co-exists with any stage, including one that never
  // advanced past "saved".
  it("a failed processing run leaves stage untouched at the type level", () => {
    const app = {
      ...validApplication(),
      stage: "saved" as const,
      processing: { status: "failed" as const, runId: "1b1b1b1b-58cc-4372-a567-0e02b2c3d479", error: "model call timed out" },
    };
    const result = applicationSchema.safeParse(app);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stage).toBe("saved");
      expect(result.data.processing.status).toBe("failed");
    }
  });

  it("rejects an invalid stage", () => {
    expect(applicationSchema.safeParse({ ...validApplication(), stage: "submitted" }).success).toBe(false);
  });

  it("rejects an unknown top-level key (strict)", () => {
    expect(applicationSchema.safeParse({ ...validApplication(), company: "Northwind Labs" }).success).toBe(
      false,
    );
  });

  it("rejects a document with an unknown key (strict)", () => {
    const app = validApplication();
    const badDoc = {
      kind: "resume" as const,
      version: 1,
      format: "pdf" as const,
      path: "resume-v1.pdf",
      createdAt: new Date().toISOString(),
      profileVersion: 1,
      jobRevision: 1,
      idempotencyKey: "prep-run-1",
      checksum: "abc123",
    };
    expect(applicationSchema.safeParse({ ...app, documents: [badDoc] }).success).toBe(false);
  });
});
