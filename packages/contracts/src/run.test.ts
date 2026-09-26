import { describe, expect, it } from "vitest";
import { runKindSchema, runRecordSchema, scheduleKindSchema } from "./run";

function validRun() {
  return {
    runId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    kind: "prepare_newly_saved_jobs" as const,
    isCatchUp: false,
    inputs: { jobIds: ["0d3a4b0e-58cc-4372-a567-0e02b2c3d479"] },
    idempotencyKey: "run-2026-09-22-daily",
    outcome: "success" as const,
    model: "gpt-5.6-luna-fast",
    tokens: { input: 1200, output: 340 },
    durationMs: 4500,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };
}

describe("scheduleKindSchema / runKindSchema", () => {
  it("every scheduleKind is also a valid runKind", () => {
    for (const kind of scheduleKindSchema.options) {
      expect(runKindSchema.options).toContain(kind);
    }
  });

  it("runKind additionally allows manual", () => {
    expect(runKindSchema.options).toContain("manual");
    expect(scheduleKindSchema.options).not.toContain("manual");
  });
});

describe("runRecordSchema", () => {
  it("accepts a successful scheduled run", () => {
    expect(runRecordSchema.safeParse(validRun()).success).toBe(true);
  });

  it("accepts a manual run", () => {
    expect(runRecordSchema.safeParse({ ...validRun(), kind: "manual" }).success).toBe(true);
  });

  // F10/F11 accept: "a run over the cap pauses with a visible reason."
  it("accepts a paused run with a reason and no finishedAt", () => {
    const { finishedAt: _finishedAt, ...rest } = validRun();
    void _finishedAt;
    const paused = { ...rest, outcome: "paused" as const, error: "daily run budget exceeded" };
    expect(runRecordSchema.safeParse(paused).success).toBe(true);
  });

  it("rejects an invalid outcome", () => {
    expect(runRecordSchema.safeParse({ ...validRun(), outcome: "cancelled" }).success).toBe(false);
  });

  it("rejects negative token counts", () => {
    expect(runRecordSchema.safeParse({ ...validRun(), tokens: { input: -1, output: 0 } }).success).toBe(
      false,
    );
  });

  it("rejects an unknown top-level key (strict)", () => {
    expect(runRecordSchema.safeParse({ ...validRun(), cost: 0.02 }).success).toBe(false);
  });
});
