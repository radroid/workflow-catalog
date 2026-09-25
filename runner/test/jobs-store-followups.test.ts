import { chmod, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { JobsStore } from "../store/jobs.ts";
import { newWorkspace } from "./helpers.ts";

/**
 * P06.1 item 2.2 (the reviewer's nit on `logs/handoff/P04-round-3-review.md`):
 * a job directory that can't even be listed (chmod 000, no read permission)
 * used to drop out of `listJobs()` silently, and `readJob` answered
 * `undefined` (the route's "No such job."). Report it like T6 already
 * reports one damaged file: named, in the list and in the detail, never
 * dropped or confused with a job that never existed.
 *
 * chmod can only deny access to a non-root user on a POSIX filesystem; CI
 * (ubuntu, non-root) and macOS qualify (the same guard as budget.test.ts,
 * routes-runs.test.ts and run-harness.test.ts).
 */
const canDenyAccess = process.platform !== "win32" && process.getuid?.() !== 0;

const FERNWOOD_URL = "https://jobs.example/postings/fernwood-staff-swe";
const HARBOR_URL = "https://jobs.example/postings/harbor-platform-engineer";

describe("JobsStore: a job directory that can't be listed", () => {
  it.skipIf(!canDenyAccess)("lists as unreadable, naming the folder, instead of dropping out of the list or the count", async () => {
    const workspace = await newWorkspace();
    const store = new JobsStore(workspace);
    const healthy = await store.captureJob({ url: HARBOR_URL, text: "Platform Engineer at Harbor.", extractorVersion: "t", capturedAt: "2026-09-22T09:00:00.000Z" });
    const locked = await store.captureJob({ url: FERNWOOD_URL, text: "Staff Software Engineer at Fernwood.", extractorVersion: "t", capturedAt: "2026-09-22T09:01:00.000Z" });
    const dir = workspace.resolve("jobs", locked.jobId);
    await chmod(dir, 0o000);
    try {
      const summaries = await store.listJobs();
      expect(summaries.map((summary) => summary.jobId).sort()).toEqual([healthy.jobId, locked.jobId].sort());
      const summary = summaries.find((entry) => entry.jobId === locked.jobId);
      // Every other field reads as "unknown", not merely absent: there is no readable revision to report at all.
      expect(summary).toEqual({ jobId: locked.jobId, revisionCount: 0, latestRevisionNumber: 0, unreadable: [], directoryUnreadable: `jobs/${locked.jobId}` });
      // The healthy job is unaffected by its neighbour's trouble (the same "one job's trouble is not every job's" rule as a damaged file).
      expect(summaries.find((entry) => entry.jobId === healthy.jobId)).toMatchObject({ jobId: healthy.jobId, revisionCount: 1, url: HARBOR_URL });
    } finally {
      await chmod(dir, 0o700);
    }
  });

  it.skipIf(!canDenyAccess)("its detail says the folder can't be read, never 'No such job' (readJob answers, it doesn't answer undefined)", async () => {
    const workspace = await newWorkspace();
    const store = new JobsStore(workspace);
    const locked = await store.captureJob({ url: FERNWOOD_URL, text: "Staff Software Engineer at Fernwood.", extractorVersion: "t", capturedAt: "2026-09-22T09:00:00.000Z" });
    const dir = workspace.resolve("jobs", locked.jobId);
    await chmod(dir, 0o000);
    try {
      const detail = await store.readJob(locked.jobId);
      expect(detail).toEqual({ jobId: locked.jobId, revisionNumbers: [], revisions: [], unreadable: [], directoryUnreadable: `jobs/${locked.jobId}` });
    } finally {
      await chmod(dir, 0o700);
    }
  });

  it("a job whose directory can be listed fine never sets directoryUnreadable (no regression on the healthy path)", async () => {
    const workspace = await newWorkspace();
    const store = new JobsStore(workspace);
    const healthy = await store.captureJob({ url: HARBOR_URL, text: "Platform Engineer at Harbor.", extractorVersion: "t", capturedAt: "2026-09-22T09:00:00.000Z" });
    const [summary] = await store.listJobs();
    expect(summary?.directoryUnreadable).toBeUndefined();
    expect((await store.readJob(healthy.jobId))?.directoryUnreadable).toBeUndefined();
  });

  // P06.1 K7 (round-1 revision): a uuid-named *regular file* directly under jobs/ passes isJobId's format check
  // (it never looks at the filesystem), so listJobs() tries to list it as a directory and readdir throws ENOTDIR,
  // not ENOENT -- workspace.list() only swallows ENOENT. Before this revision, #summarise()/readJob()'s catch (item
  // 2.2, meant for a real permission failure) treated *any* thrown error the same way, so this stray file was
  // reported as "a folder that can't be read" -- listed, with a 200 detail -- instead of being skipped as it was
  // before item 2.2 existed (not listed at all, detail 404 "No such job").
  it("skips a uuid-named regular file under jobs/ as if it were never there, never as an unreadable folder", async () => {
    const workspace = await newWorkspace();
    const store = new JobsStore(workspace);
    const healthy = await store.captureJob({ url: HARBOR_URL, text: "Platform Engineer at Harbor.", extractorVersion: "t", capturedAt: "2026-09-22T09:00:00.000Z" });
    const strayId = "11111111-1111-4111-8111-111111111111"; // a valid uuid shape, so isJobId accepts it
    await writeFile(workspace.resolve("jobs", strayId), "not a directory at all");

    const summaries = await store.listJobs();
    expect(summaries.map((entry) => entry.jobId)).toEqual([healthy.jobId]); // the stray file never joins the list
    expect(summaries.some((entry) => entry.directoryUnreadable)).toBe(false); // and is never misreported as one

    expect(await store.readJob(strayId)).toBeUndefined(); // 404 "No such job", not a directoryUnreadable shape
  });
});
