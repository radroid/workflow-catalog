import { chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { JobSnapshot } from "@workflow-catalog/contracts";
import { describe, expect, it } from "vitest";
import { UI_COOKIE } from "../server/local-ui.ts";
import type { LoadedRouteModule } from "../server/route-modules.ts";
import capturesModule, { type ShownExtractionState } from "../server/routes/captures.ts";
import type { UnreadableSnapshot } from "../store/jobs.ts";
import { BRIDGE, makeBridge, UI_TOKEN, type TestBridge } from "./helpers.ts";

/**
 * The two server nits `logs/handoff/P04-round-3-review.md`'s round-3
 * reviewer carried to P06.1:
 *  - 2.1: a Re-extract whose waiting-state write fails answers a generic 500.
 *  - 2.2: a job directory that can't be read drops out of the list, and its
 *    detail answers 404 ("No such job.").
 * `store/jobs.ts`'s own tests (jobs-store-followups.test.ts) cover the store
 * level; these cover what the routes answer over HTTP.
 */

/** chmod can only deny access to a non-root user on a POSIX filesystem; CI (ubuntu, non-root) and macOS qualify. */
const canDenyAccess = process.platform !== "win32" && process.getuid?.() !== 0;

const COOKIE = `${UI_COOKIE}=${UI_TOKEN}`;
const SAME_ORIGIN = { cookie: COOKIE, origin: BRIDGE, "content-type": "application/json", "sec-fetch-site": "same-origin" };
const MODULES: readonly LoadedRouteModule[] = [{ name: "captures", module: capturesModule }];

async function bridgeWith(): Promise<TestBridge> {
  return makeBridge({ modules: MODULES });
}

function postCaptures(bridge: TestBridge, pathname: string, body: unknown): Promise<Response> {
  return bridge.request(`/api/captures${pathname}`, { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify(body) });
}

async function getCaptures<T>(bridge: TestBridge, pathname: string): Promise<T> {
  return (await (await bridge.request(`/api/captures${pathname}`, { headers: { cookie: COOKIE } })).json()) as T;
}

interface CaptureBody {
  readonly job: JobSnapshot & { readonly jobId: string };
}

interface ListBody {
  readonly jobs: ReadonlyArray<{
    readonly jobId: string;
    readonly revisionCount: number;
    readonly latestRevision: number;
    readonly url?: string;
    readonly unreadable: readonly UnreadableSnapshot[];
    readonly directoryUnreadable?: string;
    readonly extraction: ShownExtractionState | null;
  }>;
}

interface DetailBody {
  readonly jobId: string;
  readonly revisions: readonly JobSnapshot[];
  readonly unreadable: readonly UnreadableSnapshot[];
  readonly directoryUnreadable?: string;
}

describe("captures.ts: a Re-extract whose waiting-state write fails (item 2.1)", () => {
  it("refuses plainly, as a typed JSON error, never an unhandled 500, when extraction-<rev>.json exists as a directory", async () => {
    const bridge = await bridgeWith();
    const pasted = await postCaptures(bridge, "/paste", { url: "https://jobs.example/fernwood-staff-swe", text: "Staff Software Engineer at Fernwood." });
    expect(pasted.status).toBe(200);
    const { job } = (await pasted.json()) as CaptureBody;

    // The paste itself already queued (and, with no eve configured, immediately settled) an extraction, which wrote
    // this exact file as `not_run`; replace it with a directory to reproduce the write failure Re-extract hits.
    const extractionStatePath = path.join(bridge.workspace.root, "jobs", job.jobId, "extraction-1.json");
    await rm(extractionStatePath);
    await mkdir(extractionStatePath);
    const response = await bridge.request(`/api/captures/${job.jobId}/1/extract`, { method: "POST", headers: SAME_ORIGIN });

    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.status).toBe(500);
    const body = (await response.json()) as { ok: boolean; error?: { code: string; message: string } };
    expect(body).toEqual({ ok: false, error: { code: "extraction_not_queued", message: "Couldn't start extraction: the runner hit a problem saving its state." } });
    expect(body.error?.message).not.toMatch(/EISDIR|ENOTDIR|Error:|at Object/); // never the raw fs/stack text
  });
});

describe("captures.ts: a job directory that can't be read (item 2.2)", () => {
  it.skipIf(!canDenyAccess)("stays in the list, named by its folder, and its detail answers 200 with the same name, never 404", async () => {
    const bridge = await bridgeWith();
    const healthy = (await (await postCaptures(bridge, "/paste", { url: "https://jobs.example/harbor-platform-engineer", text: "Platform Engineer at Harbor." })).json()) as CaptureBody;
    const locked = (await (await postCaptures(bridge, "/paste", { url: "https://jobs.example/fernwood-staff-swe", text: "Staff Software Engineer at Fernwood." })).json()) as CaptureBody;
    const dir = path.join(bridge.workspace.root, "jobs", locked.job.jobId);
    await chmod(dir, 0o000);
    try {
      const list = await getCaptures<ListBody>(bridge, "");
      expect(list.jobs.map((entry) => entry.jobId).sort()).toEqual([healthy.job.jobId, locked.job.jobId].sort());
      const entry = list.jobs.find((row) => row.jobId === locked.job.jobId);
      expect(entry).toMatchObject({ revisionCount: 0, unreadable: [], directoryUnreadable: `jobs/${locked.job.jobId}` });
      expect(entry?.url).toBeUndefined();

      const detailResponse = await bridge.request(`/api/captures/${locked.job.jobId}`, { headers: { cookie: COOKIE } });
      expect(detailResponse.status).toBe(200); // not 404 "No such job."
      const detail = (await detailResponse.json()) as DetailBody;
      expect(detail).toMatchObject({ jobId: locked.job.jobId, revisions: [], unreadable: [], directoryUnreadable: `jobs/${locked.job.jobId}` });
    } finally {
      await chmod(dir, 0o700);
    }
  });
});
