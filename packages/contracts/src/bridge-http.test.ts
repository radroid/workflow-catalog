import { describe, expect, it } from "vitest";
import {
  commandsResponseSchema,
  eventsRequestSchema,
  pairRequestSchema,
  pairResponseSchema,
  statusResponseSchema,
} from "./bridge-http";

const uuid1 = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const uuid2 = "0d3a4b0e-58cc-4372-a567-0e02b2c3d479";
const now = () => new Date().toISOString();

describe("pairRequestSchema / pairResponseSchema", () => {
  it("accepts a pairing code request", () => {
    expect(pairRequestSchema.safeParse({ code: "quiet-harbor-42" }).success).toBe(true);
  });

  it("rejects an empty code", () => {
    expect(pairRequestSchema.safeParse({ code: "" }).success).toBe(false);
  });

  // P01.1 packet: uncapped, a 300 KB body was valid under zod. P02's printed
  // codes are short (at most 12 characters); 64 is comfortably above that.
  it("accepts a code at exactly 64 characters and rejects one more", () => {
    expect(pairRequestSchema.safeParse({ code: "a".repeat(64) }).success).toBe(true);
    expect(pairRequestSchema.safeParse({ code: "a".repeat(65) }).success).toBe(false);
  });

  it("rejects a 300 KB code", () => {
    expect(pairRequestSchema.safeParse({ code: "a".repeat(300_000) }).success).toBe(false);
  });

  it("accepts a pairing response", () => {
    expect(pairResponseSchema.safeParse({ deviceId: uuid1, token: "opaque-device-token" }).success).toBe(
      true,
    );
  });

  it("rejects a non-uuid deviceId", () => {
    expect(pairResponseSchema.safeParse({ deviceId: "device-1", token: "t" }).success).toBe(false);
  });
});

describe("commandsResponseSchema", () => {
  it("accepts an empty pending-commands list", () => {
    expect(commandsResponseSchema.safeParse({ commands: [] }).success).toBe(true);
  });

  it("accepts a list with one open_application_group command", () => {
    const response = {
      commands: [
        {
          protocol: 1 as const,
          type: "open_application_group" as const,
          commandId: uuid1,
          deviceId: uuid2,
          sessionId: uuid1,
          workflowVersion: "job-assistant@1",
          expiresAt: now(),
          payload: { title: "Apply today", items: [{ taskId: uuid1, jobRevision: 1, url: "https://jobs.example/x" }] },
        },
      ],
    };
    expect(commandsResponseSchema.safeParse(response).success).toBe(true);
  });
});

describe("eventsRequestSchema (discriminated union)", () => {
  it("accepts a job_capture body", () => {
    const body = {
      protocol: 1 as const,
      type: "job_capture" as const,
      eventId: uuid1,
      url: "https://jobs.example/posting/1",
      text: "Senior Platform Engineer.",
      extractorVersion: "extractor@1.0.0",
      contentHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      occurredAt: now(),
    };
    expect(eventsRequestSchema.safeParse(body).success).toBe(true);
  });

  it("accepts an application_status_changed body", () => {
    const body = {
      protocol: 1 as const,
      type: "application_status_changed" as const,
      eventId: uuid1,
      taskId: uuid2,
      expectedRevision: 1,
      status: "applied" as const,
      occurredAt: now(),
    };
    expect(eventsRequestSchema.safeParse(body).success).toBe(true);
  });

  it("rejects an unrecognized type", () => {
    expect(eventsRequestSchema.safeParse({ type: "job_deleted", eventId: uuid1 }).success).toBe(false);
  });
});

describe("statusResponseSchema", () => {
  it("accepts a status response with no personal data", () => {
    const status = {
      version: "0.1.0",
      workspaceId: "ada-quill-workspace",
      budget: { dailyRunLimit: 10, runsUsedToday: 2, paused: false },
      schedules: [
        { id: "daily-prepare", kind: "prepare_newly_saved_jobs" as const, paused: false, nextRunAt: now() },
      ],
    };
    expect(statusResponseSchema.safeParse(status).success).toBe(true);
  });

  it("rejects an unknown top-level key (strict) — keeps personal data from sneaking onto /status", () => {
    const status = {
      version: "0.1.0",
      workspaceId: "ada-quill-workspace",
      budget: { dailyRunLimit: 10, runsUsedToday: 2, paused: false },
      schedules: [],
      careerProfileSummary: "Ada Quill, Senior Platform Engineer",
    };
    expect(statusResponseSchema.safeParse(status).success).toBe(false);
  });
});
