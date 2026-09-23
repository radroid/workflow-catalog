import { createHash } from "node:crypto";
import type { JobStructured } from "@workflow-catalog/contracts";
import { describe, expect, it } from "vitest";
import { JobsStore } from "../store/jobs.ts";
import { newWorkspace } from "./helpers.ts";

/**
 * `JobsStore`'s own tests (P04, mvp-spec F6 and §5:
 * `jobs/<jobId>/snapshot-<rev>.json`).
 */

const FERNWOOD_URL = "https://jobs.example/postings/fernwood-staff-swe";
const HARBOR_URL = "https://jobs.example/postings/harbor-platform-engineer";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function newStore(): Promise<JobsStore> {
  return new JobsStore(await newWorkspace());
}

describe("JobsStore.captureJob: new job", () => {
  it("creates revision 1 with the correct content hash and empty structured fields", async () => {
    const store = await newStore();
    const result = await store.captureJob({ url: FERNWOOD_URL, text: "Staff Software Engineer at Fernwood.", extractorVersion: "test@1", capturedAt: "2026-09-22T09:00:00.000Z" });
    expect(result.isNewJob).toBe(true);
    expect(result.contentChanged).toBe(true);
    expect(result.revision).toBe(1);
    expect(result.snapshot).toMatchObject({
      jobId: result.jobId,
      revision: 1,
      url: FERNWOOD_URL,
      contentHash: sha256("Staff Software Engineer at Fernwood."),
      text: "Staff Software Engineer at Fernwood.",
      structured: {},
    });
  });

  it("two different URLs become two independent jobs", async () => {
    const store = await newStore();
    const a = await store.captureJob({ url: FERNWOOD_URL, text: "Fernwood posting.", extractorVersion: "test@1", capturedAt: "2026-09-22T09:00:00.000Z" });
    const b = await store.captureJob({ url: HARBOR_URL, text: "Harbor posting.", extractorVersion: "test@1", capturedAt: "2026-09-22T09:01:00.000Z" });
    expect(a.jobId).not.toBe(b.jobId);
    expect(await store.findJobIdByUrl(FERNWOOD_URL)).toBe(a.jobId);
    expect(await store.findJobIdByUrl(HARBOR_URL)).toBe(b.jobId);
  });
});

describe("JobsStore.captureJob: same URL, same content (P04 URL rule: 'no new revision')", () => {
  it("captured twice with unchanged text returns the same revision, and writes nothing new", async () => {
    const store = await newStore();
    const first = await store.captureJob({ url: FERNWOOD_URL, text: "Same text.", extractorVersion: "test@1", capturedAt: "2026-09-22T09:00:00.000Z" });
    const second = await store.captureJob({ url: FERNWOOD_URL, text: "Same text.", extractorVersion: "test@2", capturedAt: "2026-09-22T10:00:00.000Z" });
    expect(second.jobId).toBe(first.jobId);
    expect(second.revision).toBe(1);
    expect(second.contentChanged).toBe(false);
    expect(second.isNewJob).toBe(false);
    // The stored snapshot is untouched by the second (unchanged) capture: still the first's extractorVersion/capturedAt.
    expect(second.snapshot).toEqual(first.snapshot);
    expect(await store.getJobRevisions(first.jobId)).toHaveLength(1);
  });
});

describe("JobsStore.captureJob: same URL, changed content", () => {
  it("creates revision 2 and retains revision 1 unchanged (F6 acceptance)", async () => {
    const store = await newStore();
    const first = await store.captureJob({ url: FERNWOOD_URL, text: "Original posting text.", extractorVersion: "test@1", capturedAt: "2026-09-22T09:00:00.000Z" });
    const second = await store.captureJob({ url: FERNWOOD_URL, text: "Updated posting text.", extractorVersion: "test@1", capturedAt: "2026-09-23T09:00:00.000Z" });
    expect(second.jobId).toBe(first.jobId);
    expect(second.revision).toBe(2);
    expect(second.contentChanged).toBe(true);
    expect(second.isNewJob).toBe(false);

    const revision1 = await store.getSnapshot(first.jobId, 1);
    expect(revision1?.text).toBe("Original posting text.");
    const revision2 = await store.getSnapshot(first.jobId, 2);
    expect(revision2?.text).toBe("Updated posting text.");
    expect(await store.getJobRevisions(first.jobId)).toHaveLength(2);
  });

  it("a third capture with the original text again creates revision 3 (never overwrites a revision)", async () => {
    const store = await newStore();
    const first = await store.captureJob({ url: FERNWOOD_URL, text: "Text A", extractorVersion: "test@1", capturedAt: "2026-09-22T09:00:00.000Z" });
    await store.captureJob({ url: FERNWOOD_URL, text: "Text B", extractorVersion: "test@1", capturedAt: "2026-09-23T09:00:00.000Z" });
    const third = await store.captureJob({ url: FERNWOOD_URL, text: "Text A", extractorVersion: "test@1", capturedAt: "2026-09-24T09:00:00.000Z" });
    expect(third.revision).toBe(3);
    expect(third.jobId).toBe(first.jobId);
    expect((await store.getSnapshot(first.jobId, 1))?.text).toBe("Text A");
    expect((await store.getSnapshot(first.jobId, 3))?.text).toBe("Text A");
  });
});

describe("JobsStore.listJobs / getJobRevisions", () => {
  it("lists every job's latest revision, newest capture first", async () => {
    const store = await newStore();
    const a = await store.captureJob({ url: FERNWOOD_URL, text: "A", extractorVersion: "t", capturedAt: "2026-09-22T09:00:00.000Z" });
    const b = await store.captureJob({ url: HARBOR_URL, text: "B", extractorVersion: "t", capturedAt: "2026-09-23T09:00:00.000Z" });
    await store.captureJob({ url: FERNWOOD_URL, text: "A2", extractorVersion: "t", capturedAt: "2026-09-24T09:00:00.000Z" });

    const jobs = await store.listJobs();
    expect(jobs.map((job) => job.jobId)).toEqual([a.jobId, b.jobId]); // Fernwood's revision 2 (24th) is newer than Harbor's only revision (23rd)
    expect(jobs.find((job) => job.jobId === a.jobId)?.revisionCount).toBe(2);
    expect(jobs.find((job) => job.jobId === a.jobId)?.latestRevision.text).toBe("A2");
  });

  it("getJobRevisions is undefined for a job that does not exist", async () => {
    const store = await newStore();
    expect(await store.getJobRevisions("00000000-0000-4000-8000-000000000000")).toBeUndefined();
  });

  it("findJobIdByUrl is undefined for a URL never captured", async () => {
    const store = await newStore();
    expect(await store.findJobIdByUrl("https://jobs.example/never-seen")).toBeUndefined();
  });
});

describe("JobsStore.recordStructured", () => {
  const structured: JobStructured = { title: "Staff Software Engineer", company: "Fernwood", requirements: ["8+ years"] };

  it("writes structured fields onto an existing revision", async () => {
    const store = await newStore();
    const { jobId, revision } = await store.captureJob({ url: FERNWOOD_URL, text: "Posting text.", extractorVersion: "t", capturedAt: "2026-09-22T09:00:00.000Z" });
    const result = await store.recordStructured(jobId, revision, structured);
    expect(result.ok).toBe(true);
    expect(result.snapshot?.structured).toEqual(structured);
    expect((await store.getSnapshot(jobId, revision))?.structured).toEqual(structured);
  });

  it("reports ok: false for a jobId/revision that does not exist, and writes nothing", async () => {
    const store = await newStore();
    const result = await store.recordStructured("00000000-0000-4000-8000-000000000000", 1, structured);
    expect(result.ok).toBe(false);
    expect(result.snapshot).toBeUndefined();
  });

  it("reports ok: false for a revision number that does not exist on a real job", async () => {
    const store = await newStore();
    const { jobId } = await store.captureJob({ url: FERNWOOD_URL, text: "Posting text.", extractorVersion: "t", capturedAt: "2026-09-22T09:00:00.000Z" });
    const result = await store.recordStructured(jobId, 2, structured);
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed structured value without writing anything (never trusts the caller's shape)", async () => {
    const store = await newStore();
    const { jobId, revision, snapshot: before } = await store.captureJob({ url: FERNWOOD_URL, text: "Posting text.", extractorVersion: "t", capturedAt: "2026-09-22T09:00:00.000Z" });
    const malformed = { title: 12345, notAField: "nope" } as unknown as JobStructured;
    const result = await store.recordStructured(jobId, revision, malformed);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/did not match/i);
    expect(await store.getSnapshot(jobId, revision)).toEqual(before);
  });
});

describe("JobsStore.captureJob: concurrency (no lost or duplicated job for one URL)", () => {
  it("two concurrent captures of the same brand-new URL and same text produce exactly one job, one revision", async () => {
    const store = await newStore();
    const input = { url: FERNWOOD_URL, text: "Concurrent posting.", extractorVersion: "t", capturedAt: "2026-09-22T09:00:00.000Z" };
    const [a, b] = await Promise.all([store.captureJob(input), store.captureJob(input)]);
    expect(a.jobId).toBe(b.jobId);
    expect(new Set([a.revision, b.revision])).toEqual(new Set([1]));
    expect(await store.getJobRevisions(a.jobId)).toHaveLength(1);
  });

  it("two concurrent captures of the same brand-new URL with different text produce one job with two revisions, never two jobs", async () => {
    const store = await newStore();
    const [a, b] = await Promise.all([
      store.captureJob({ url: FERNWOOD_URL, text: "Version one.", extractorVersion: "t", capturedAt: "2026-09-22T09:00:00.000Z" }),
      store.captureJob({ url: FERNWOOD_URL, text: "Version two.", extractorVersion: "t", capturedAt: "2026-09-22T09:00:01.000Z" }),
    ]);
    expect(a.jobId).toBe(b.jobId);
    expect(new Set([a.revision, b.revision])).toEqual(new Set([1, 2]));
    expect(await store.getJobRevisions(a.jobId)).toHaveLength(2);
  });
});
