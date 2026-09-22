import "../shared/zod-jitless";
import { jobCaptureSchema, MAX_JOB_CAPTURE_TEXT_BYTES } from "@workflow-catalog/contracts";
import { describe, expect, it } from "vitest";
import { buildJobCapture, MIN_CAPTURED_TEXT_LENGTH } from "./build-job-capture";
import { EXTRACTOR_VERSION } from "./extractor";

describe("buildJobCapture", () => {
  it("builds a JobCapture that validates against the real contracts schema", async () => {
    const result = await buildJobCapture({
      url: "https://jobs.example/postings/fernwood-staff-swe",
      rawText: "Staff Software Engineer — Fernwood\n\nFernwood is hiring.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(jobCaptureSchema.safeParse(result.capture).success).toBe(true);
    expect(result.capture.protocol).toBe(1);
    expect(result.capture.type).toBe("job_capture");
    expect(result.capture.url).toBe("https://jobs.example/postings/fernwood-staff-swe");
    expect(result.capture.extractorVersion).toBe(EXTRACTOR_VERSION);
    expect(result.capture.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.capture.text).toBe("Staff Software Engineer — Fernwood\n\nFernwood is hiring.");
  });

  it("contentHash is the SHA-256 of exactly the final (normalized, truncated) text", async () => {
    const result = await buildJobCapture({
      url: "https://jobs.example/postings/1",
      rawText: "  the role   requires  \n\n\n\n  five years experience  ",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256").update(result.capture.text, "utf8").digest("hex");
    expect(result.capture.contentHash).toBe(expected);
  });

  it("generates a fresh eventId (UUID) each call", async () => {
    const a = await buildJobCapture({ url: "https://jobs.example/1", rawText: "posting text here, applies now" });
    const b = await buildJobCapture({ url: "https://jobs.example/1", rawText: "posting text here, applies now" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.capture.eventId).not.toBe(b.capture.eventId);
    expect(a.capture.eventId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects near-empty content instead of saving a near-empty capture", async () => {
    const result = await buildJobCapture({ url: "https://jobs.example/1", rawText: "  \n  hi  \n " });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not enough/i);
  });

  it("text exactly at MIN_CAPTURED_TEXT_LENGTH succeeds", async () => {
    const rawText = "x".repeat(MIN_CAPTURED_TEXT_LENGTH);
    const result = await buildJobCapture({ url: "https://jobs.example/1", rawText });
    expect(result.ok).toBe(true);
  });

  it("truncates oversized text so the envelope stays under the bridge body cap", async () => {
    const rawText = "word ".repeat(100_000);
    const result = await buildJobCapture({ url: "https://jobs.example/1", rawText });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const jsonBytes = new TextEncoder().encode(JSON.stringify(result.capture.text)).length;
    expect(jsonBytes).toBeLessThanOrEqual(MAX_JOB_CAPTURE_TEXT_BYTES);
  });

  it("rejects a non-http(s) URL (the schema itself, defense in depth against a caller skipping url.ts)", async () => {
    const result = await buildJobCapture({ url: "javascript:alert(1)", rawText: "some real posting text here" });
    expect(result.ok).toBe(false);
  });
});
