import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubBridgeClient } from "./bridge-client";

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // Any network call at all is a failure of part A's "no bridge calls" rule.
  globalThis.fetch = (() => {
    throw new Error("stubBridgeClient must never call fetch in part A");
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("stubBridgeClient (part A: no network)", () => {
  it("pair() resolves without calling fetch, with the documented message", async () => {
    const result = await stubBridgeClient.pair({ code: "123456" });
    expect(result).toEqual({ ok: false, message: "Pairing connects in the next version." });
  });

  it("postEvent() resolves without calling fetch", async () => {
    const result = await stubBridgeClient.postEvent({
      protocol: 1,
      type: "job_capture",
      eventId: "b6f3a5d2-6c2a-4b8a-8e2e-9a2f6b6b2b10",
      url: "https://jobs.example/postings/1",
      text: "text",
      extractorVersion: "extractor@0.1.0",
      contentHash: "a".repeat(64),
      occurredAt: "2026-09-22T00:00:00.000Z",
    });
    expect(result.ok).toBe(false);
  });

  it("getCommands() resolves without calling fetch", async () => {
    const result = await stubBridgeClient.getCommands();
    expect(result.ok).toBe(false);
  });

  it("getStatus() resolves without calling fetch", async () => {
    const result = await stubBridgeClient.getStatus();
    expect(result.ok).toBe(false);
  });
});
