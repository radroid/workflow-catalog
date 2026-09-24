import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_JOB_CAPTURE_URL_LENGTH, type JobStructured } from "@workflow-catalog/contracts";
import type { Client, ClientSession, MessageResponse, MessageStreamEvent } from "eve/client";
import { describe, expect, it } from "vitest";
import { HOSTILE_JOB_STRUCTURED } from "../eval-agent/agent/lib/fixtures/jobs.ts";
import type { SafeFetchResult } from "../lib/safe-fetch.ts";
import type { EveGateway } from "../server/eve-gateway.ts";
import { UI_COOKIE } from "../server/local-ui.ts";
import capturesModule, { buildJobExtractionPrompt, captureAndExtract, createCapturesRouteModule, runExtraction, waitForExtractionQueue } from "../server/routes/captures.ts";
import type { LoadedRouteModule } from "../server/route-modules.ts";
import { JobsStore } from "../store/jobs.ts";
import { renderProfileMarkdown } from "../store/profile-markdown.ts";
import { ProfileStore } from "../store/profile.ts";
import { BRIDGE, jobCapture, makeBridge, pairDevice, postEvent, UI_TOKEN, type TestBridge } from "./helpers.ts";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "job-assistant", "fixtures");
const NORTHWIND_TEXT = readFileSync(path.join(FIXTURES_DIR, "job-posting-northwind.txt"), "utf8");
const HOSTILE_TEXT = readFileSync(path.join(FIXTURES_DIR, "job-posting-hostile.txt"), "utf8");

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

describe("captures.ts: extraction is queued and runs in the background through runTurn when content changed", () => {
  it("persists structured fields via the real extract_job tool round trip", async () => {
    const ref: { store?: JobsStore } = {};
    const { eve, calls } = fakeEve(extractingScript(() => ref.store!, NORTHWIND_STRUCTURED));
    const withEve = await bridgeWith(eve);
    ref.store = new JobsStore(withEve.workspace);
    const { token } = await pairDevice(withEve);
    const response = await postEvent(withEve, token, jobCapture({ text: "Staff Platform Engineer at Northwind Labs." }));
    const body = (await response.json()) as { result: { jobId: string; revision: number; extraction?: { status: string } } };
    expect(body.result.extraction?.status).toBe("waiting"); // queued, not finished, by the time the response arrives
    await waitForExtractionQueue(withEve.workspace.root);
    expect(calls).toHaveLength(1);
    const snapshot = await ref.store.getSnapshot(body.result.jobId, body.result.revision);
    expect(snapshot?.structured).toEqual(NORTHWIND_STRUCTURED);
  });

  it("delivers the posting text only as user-turn data (mutation target: 'put the posting text into the instructions')", async () => {
    const ref: { store?: JobsStore } = {};
    const { eve, calls } = fakeEve(extractingScript(() => ref.store!, NORTHWIND_STRUCTURED));
    const bridge = await bridgeWith(eve);
    ref.store = new JobsStore(bridge.workspace);
    const { token } = await pairDevice(bridge);
    const text = "Staff Platform Engineer at Northwind Labs. Fictional posting for the mutation-proof test.";
    await postEvent(bridge, token, jobCapture({ text }));
    await waitForExtractionQueue(bridge.workspace.root);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(text);
    expect(calls[0]).toContain("--- POSTING-"); // the random per-call boundary (buildJobExtractionPrompt)
  });

  it("does not re-run extraction when the capture is an unchanged duplicate (no new revision)", async () => {
    const ref: { store?: JobsStore } = {};
    const { eve, calls } = fakeEve(extractingScript(() => ref.store!, NORTHWIND_STRUCTURED));
    const bridge = await bridgeWith(eve);
    ref.store = new JobsStore(bridge.workspace);
    const { token } = await pairDevice(bridge);
    const capture = jobCapture();
    await postEvent(bridge, token, capture);
    await postEvent(bridge, token, jobCapture({ ...capture, eventId: randomUUID() })); // same url+text, new eventId: same content hash, no new revision
    await waitForExtractionQueue(bridge.workspace.root);
    expect(calls).toHaveLength(1); // extraction ran only for the first (content-changing) capture
  });

  it("the event response arrives before a slow fake turn finishes (round-1 review L5)", async () => {
    let resolveTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    const { eve } = fakeEve(async () => {
      await turnGate; // never resolves on its own: if the route awaited this turn, the request below would hang
      return [turnCompleted(), sessionWaiting()];
    });
    const bridge = await bridgeWith(eve);
    const { token } = await pairDevice(bridge);

    const response = await postEvent(bridge, token, jobCapture());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { jobId: string; revision: number; extraction?: { status: string } } };
    expect(body.result.extraction?.status).toBe("waiting");

    const store = new JobsStore(bridge.workspace);
    const midFlight = await store.getExtractionState(body.result.jobId, body.result.revision);
    expect(midFlight && ["waiting", "running"].includes(midFlight.status)).toBe(true); // still not done — the response did not wait for the turn

    resolveTurn();
    await waitForExtractionQueue(bridge.workspace.root);
    const finished = await store.getExtractionState(body.result.jobId, body.result.revision);
    expect(finished).toMatchObject({ status: "failed", reason: "no_fields_found" }); // the scripted turn above never calls extract_job
  });

  it("a turn that isn't ok records no fields, even when a tool call inside it looked successful (mutation target: 'count a non-ok turn as extracted')", async () => {
    // The fake eve must actually be wired into the bridge: bridgeWith() with no eve makes runTurn report
    // "failed" on its own (eve not running) before ever reading an event, which would let this test pass
    // for the wrong reason and never exercise the turn.failed classification the mutation targets. The
    // scripted extract_job call below reports persisted: true for the exact jobId/revision asked about —
    // a script with no tool call at all (as an earlier version of this test used) can't tell "checks
    // result.status" apart from "doesn't": with nothing for persistedJobExtraction to find either way,
    // dropping the status check wouldn't have changed the outcome (confirmed: it didn't fail the mutated
    // code). A turn that still fails *after* a tool ran (a cancel, a later step's failure) is the real
    // case the status gate exists for.
    const jobId = randomUUID();
    const revision = 1;
    const { eve } = fakeEve(async () => [
      started(),
      actionResult("extract_job", { jobId, revision, persisted: true, message: "Saved the extracted fields." }),
      completedUsage(),
      turnFailed(),
      sessionWaiting(),
    ]);
    const bridge = await bridgeWith(eve);
    const outcome = await runExtraction(bridge.ctx, jobId, revision, "some text");
    expect(outcome.status).toBe("not_extracted");
  });

  it("a turn with no successful extract_job call records no fields", async () => {
    const { eve } = fakeEve(async () => [started(), turnCompleted(), sessionWaiting()]); // no tool call at all
    const bridge = await bridgeWith(eve);
    const outcome = await runExtraction(bridge.ctx, randomUUID(), 1, "some text");
    expect(outcome.status).toBe("not_extracted");
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
    // Each captureAndExtract call above only *queues* its extraction (round-1 review L5); EXTRACTION_CHAINS
    // serializes all three onto the same per-workspace chain in the order they were queued, so draining once
    // here — after all three have been queued — waits for all three, not just the last.
    await waitForExtractionQueue(ctxWithEve.workspace.root);

    for (const queued of [viaExtension, viaPaste, viaUrlFetch]) {
      const snapshot = await store.getSnapshot(queued.capture.jobId, queued.capture.revision);
      expect(snapshot?.text).toBe(text);
      expect(snapshot?.contentHash).toBe(viaExtension.capture.snapshot.contentHash);
      expect(snapshot?.structured).toEqual(NORTHWIND_STRUCTURED);
    }
  });

  it("the three real routes (extension event, paste form, URL fetch) store job-posting-northwind.txt identically (round-1 review L7)", async () => {
    // A factory, not context.ts (L7): this fake stands in for safeFetch so the URL-fetch route can be driven
    // through its own real handler — including its own extractReadableText/.trim() step — without a real
    // network call, the same fixture the extension and paste paths receive directly.
    const fakeFetchUrl = async (url: string): Promise<SafeFetchResult> => ({ ok: true, status: 200, contentType: "text/plain", text: NORTHWIND_TEXT, finalUrl: url });
    const modules: readonly LoadedRouteModule[] = [{ name: "captures", module: createCapturesRouteModule(fakeFetchUrl) }];
    const bridge = await makeBridge({ modules });
    const { token } = await pairDevice(bridge);

    const eventResponse = await postEvent(bridge, token, jobCapture({ url: "https://jobs.example/via-event", text: NORTHWIND_TEXT }));
    const eventBody = (await eventResponse.json()) as { result: { jobId: string; revision: number } };

    const pasteResponse = await postCaptures(bridge, "/paste", { url: "https://jobs.example/via-paste", text: NORTHWIND_TEXT });
    const pasteBody = (await pasteResponse.json()) as { job: { jobId: string; revision: number } };

    const urlResponse = await postCaptures(bridge, "/url", { url: "https://jobs.example/via-url" });
    expect(urlResponse.status).toBe(200);
    const urlBody = (await urlResponse.json()) as { job: { jobId: string; revision: number } };

    const store = new JobsStore(bridge.workspace);
    const eventSnapshot = await store.getSnapshot(eventBody.result.jobId, eventBody.result.revision);
    const pasteSnapshot = await store.getSnapshot(pasteBody.job.jobId, pasteBody.job.revision);
    const urlSnapshot = await store.getSnapshot(urlBody.job.jobId, urlBody.job.revision);

    // The fixture ends in a trailing newline; the extension and paste paths receive it exactly as written, while
    // the URL route's own extractReadableText(...).trim() already strips it before this ever reaches
    // captureAndExtract. Without a shared rule (L7), the first two would store a different (longer) text and
    // content hash than the third for what is otherwise the same posting.
    expect(eventSnapshot?.text.endsWith("\n")).toBe(false);
    expect(pasteSnapshot?.text).toBe(eventSnapshot?.text);
    expect(urlSnapshot?.text).toBe(eventSnapshot?.text);
    expect(pasteSnapshot?.contentHash).toBe(eventSnapshot?.contentHash);
    expect(urlSnapshot?.contentHash).toBe(eventSnapshot?.contentHash);
  });
});

describe("captures.ts: hostile posting through the real capture path (route-level, round-1 review L9)", () => {
  /**
   * `test/extract-job-logic.test.ts`'s own hostile-fixture test already
   * proves `persistExtractedJob` itself never touches the career profile,
   * called directly. `eval-agent/evals/job-extraction.eval.ts`'s hostile
   * scenario proves the same tool call against a real model turn, but
   * shares its workspace with `onboarding-extraction.eval.ts` (that file's
   * own comment explains why), so it cannot check the profile hash there.
   * This is the missing middle: a fast, deterministic Vitest test that
   * drives the real fixture file through the real HTTP capture path (the
   * extension event, the background extraction queue, and a scripted turn
   * standing in for the model) end to end, in a private workspace where the
   * profile hash can actually be checked before and after.
   */
  it("job-posting-hostile.txt captured via the extension event persists only the legitimate fields, from exactly one tool call, and never touches the career profile", async () => {
    const ref: { store?: JobsStore } = {};
    const { eve, calls } = fakeEve(extractingScript(() => ref.store!, HOSTILE_JOB_STRUCTURED));
    const bridge = await bridgeWith(eve);
    ref.store = new JobsStore(bridge.workspace);
    const { token } = await pairDevice(bridge);

    const profileStore = new ProfileStore(bridge.workspace, bridge.clock);
    const before = ProfileStore.markdownHash(renderProfileMarkdown((await profileStore.load()).profile));

    const response = await postEvent(bridge, token, jobCapture({ url: "https://jobs.example/ledgerkit/backend-engineer", text: HOSTILE_TEXT }));
    const body = (await response.json()) as { result: { jobId: string; revision: number } };
    await waitForExtractionQueue(bridge.workspace.root);

    // extractingScript's fake turn only ever emits one extract_job call — this is the "fields only, no other tool"
    // property `job-extraction.eval.ts` checks against a real model turn, reproduced here against the real route.
    expect(calls).toHaveLength(1);
    const snapshot = await ref.store.getSnapshot(body.result.jobId, body.result.revision);
    expect(snapshot?.structured).toEqual(HOSTILE_JOB_STRUCTURED);
    expect(JSON.stringify(snapshot?.structured ?? {})).not.toContain("open_application_group");

    const after = ProfileStore.markdownHash(renderProfileMarkdown((await profileStore.load()).profile));
    expect(after).toBe(before); // a private workspace, not job-extraction.eval.ts's shared one — this is checkable deterministically
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

  it("the posting text sits only between a matching START/END marker pair sharing one token (round-1 review L8, mutation target: 'posting text moved out of the boundary block')", () => {
    const text = "Some posting text that must never appear outside its own boundary.";
    const prompt = buildJobExtractionPrompt("job-1", 1, text);

    const start = /--- (POSTING-\S+) START ---/.exec(prompt);
    const end = /--- (POSTING-\S+) END ---/.exec(prompt);
    expect(start).not.toBeNull();
    expect(end).not.toBeNull();
    expect(start![1]).toBe(end![1]); // the same token opens and closes the block — a hostile posting can't forge a matching END of its own

    const startOfBlock = start!.index + start![0].length;
    const endOfBlock = end!.index;
    expect(startOfBlock).toBeLessThan(endOfBlock);

    // Exactly one occurrence in the whole prompt, and it sits strictly inside [startOfBlock, endOfBlock) — not
    // duplicated, and not moved out of the block the model is told to treat as data rather than instructions.
    expect(prompt.split(text).length - 1).toBe(1);
    const textIndex = prompt.indexOf(text);
    expect(textIndex).toBeGreaterThanOrEqual(startOfBlock);
    expect(textIndex + text.length).toBeLessThanOrEqual(endOfBlock);
    expect(prompt.slice(0, startOfBlock)).not.toContain(text);
    expect(prompt.slice(endOfBlock)).not.toContain(text);
  });
});

describe("captures.ts: stored URLs drop userinfo and fragment (round-1 review L10)", () => {
  it("the extension event path strips userinfo and fragment before storing", async () => {
    const bridge = await bridgeWith();
    const { token } = await pairDevice(bridge);
    const response = await postEvent(bridge, token, jobCapture({ url: "https://user:pass@jobs.example/posting#section-2", text: "Some posting text." }));
    const body = (await response.json()) as { result: { jobId: string; revision: number } };
    const store = new JobsStore(bridge.workspace);
    const snapshot = await store.getSnapshot(body.result.jobId, body.result.revision);
    expect(snapshot?.url).toBe("https://jobs.example/posting");
  });

  it("the paste path strips userinfo and fragment before storing", async () => {
    const bridge = await bridgeWith();
    const response = await postCaptures(bridge, "/paste", { url: "https://user:pass@jobs.example/pasted#frag", text: "Pasted posting text." });
    const body = (await response.json()) as { job: { url: string } };
    expect(body.job.url).toBe("https://jobs.example/pasted");
  });

  it("the URL-fetch path strips userinfo and fragment from the *final* URL after a redirect, not just the requested one", async () => {
    const fakeFetchUrl = async (): Promise<SafeFetchResult> => ({
      ok: true,
      status: 200,
      contentType: "text/plain",
      text: "Fetched posting text.",
      finalUrl: "https://user:pass@jobs.example/final-page#section",
    });
    const modules: readonly LoadedRouteModule[] = [{ name: "captures", module: createCapturesRouteModule(fakeFetchUrl) }];
    const bridge = await makeBridge({ modules });
    const response = await postCaptures(bridge, "/url", { url: "https://jobs.example/start-page" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { job: { url: string } };
    expect(body.job.url).toBe("https://jobs.example/final-page");
  });

  it("refuses a final URL that is still too long even after stripping userinfo and fragment", async () => {
    // The host alone is over the cap, so stripping the (short) fragment below could never have rescued it — this
    // is genuinely a too-long address, not a false positive from counting characters this rule already drops.
    const hugeHost = `${"a".repeat(MAX_JOB_CAPTURE_URL_LENGTH)}.example`;
    const fakeFetchUrl = async (): Promise<SafeFetchResult> => ({
      ok: true,
      status: 200,
      contentType: "text/plain",
      text: "Fetched posting text.",
      finalUrl: `https://${hugeHost}/#frag`,
    });
    const modules: readonly LoadedRouteModule[] = [{ name: "captures", module: createCapturesRouteModule(fakeFetchUrl) }];
    const bridge = await makeBridge({ modules });
    const response = await postCaptures(bridge, "/url", { url: "https://jobs.example/start-page" });
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("url_too_large");
  });

  it("two captures of the same page differing only by fragment are the same job, with no new revision (a fragment carries no identity)", async () => {
    const bridge = await bridgeWith();
    const { token } = await pairDevice(bridge);
    const first = await postEvent(bridge, token, jobCapture({ url: "https://jobs.example/same-page#a", text: "Same text." }));
    const firstBody = (await first.json()) as { result: { jobId: string } };
    const second = await postEvent(bridge, token, jobCapture({ url: "https://jobs.example/same-page#b", text: "Same text.", eventId: randomUUID() }));
    const secondBody = (await second.json()) as { result: { jobId: string; contentChanged: boolean } };
    expect(secondBody.result.jobId).toBe(firstBody.result.jobId);
    expect(secondBody.result.contentChanged).toBe(false);
  });
});
