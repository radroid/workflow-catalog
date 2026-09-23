import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_BRIDGE_BODY_BYTES } from "@workflow-catalog/contracts";
import { describe, expect, it } from "vitest";
import { checkImportFileSize, parseSessionManifestFile } from "./session-import";

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

  it("P07-B revision 4, K2: the README's example for the manual smoke test (fixtures/application-session.example.json) is a valid manifest", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const text = readFileSync(path.join(here, "../../fixtures/application-session.example.json"), "utf8");
    const result = parseSessionManifestFile(text);
    expect(result.ok, "it must import cleanly until the runner writes real ones (part C)").toBe(true);
    if (!result.ok) return;
    expect(result.manifest.items.every((item) => new URL(item.url).hostname.endsWith(".example")), "fictional URLs only").toBe(true);
  });

  it("rejects invalid JSON with a clear summary instead of throwing", () => {
    expect(() => parseSessionManifestFile("{not json")).not.toThrow();
    const result = parseSessionManifestFile("{not json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.summary).toMatch(/valid JSON/);
    expect(result.detail).toBeUndefined();
  });

  it("rejects a well-formed JSON object that doesn't match SessionManifest, with a plain-sentence summary and the zod issues kept separately as detail", () => {
    const result = parseSessionManifestFile(JSON.stringify({ hello: "world" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.summary).toMatch(/session manifest shape/);
    expect(result.summary).toMatch(/^[^\n]+$/); // one line -- a plain sentence, not a dump
    expect(result.detail).toBeTruthy();
    expect(result.detail).toContain("\n"); // the per-issue breakdown lives here instead
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

describe("checkImportFileSize (review issue 3: a 20 MB file froze the options page for ~160s reading it in unchecked)", () => {
  it("accepts a file at or under the contracts body cap", () => {
    expect(checkImportFileSize(0).ok).toBe(true);
    expect(checkImportFileSize(MAX_BRIDGE_BODY_BYTES).ok).toBe(true);
  });

  it("rejects a file over the cap, with the byte counts in the message, without ever reading its content", () => {
    const result = checkImportFileSize(MAX_BRIDGE_BODY_BYTES + 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain((MAX_BRIDGE_BODY_BYTES + 1).toLocaleString());
    expect(result.reason).toContain(MAX_BRIDGE_BODY_BYTES.toLocaleString());
  });

  it("rejects a 20 MB file specifically (the reviewer's repro size)", () => {
    const result = checkImportFileSize(20 * 1024 * 1024);
    expect(result.ok).toBe(false);
  });
});
