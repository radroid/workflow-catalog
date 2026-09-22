import { describe, expect, it } from "vitest";
import {
  applicationStatusChangedSchema,
  browserCommandResultSchema,
  jobCaptureSchema,
  MAX_JOB_CAPTURE_TEXT_BYTES,
  openApplicationGroupSchema,
} from "./bridge-envelopes";
import { MAX_APPLICATION_GROUP_SIZE } from "./primitives";

const uuid1 = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const uuid2 = "0d3a4b0e-58cc-4372-a567-0e02b2c3d479";
const uuid3 = "1b1b1b1b-58cc-4372-a567-0e02b2c3d479";
const now = () => new Date().toISOString();

describe("openApplicationGroupSchema", () => {
  function valid() {
    return {
      protocol: 1 as const,
      type: "open_application_group" as const,
      commandId: uuid1,
      deviceId: uuid2,
      sessionId: uuid3,
      workflowVersion: "job-assistant@1",
      expiresAt: now(),
      payload: {
        title: "Apply today",
        items: [{ taskId: uuid1, jobRevision: 3, url: "https://jobs.example/apply/123" }],
      },
    };
  }

  it("accepts the illustrative shape from browser-boundary.md", () => {
    expect(openApplicationGroupSchema.safeParse(valid()).success).toBe(true);
  });

  it("rejects a wrong protocol version", () => {
    expect(openApplicationGroupSchema.safeParse({ ...valid(), protocol: 2 }).success).toBe(false);
  });

  it("rejects an empty items array", () => {
    const bad = { ...valid(), payload: { ...valid().payload, items: [] } };
    expect(openApplicationGroupSchema.safeParse(bad).success).toBe(false);
  });

  it(`rejects a group over MAX_APPLICATION_GROUP_SIZE (${MAX_APPLICATION_GROUP_SIZE})`, () => {
    const items = Array.from({ length: MAX_APPLICATION_GROUP_SIZE + 1 }, (_, i) => ({
      taskId: uuid1,
      jobRevision: 1,
      url: `https://jobs.example/apply/${i}`,
    }));
    const bad = { ...valid(), payload: { ...valid().payload, items } };
    expect(openApplicationGroupSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a privileged-scheme item url", () => {
    const bad = {
      ...valid(),
      payload: { ...valid().payload, items: [{ taskId: uuid1, jobRevision: 1, url: "chrome://settings" }] },
    };
    expect(openApplicationGroupSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown top-level key (strict)", () => {
    expect(openApplicationGroupSchema.safeParse({ ...valid(), retryCount: 1 }).success).toBe(false);
  });
});

describe("browserCommandResultSchema", () => {
  function valid() {
    return {
      protocol: 1 as const,
      type: "browser_command_result" as const,
      eventId: uuid1,
      commandId: uuid2,
      status: "completed" as const,
      items: [{ taskId: uuid3, status: "opened" as const }],
      occurredAt: now(),
    };
  }

  it("accepts the illustrative shape from browser-boundary.md", () => {
    expect(browserCommandResultSchema.safeParse(valid()).success).toBe(true);
  });

  it("accepts a partial result", () => {
    const partial = {
      ...valid(),
      status: "partial" as const,
      items: [
        { taskId: uuid1, status: "opened" as const },
        { taskId: uuid2, status: "failed" as const },
      ],
    };
    expect(browserCommandResultSchema.safeParse(partial).success).toBe(true);
  });

  it("has no client-supplied deviceId field — identity comes from the Authorization header", () => {
    expect(Object.keys(browserCommandResultSchema.shape)).not.toContain("deviceId");
  });

  it("rejects an unknown top-level key (strict)", () => {
    expect(browserCommandResultSchema.safeParse({ ...valid(), deviceId: uuid1 }).success).toBe(false);
  });

  // Issue 4: "closed" is informational only (the person closed the tab
  // without an explicit Applied/Deferred action) — it must parse like any
  // other item status, but the schema layer has no notion of "moves the
  // stage" to begin with; only `applicationStatusChangedSchema` with
  // `status: "applied"` does that, enforced by the runner, not this shape.
  it("accepts a 'closed' item status (informational; never moves Application.stage on its own)", () => {
    const withClosed = { ...valid(), status: "partial" as const, items: [{ taskId: uuid1, status: "closed" as const }] };
    expect(browserCommandResultSchema.safeParse(withClosed).success).toBe(true);
  });
});

describe("jobCaptureSchema", () => {
  function valid() {
    return {
      protocol: 1 as const,
      type: "job_capture" as const,
      eventId: uuid1,
      url: "https://jobs.example/posting/1",
      text: "Senior Platform Engineer at Northwind Labs.",
      extractorVersion: "extractor@1.0.0",
      contentHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      occurredAt: now(),
    };
  }

  it("accepts a capture event", () => {
    expect(jobCaptureSchema.safeParse(valid()).success).toBe(true);
  });

  it("has no jobId/revision — the runner, not the extension, owns matching a URL to a job", () => {
    expect(Object.keys(jobCaptureSchema.shape)).not.toContain("jobId");
    expect(Object.keys(jobCaptureSchema.shape)).not.toContain("revision");
  });

  it("has no client-supplied deviceId field", () => {
    expect(Object.keys(jobCaptureSchema.shape)).not.toContain("deviceId");
  });

  it("rejects an unknown top-level key (strict)", () => {
    expect(jobCaptureSchema.safeParse({ ...valid(), jobId: uuid1 }).success).toBe(false);
  });

  // Issue 9 regression — see the matching job-snapshot.test.ts case for the
  // full explanation: the cap is UTF-8 bytes, not JS string `.length`.
  it("rejects multi-byte text under the char cap but over the UTF-8 byte cap", () => {
    const multiByteText = "字".repeat(MAX_JOB_CAPTURE_TEXT_BYTES / 2);
    expect(new TextEncoder().encode(multiByteText).length).toBeGreaterThan(MAX_JOB_CAPTURE_TEXT_BYTES);
    expect(jobCaptureSchema.safeParse({ ...valid(), text: multiByteText }).success).toBe(false);
  });

  it("accepts multi-byte text within the UTF-8 byte cap", () => {
    expect(jobCaptureSchema.safeParse({ ...valid(), text: "字".repeat(100) }).success).toBe(true);
  });
});

describe("applicationStatusChangedSchema", () => {
  function valid() {
    return {
      protocol: 1 as const,
      type: "application_status_changed" as const,
      eventId: uuid1,
      taskId: uuid2,
      expectedRevision: 1,
      status: "applied" as const,
      occurredAt: now(),
    };
  }

  it("accepts an Applied status change", () => {
    expect(applicationStatusChangedSchema.safeParse(valid()).success).toBe(true);
  });

  it("accepts a Deferred status change", () => {
    expect(applicationStatusChangedSchema.safeParse({ ...valid(), status: "deferred" }).success).toBe(true);
  });

  it("rejects a status outside Applied/Deferred", () => {
    expect(applicationStatusChangedSchema.safeParse({ ...valid(), status: "withdrawn" }).success).toBe(
      false,
    );
  });

  it("rejects an unknown top-level key (strict)", () => {
    expect(applicationStatusChangedSchema.safeParse({ ...valid(), deviceId: uuid1 }).success).toBe(false);
  });
});
