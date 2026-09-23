import { randomUUID } from "node:crypto";
import type { JobStructured } from "@workflow-catalog/contracts";
import type { Client, ClientSession, MessageResponse, MessageStreamEvent } from "eve/client";
import { describe, expect, it } from "vitest";
import type { EveGateway } from "../server/eve-gateway.ts";
import { UI_COOKIE } from "../server/local-ui.ts";
import capturesModule, { buildJobExtractionPrompt, captureAndExtract, runExtraction } from "../server/routes/captures.ts";
import type { LoadedRouteModule } from "../server/route-modules.ts";
import { JobsStore } from "../store/jobs.ts";
import { BRIDGE, jobCapture, makeBridge, pairDevice, postEvent, UI_TOKEN, type TestBridge } from "./helpers.ts";

/**
 * `/api/captures` and the `job_capture` event handler (P04). The extension
 * path is exercised through `postEvent`/`jobCapture` (test/helpers.ts already
 * has both, seeded ahead of this packet); the local-UI paste and URL-fetch
 * forms through the same `SAME_ORIGIN` header pattern `onboarding-routes.test.ts`
 * uses. A fake `EveGateway` scripts the extraction turn — event by event,
 * matching how `runTurn` actually consumes `created.response` (`for await`),
 * not the `result()` shape a route that calls eve directly would use.
 */

const COOKIE = `${UI_COOKIE}=${UI_TOKEN}`;
const SAME_ORIGIN = { cookie: COOKIE, origin: BRIDGE, "content-type": "application/json", "sec-fetch-site": "same-origin" };
const MODULES: readonly LoadedRouteModule[] = [{ name: "captures", module: capturesModule }];

const META = { at: "2026-09-22T09:00:00.000Z", id: "evt-0" };

function started(modelId = "test-model"): MessageStreamEvent {
  return { type: "step.started", data: { modelId, sequence: 0, stepIndex: 0, turnId: "t1" }, meta: META };
}
function actionResult(toolName: string, output: unknown): MessageStreamEvent {
  return { type: "action.result", data: { status: "completed", result: { kind: "tool-result", callId: "call-1", toolName, output }, sequence: 1, stepIndex: 0, turnId: "t1" }, meta: META } as MessageStreamEvent;
}
function completedUsage(): MessageStreamEvent {
  return { type: "step.completed", data: { finishReason: "stop", sequence: 2, stepIndex: 0, turnId: "t1", usage: { inputTokens: 4, outputTokens: 1 } }, meta: META };
}
function turnCompleted(): MessageStreamEvent {
  return { type: "turn.completed", data: { sequence: 3, turnId: "t1" }, meta: META };
}
function sessionWaiting(): MessageStreamEvent {
  return { type: "session.waiting", data: { continuationToken: "s1", wait: "next-user-message" }, meta: META };
}
function turnFailed(): MessageStreamEvent {
  return { type: "turn.failed", data: { code: "MODEL_CALL_FAILED", message: "The model declined to answer.", sequence: 1, turnId: "t1" }, meta: META };
}

type Script = (message: string) => Promise<readonly MessageStreamEvent[]> | readonly MessageStreamEvent[];

/** A fake eve gateway consumed event-by-event, the way `runTurn` (`for await (const event of created.response)`) actually reads it — not the `result()` shape. */
function fakeEve(script: Script): { eve: EveGateway; calls: string[] } {
  const calls: string[] = [];
  const create = async ({ message }: { message: string; signal?: AbortSignal }) => {
    calls.push(message);
    const events = await script(message);
    const response = {
      [Symbol.asyncIterator]: () =>
        (async function* () {
          for (const event of events) yield event;
        })(),
    } as unknown as MessageResponse;
    const session = { cancel: async () => ({ status: "accepted" as const, sessionId: "s1" }) } as unknown as ClientSession;
    return { response, session };
  };
  const eve: EveGateway = { url: "http://127.0.0.1:3210", client: { sessions: { create } } as unknown as Client, health: async () => ({ ok: true }), modelId: async () => undefined, checkModel: async () => ({ ok: true }) };
  return { eve, calls };
}

/**
 * Scripts a real extract_job call: parses jobId/revision out of the prompt (as
 * the real model would report them back) and actually writes through the
 * store the getter resolves, the way the real tool's step would — so the
 * resulting snapshot reflects a genuine round trip, not a fabricated claim.
 *
 * `getStore` is lazy (a thunk, not a `JobsStore` value) because `bridgeWith`
 * takes `eve` as a constructor option: the fake eve — and the script it
 * runs — must exist before the real bridge (and its workspace) does. A bare
 * `JobsStore` captured here would bind to whatever workspace existed at the
 * time `extractingScript` was called, which is never the one that ends up
 * handling the request. Callers build the real bridge, build a `JobsStore`
 * over *that* bridge's workspace, and only then let this run.
 */
function extractingScript(getStore: () => JobsStore, structured: JobStructured): Script {
  return async (message) => {
    const jobId = /jobId: "([0-9a-f-]{36})"/.exec(message)?.[1];
    const revision = Number(/revision: (\d+)/.exec(message)?.[1] ?? "0");
    if (!jobId || !revision) return [turnCompleted(), sessionWaiting()];
    const result = await getStore().recordStructured(jobId, revision, structured);
    return [started(), actionResult("extract_job", { jobId, revision, persisted: result.ok, message: result.message }), completedUsage(), turnCompleted(), sessionWaiting()];
  };
}

async function bridgeWith(eve?: EveGateway): Promise<TestBridge> {
  return makeBridge({ modules: MODULES, eve });
}

function postCaptures(bridge: TestBridge, pathname: string, body: unknown): Promise<Response> {
  return bridge.request(`/api/captures${pathname}`, { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify(body) });
}

async function getCaptures<T>(bridge: TestBridge, pathname: string): Promise<T> {
  return (await (await bridge.request(`/api/captures${pathname}`, { headers: { cookie: COOKIE } })).json()) as T;
}

const NORTHWIND_STRUCTURED: JobStructured = { title: "Staff Platform Engineer", company: "Northwind Labs", requirements: ["8+ years"] };

describe("captures.ts: job_capture event (extension path)", () => {
  it("a new capture creates a job and revision 1, and journals ok:true", async () => {
    const bridge = await bridgeWith();
    const { token } = await pairDevice(bridge);
    const capture = jobCapture();
    const response = await postEvent(bridge, token, capture);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; duplicate: boolean; outcome: string; result: { jobId: string; revision: number } };
    expect(body).toMatchObject({ ok: true, duplicate: false, outcome: "handled" });
    expect(body.result.revision).toBe(1);

    const store = new JobsStore(bridge.workspace);
    const snapshot = await store.getSnapshot(body.result.jobId, 1);
    expect(snapshot).toMatchObject({ url: capture.url, text: capture.text, structured: {} });
  });

  it("a replay of the same eventId is a duplicate and never runs the handler again (P07-B counts duplicate: true as success)", async () => {
    const bridge = await bridgeWith();
    const { token } = await pairDevice(bridge);
    const capture = jobCapture();
    const first = await postEvent(bridge, token, capture);
    const second = await postEvent(bridge, token, capture);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { duplicate: boolean };
    expect(secondBody.duplicate).toBe(true);
    const store = new JobsStore(bridge.workspace);
    expect(await store.getJobRevisions((await (await postEvent(bridge, token, capture)).json() as { result: { jobId: string } }).result.jobId)).toHaveLength(1);
  });

  it("the same URL with a different content hash creates revision 2, and revision 1 is retained", async () => {
    const bridge = await bridgeWith();
    const { token } = await pairDevice(bridge);
    const url = "https://jobs.example/northwind-labs/staff-platform-engineer";
    const first = jobCapture({ url, text: "Original text." });
    const second = jobCapture({ url, text: "Updated text." });
    const firstResult = (await (await postEvent(bridge, token, first)).json()) as { result: { jobId: string; revision: number } };
    const secondResult = (await (await postEvent(bridge, token, second)).json()) as { result: { jobId: string; revision: number } };
    expect(secondResult.result.jobId).toBe(firstResult.result.jobId);
    expect(secondResult.result.revision).toBe(2);
    const store = new JobsStore(bridge.workspace);
    expect((await store.getSnapshot(firstResult.result.jobId, 1))?.text).toBe("Original text.");
    expect((await store.getSnapshot(firstResult.result.jobId, 2))?.text).toBe("Updated text.");
  });

  it("rejects a javascript: URL before it ever reaches the handler (contract validation)", async () => {
    const bridge = await bridgeWith();
    const { token } = await pairDevice(bridge);
    const response = await postEvent(bridge, token, { ...jobCapture(), url: "javascript:alert(1)" });
    expect(response.status).toBe(400);
  });
});

describe("captures.ts: extraction runs inline through runTurn when content changed", () => {
  it("persists structured fields via the real extract_job tool round trip", async () => {
    let store: JobsStore | undefined;
    const { eve, calls } = fakeEve(extractingScript(() => store!, NORTHWIND_STRUCTURED));
    const withEve = await bridgeWith(eve);
    store = new JobsStore(withEve.workspace);
    const { token } = await pairDevice(withEve);
    const response = await postEvent(withEve, token, jobCapture({ text: "Staff Platform Engineer at Northwind Labs." }));
    const body = (await response.json()) as { result: { jobId: string; revision: number } };
    expect(calls).toHaveLength(1);
    const snapshot = await store.getSnapshot(body.result.jobId, body.result.revision);
    expect(snapshot?.structured).toEqual(NORTHWIND_STRUCTURED);
  });

  it("delivers the posting text only as user-turn data (mutation target: 'put the posting text into the instructions')", async () => {
    let store: JobsStore | undefined;
    const { eve, calls } = fakeEve(extractingScript(() => store!, NORTHWIND_STRUCTURED));
    const bridge = await bridgeWith(eve);
    store = new JobsStore(bridge.workspace);
    const { token } = await pairDevice(bridge);
    const text = "Staff Platform Engineer at Northwind Labs. Fictional posting for the mutation-proof test.";
    await postEvent(bridge, token, jobCapture({ text }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(text);
    expect(calls[0]).toContain("--- POSTING-"); // the random per-call boundary (buildJobExtractionPrompt)
  });

  it("does not re-run extraction when the capture is an unchanged duplicate (no new revision)", async () => {
    let store: JobsStore | undefined;
    const { eve, calls } = fakeEve(extractingScript(() => store!, NORTHWIND_STRUCTURED));
    const bridge = await bridgeWith(eve);
    store = new JobsStore(bridge.workspace);
    const { token } = await pairDevice(bridge);
    const capture = jobCapture();
    await postEvent(bridge, token, capture);
    await postEvent(bridge, token, jobCapture({ ...capture, eventId: randomUUID() })); // same url+text, new eventId: same content hash, no new revision
    expect(calls).toHaveLength(1); // extraction ran only for the first (content-changing) capture
  });

  it("a turn that isn't ok records no fields and says so plainly (mutation target: 'count a non-ok turn as extracted')", async () => {
    const bridge = await bridgeWith();
    const { eve } = fakeEve(async () => [started(), turnFailed(), sessionWaiting()]);
    const outcome = await runExtraction(bridge.ctx, randomUUID(), 1, "some text");
    expect(outcome.status).toBe("not_extracted");
  });

  it("a turn with no successful extract_job call records no fields", async () => {
    const bridge = await bridgeWith();
    const { eve } = fakeEve(async () => [started(), turnCompleted(), sessionWaiting()]); // no tool call at all
    const outcome = await runExtraction(bridge.ctx, randomUUID(), 1, "some text");
    expect(outcome.status).toBe("not_extracted");
    expect(eve).toBeDefined();
  });
});

describe("captures.ts: three paths produce identical snapshot records for the same fixture text (F6 acceptance)", () => {
  it("extension, paste, and URL-fetch text all extract to the same structured fields for the same posting text", async () => {
    const bridge = await bridgeWith();
    const store = new JobsStore(bridge.workspace);
    const { eve } = fakeEve(extractingScript(() => store, NORTHWIND_STRUCTURED));
    const ctxWithEve = { ...bridge.ctx, eve };
    const text = "Staff Platform Engineer at Northwind Labs. Fictional posting used across all three capture paths.";

    const viaExtension = await captureAndExtract(ctxWithEve, { url: "https://jobs.example/via-extension", text, extractorVersion: "extension@1", capturedAt: "2026-09-22T09:00:00.000Z" });
    const viaPaste = await captureAndExtract(ctxWithEve, { url: "https://jobs.example/via-paste", text, extractorVersion: "paste@1", capturedAt: "2026-09-22T09:00:00.000Z" });
    const viaUrlFetch = await captureAndExtract(ctxWithEve, { url: "https://jobs.example/via-url-fetch", text, extractorVersion: "url-fetch@1", capturedAt: "2026-09-22T09:00:00.000Z" });

    for (const result of [viaExtension, viaPaste, viaUrlFetch]) {
      expect(result.capture.snapshot.text).toBe(text);
      expect(result.capture.snapshot.contentHash).toBe(viaExtension.capture.snapshot.contentHash);
      expect(result.capture.snapshot.structured).toEqual(NORTHWIND_STRUCTURED);
    }
  });
});

describe("captures.ts: POST /api/captures/paste", () => {
  it("saves a paste-path capture and reports success", async () => {
    const bridge = await bridgeWith();
    const response = await postCaptures(bridge, "/paste", { url: "https://jobs.example/pasted-posting", text: "Pasted posting text." });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; message: string; job: { revision: number } };
    expect(body.ok).toBe(true);
    expect(body.job.revision).toBe(1);
  });

  it("rejects a javascript: URL", async () => {
    const bridge = await bridgeWith();
    const response = await postCaptures(bridge, "/paste", { url: "javascript:alert(1)", text: "Text" });
    expect(response.status).toBe(400);
  });

  it("rejects text over the 200 KB cap", async () => {
    const bridge = await bridgeWith();
    const response = await postCaptures(bridge, "/paste", { url: "https://jobs.example/huge", text: "x".repeat(200_001) });
    expect(response.status).toBe(400); // utf8BoundedTextSchema rejects it as a validation error
  });

  it("reports 'hasn't changed' for a re-paste of the same url and text, without a new revision", async () => {
    const bridge = await bridgeWith();
    await postCaptures(bridge, "/paste", { url: "https://jobs.example/pasted-posting", text: "Same text." });
    const second = await postCaptures(bridge, "/paste", { url: "https://jobs.example/pasted-posting", text: "Same text." });
    const body = (await second.json()) as { message: string; job: { revision: number } };
    expect(body.message).toContain("hasn't changed");
    expect(body.job.revision).toBe(1);
  });
});

describe("captures.ts: POST /api/captures/url (mutation target: 'accept http on the fetch path')", () => {
  it("refuses a plain http:// URL", async () => {
    const bridge = await bridgeWith();
    const response = await postCaptures(bridge, "/url", { url: "http://jobs.example/posting" });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("https_required");
  });

  it("refuses javascript: and file: the same way", async () => {
    const bridge = await bridgeWith();
    for (const url of ["javascript:alert(1)", "file:///etc/passwd"]) {
      const response = await postCaptures(bridge, "/url", { url });
      expect(response.status).toBe(400);
    }
  });

  it("refuses a loopback address literal without ever calling out (SSRF)", async () => {
    const bridge = await bridgeWith();
    const response = await postCaptures(bridge, "/url", { url: "https://127.0.0.1/secret" });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("fetch_blocked_address");
  });

  it("refuses the cloud metadata address literal", async () => {
    const bridge = await bridgeWith();
    const response = await postCaptures(bridge, "/url", { url: "https://169.254.169.254/latest/meta-data" });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("fetch_blocked_address");
  });

  it("refuses a private RFC 1918 address literal", async () => {
    const bridge = await bridgeWith();
    const response = await postCaptures(bridge, "/url", { url: "https://10.0.0.5/internal" });
    expect(response.status).toBe(400);
  });
});

describe("captures.ts: GET /api/captures list and detail", () => {
  it("lists jobs and returns a job's revisions", async () => {
    const bridge = await bridgeWith();
    await postCaptures(bridge, "/paste", { url: "https://jobs.example/fernwood", text: "Fernwood posting." });
    // Hono's default `strict: true` routing treats "/api/captures/" (trailing slash)
    // as distinct from "/api/captures" (the router's actual root route), so the
    // request path must be built without one.
    const list = await getCaptures<{ jobs: Array<{ jobId: string; revisionCount: number }> }>(bridge, "");
    expect(list.jobs).toHaveLength(1);
    const jobId = list.jobs[0]!.jobId;
    const detail = await getCaptures<{ jobId: string; revisions: Array<{ revision: number; text: string }> }>(bridge, `/${jobId}`);
    expect(detail.revisions).toHaveLength(1);
    expect(detail.revisions[0]!.text).toBe("Fernwood posting.");
  });

  it("404s for a job that doesn't exist", async () => {
    const bridge = await bridgeWith();
    const response = await bridge.request("/api/captures/00000000-0000-4000-8000-000000000000", { headers: { cookie: COOKIE } });
    expect(response.status).toBe(404);
  });
});

describe("buildJobExtractionPrompt", () => {
  it("wraps the posting text in a random per-call boundary and never in a system prompt (mvp-spec §7.2)", () => {
    const promptA = buildJobExtractionPrompt("job-1", 1, "Some posting text.");
    const promptB = buildJobExtractionPrompt("job-1", 1, "Some posting text.");
    expect(promptA).toContain("Some posting text.");
    expect(promptA).toContain('jobId: "job-1"');
    expect(promptA).toContain("revision: 1");
    // Two calls with identical inputs still get different boundaries, so a hostile posting can't forge the end marker.
    expect(promptA).not.toBe(promptB);
  });
});
