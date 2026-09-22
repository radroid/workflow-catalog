import { describe, expect, it } from "vitest";
import { parseSessionManifestFile } from "./session-import";

const validManifest = {
  protocol: 1,
  sessionId: "b6f3a5d2-6c2a-4b8a-8e2e-9a2f6b6b2b10",
  title: "Apply today",
  items: [
    { taskId: "c818aaa2-2f5b-4b0c-9b5f-7591a21a36e8", jobRevision: 1, url: "https://jobs.example/postings/1" },
    { taskId: "be089e95-8987-4d10-a1c0-89525f431906", jobRevision: 2, url: "https://jobs.example/postings/2" },
  ],
  createdAt: "2026-09-22T00:00:00.000Z",
};

describe("parseSessionManifestFile", () => {
  it("accepts a valid application-session.json and returns the typed manifest", () => {
    const result = parseSessionManifestFile(JSON.stringify(validManifest));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.sessionId).toBe(validManifest.sessionId);
    expect(result.manifest.items).toHaveLength(2);
  });

  it("rejects invalid JSON with a clear reason instead of throwing", () => {
    expect(() => parseSessionManifestFile("{not json")).not.toThrow();
    const result = parseSessionManifestFile("{not json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/valid JSON/);
  });

  it("rejects a well-formed JSON object that doesn't match SessionManifest", () => {
    const result = parseSessionManifestFile(JSON.stringify({ hello: "world" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/session manifest shape/);
  });

  it("rejects an empty items array (min 1)", () => {
    const result = parseSessionManifestFile(JSON.stringify({ ...validManifest, items: [] }));
    expect(result.ok).toBe(false);
  });

  it("rejects a non-http(s) item URL", () => {
    const bad = { ...validManifest, items: [{ ...validManifest.items[0], url: "javascript:alert(1)" }] };
    const result = parseSessionManifestFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it("rejects unknown extra fields (schema is .strict())", () => {
    const result = parseSessionManifestFile(JSON.stringify({ ...validManifest, extra: "field" }));
    expect(result.ok).toBe(false);
  });

  it("rejects more than MAX_APPLICATION_GROUP_SIZE (20) items", () => {
    const items = Array.from({ length: 21 }, (_, i) => ({
      taskId: "c818aaa2-2f5b-4b0c-9b5f-7591a21a36e8",
      jobRevision: i + 1,
      url: "https://jobs.example/postings/1",
    }));
    const result = parseSessionManifestFile(JSON.stringify({ ...validManifest, items }));
    expect(result.ok).toBe(false);
  });
});
