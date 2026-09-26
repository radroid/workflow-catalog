import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_JOB_CAPTURE_URL_LENGTH, type JobSnapshot, type JobStructured } from "@workflow-catalog/contracts";
import type { Client, ClientSession, MessageResponse, MessageStreamEvent } from "eve/client";
import { describe, expect, it } from "vitest";
import { checkExtractedJob } from "../agent/lib/extract-job-logic.ts";
import type { ExtractJobOutput } from "../agent/lib/extract-job-schema.ts";
import { HOSTILE_JOB_STRUCTURED } from "../eval-agent/agent/lib/fixtures/jobs.ts";
import { normalizePostingText } from "../lib/readable-text.ts";
import type { SafeFetchResult } from "../lib/safe-fetch.ts";
import type { EveGateway } from "../server/eve-gateway.ts";
import { UI_COOKIE } from "../server/local-ui.ts";
import capturesModule, {
  buildJobExtractionPrompt,
  captureAndExtract,
  createCapturesRouteModule,
  describeExtractionState,
  runExtraction,
  waitForExtractionQueue,
  type ShownExtractionState,
} from "../server/routes/captures.ts";
import type { LoadedRouteModule } from "../server/route-modules.ts";
import { getBudgetState } from "../store/budget.ts";
import { JobsStore, type ExtractionState, type UnreadableSnapshot } from "../store/jobs.ts";
import { renderProfileMarkdown } from "../store/profile-markdown.ts";
import { ProfileStore } from "../store/profile.ts";
import { BRIDGE, jobCapture, makeBridge, pairDevice, postEvent, UI_TOKEN, type TestBridge } from "./helpers.ts";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "job-assistant", "fixtures");
const NORTHWIND_TEXT = readFileSync(path.join(FIXTURES_DIR, "job-posting-northwind.txt"), "utf8");
const HOSTILE_TEXT = readFileSync(path.join(FIXTURES_DIR, "job-posting-hostile.txt"), "utf8");
/** The round-2 reviewer's variant (issue 5): a double space, trailing spaces, and CRLF line ends. */
const NORTHWIND_WHITESPACE_VARIANT = NORTHWIND_TEXT.replace(" ", "  ").replace("\n", "   \n").replace(/\n/g, "\r\n");

/**
 * `/api/captures` and the `job_capture` event handler (P04). The extension
 * path is exercised through `postEvent`/`jobCapture` (test/helpers.ts); the
 * local-UI paste and URL-fetch forms through the same `SAME_ORIGIN` header
 * pattern `onboarding-routes.test.ts` uses. A fake `EveGateway` scripts the
 * extraction turn event by event, matching how `runTurn` consumes
 * `created.response` (`for await`).
 *
 * Round-2 T1: a scripted turn never writes fields itself. Where it stands in
 * for a model that calls `extract_job`, it runs the real tool's check
 * (`checkExtractedJob`) against the bridge's own workspace, exactly as the
 * tool's step would inside eve, and puts that real output in the turn's
 * `action.result` event. Only the capture route saves fields, from that
 * event, after the turn ended ok.
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
  return { type: "turn.failed", data: { code: "MODEL_CALL_FAILED", message: "The model declined to answer.", sequence: 4, turnId: "t1" }, meta: META };
}
/** eve's primary provider-limit signal (run-harness.ts; its own tests use the same shape). */
function providerLimited(): MessageStreamEvent {
  return { type: "turn.failed", data: { code: "MODEL_CALL_FAILED", message: "AI Gateway rate-limited the request.", details: { semanticErrorId: "gateway-rate-limited" }, sequence: 4, turnId: "t1" }, meta: META };
}

type Script = (message: string) => Promise<readonly MessageStreamEvent[]> | readonly MessageStreamEvent[];

/** A fake eve gateway consumed event by event, the way `runTurn` (`for await (const event of created.response)`) reads it. */
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

interface ToolScriptOptions {
  /** How the turn ends after the tool call: ok (the default), or a turn failure. */
  readonly end?: "ok" | "failed";
  /** Runs after the tool returned and before the turn ends: a test holds the turn open here. */
  readonly beforeEnd?: () => Promise<void>;
  /** Collects each real tool output, so a test can check the tool really accepted the fields. */
  readonly outputs?: ExtractJobOutput[];
}

/**
 * A model turn that calls `extract_job` for real: jobId/revision come back
 * out of the prompt (as a model reports them), the real tool check runs
 * against the bridge's own store, and its real output becomes the turn's
 * `action.result`. The store is a getter because the fake eve must exist
 * before the bridge (and its workspace) does.
 */
function toolScript(getStore: () => JobsStore, structured: JobStructured, options: ToolScriptOptions = {}): Script {
  return async (message) => {
    const jobId = /jobId: "([0-9a-f-]{36})"/.exec(message)?.[1];
    const revision = Number(/revision: (\d+)/.exec(message)?.[1] ?? "0");
    if (!jobId || !revision) return [turnCompleted(), sessionWaiting()];
    const output = await checkExtractedJob({ jobId, revision, structured }, getStore());
    options.outputs?.push(output);
    await options.beforeEnd?.();
    const end = options.end === "failed" ? [turnFailed(), sessionWaiting()] : [completedUsage(), turnCompleted(), sessionWaiting()];
    return [started(), actionResult("extract_job", output), ...end];
  };
}

/** Each call runs the next script; the last one repeats. */
function sequence(scripts: readonly Script[]): Script {
  let index = 0;
  return (message) => scripts[Math.min(index++, scripts.length - 1)]!(message);
}

function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

async function bridgeWith(eve?: EveGateway): Promise<TestBridge> {
  return makeBridge({ modules: MODULES, eve });
}

/** A bridge whose fake eve runs `makeScript(getStore)`, with the store over that same bridge's workspace. */
async function bridgeWithScript(makeScript: (getStore: () => JobsStore) => Script, modules: readonly LoadedRouteModule[] = MODULES): Promise<{ bridge: TestBridge; calls: string[]; store: JobsStore }> {
  const holder: { store?: JobsStore } = {};
  const { eve, calls } = fakeEve(makeScript(() => holder.store!));
  const bridge = await makeBridge({ modules, eve });
  holder.store = new JobsStore(bridge.workspace);
  return { bridge, calls, store: holder.store };
}

function postCaptures(bridge: TestBridge, pathname: string, body: unknown): Promise<Response> {
  return bridge.request(`/api/captures${pathname}`, { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify(body) });
}

async function getCaptures<T>(bridge: TestBridge, pathname: string): Promise<T> {
  return (await (await bridge.request(`/api/captures${pathname}`, { headers: { cookie: COOKIE } })).json()) as T;
}

interface EventResult {
  readonly jobId: string;
  readonly revision: number;
  readonly contentChanged: boolean;
  readonly extraction?: ShownExtractionState;
}

async function captureByEvent(bridge: TestBridge, token: string, overrides: Parameters<typeof jobCapture>[0] = {}): Promise<EventResult> {
  const response = await postEvent(bridge, token, jobCapture(overrides));
  expect(response.status).toBe(200);
  return ((await response.json()) as { result: EventResult }).result;
}

interface CaptureBody {
  readonly ok: boolean;
  readonly message: string;
  readonly contentChanged: boolean;
  readonly extraction?: ShownExtractionState;
  readonly job: JobSnapshot;
}

interface ListBody {
  readonly jobs: ReadonlyArray<{
    readonly jobId: string;
    readonly revisionCount: number;
    readonly latestRevision: number;
    readonly latest?: JobSnapshot;
    readonly url?: string;
    readonly savedAt?: string;
    readonly unreadable: readonly UnreadableSnapshot[];
    readonly extraction: ShownExtractionState | null;
  }>;
}

interface DetailBody {
  readonly jobId: string;
  readonly latestRevision: number;
  readonly revisions: readonly JobSnapshot[];
  readonly extraction: ReadonlyArray<ShownExtractionState | null>;
  readonly unreadable: readonly UnreadableSnapshot[];
}

function retryPath(jobId: string, revision: number): string {
  return `/${jobId}/${revision}/extract`;
}

const NORTHWIND_STRUCTURED: JobStructured = { title: "Staff Platform Engineer", company: "Northwind Labs", requirements: ["8+ years"] };
const NORTHWIND_REVISED: JobStructured = { title: "Principal Platform Engineer", company: "Northwind Labs", requirements: ["10+ years"] };

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
    const secondBody = (await second.json()) as { duplicate: boolean; result: { jobId: string } };
    expect(secondBody.duplicate).toBe(true);
    const store = new JobsStore(bridge.workspace);
    expect(await store.getJobRevisions(secondBody.result.jobId)).toHaveLength(1);
  });

  it("the same URL with a different content hash creates revision 2, and revision 1 is retained", async () => {
    const bridge = await bridgeWith();
    const { token } = await pairDevice(bridge);
    const url = "https://jobs.example/northwind-labs/staff-platform-engineer";
    const first = await captureByEvent(bridge, token, { url, text: "Original text." });
    const second = await captureByEvent(bridge, token, { url, text: "Updated text." });
    expect(second.jobId).toBe(first.jobId);
    expect(second.revision).toBe(2);
    const store = new JobsStore(bridge.workspace);
    expect((await store.getSnapshot(first.jobId, 1))?.text).toBe("Original text.");
    expect((await store.getSnapshot(first.jobId, 2))?.text).toBe("Updated text.");
  });

  it.each(["javascript:alert(1)", "file:///etc/passwd"])("rejects a %s URL before it ever reaches the handler (contract validation, round-1 review L11)", async (url) => {
    const bridge = await bridgeWith();
    const { token } = await pairDevice(bridge);
    const response = await postEvent(bridge, token, { ...jobCapture(), url });
    expect(response.status).toBe(400);
  });

  it("refuses whitespace-only text with a typed 422 the extension never retries, journaled as rejected, never handler_failed (round-2 T5)", async () => {
    const bridge = await bridgeWith();
    const { token } = await pairDevice(bridge);
    const capture = jobCapture({ text: " \r\n\t  \n " });
    const response = await postEvent(bridge, token, capture);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ ok: false, duplicate: false, error: { code: "empty_text" } });
    // The journal recorded a rejection (not a failure): a replay is answered from it, and the handler never runs again.
    const replay = await postEvent(bridge, token, capture);
    expect(replay.status).toBe(422);
    expect(await replay.json()).toMatchObject({ ok: false, duplicate: true, error: { code: "empty_text" } });
    expect(await new JobsStore(bridge.workspace).listJobs()).toEqual([]);
  });
});

describe("captures.ts: extraction is queued and runs in the background through runTurn when content changed", () => {
  it("saves the fields from the turn's own extract_job result once the turn ends ok (round-2 T1)", async () => {
    const outputs: ExtractJobOutput[] = [];
    const { bridge, calls, store } = await bridgeWithScript((getStore) => toolScript(getStore, NORTHWIND_STRUCTURED, { outputs }));
    const { token } = await pairDevice(bridge);
    const result = await captureByEvent(bridge, token, { text: "Staff Platform Engineer at Northwind Labs." });
    expect(result.extraction).toMatchObject({ status: "waiting" }); // queued, not finished, by the time the response arrives
    await waitForExtractionQueue(bridge.workspace.root);
    expect(calls).toHaveLength(1);
    expect(outputs).toEqual([expect.objectContaining({ accepted: true, structured: NORTHWIND_STRUCTURED })]);
    expect((await store.getSnapshot(result.jobId, result.revision))?.structured).toEqual(NORTHWIND_STRUCTURED);
    expect(await store.getExtractionState(result.jobId, result.revision)).toMatchObject({ status: "done" });
  });

  it("delivers the posting text only as user-turn data (mutation target: 'put the posting text into the instructions')", async () => {
    const { bridge, calls } = await bridgeWithScript((getStore) => toolScript(getStore, NORTHWIND_STRUCTURED));
    const { token } = await pairDevice(bridge);
    const text = "Staff Platform Engineer at Northwind Labs. Fictional posting for the mutation-proof test.";
    await captureByEvent(bridge, token, { text });
    await waitForExtractionQueue(bridge.workspace.root);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(text);
    expect(calls[0]).toContain("--- POSTING-"); // the random per-call boundary (buildJobExtractionPrompt)
  });

  it("does not re-run extraction when the capture is an unchanged duplicate (no new revision)", async () => {
    const { bridge, calls } = await bridgeWithScript((getStore) => toolScript(getStore, NORTHWIND_STRUCTURED));
    const { token } = await pairDevice(bridge);
    const capture = jobCapture();
    await postEvent(bridge, token, capture);
    await postEvent(bridge, token, jobCapture({ ...capture, eventId: randomUUID() })); // same url+text, new eventId: same content hash, no new revision
    await waitForExtractionQueue(bridge.workspace.root);
    expect(calls).toHaveLength(1); // extraction ran only for the first (content-changing) capture
  });

  it("the event response arrives before a slow fake turn finishes, and the revision reads as waiting or running meanwhile (round-1 review L5)", async () => {
    const release = gate();
    const { eve } = fakeEve(async () => {
      await release.opened; // never opens on its own: if the route awaited this turn, the request below would hang
      return [turnCompleted(), sessionWaiting()];
    });
    const bridge = await bridgeWith(eve);
    const { token } = await pairDevice(bridge);

    const result = await captureByEvent(bridge, token);
    expect(result.extraction).toMatchObject({ status: "waiting" });

    const midFlight = await describeExtractionState(bridge.ctx, result.jobId, result.revision);
    expect(["waiting", "running"]).toContain(midFlight?.status); // this process owns it: never read as interrupted

    release.open();
    await waitForExtractionQueue(bridge.workspace.root);
    expect(await describeExtractionState(bridge.ctx, result.jobId, result.revision)).toMatchObject({ status: "failed", reason: "no_fields_found" }); // the turn above never calls extract_job
  });

  it("a Re-extract whose turn calls extract_job and then fails keeps the fields already saved (round-2 T1)", async () => {
    const outputs: ExtractJobOutput[] = [];
    const { bridge, calls, store } = await bridgeWithScript((getStore) =>
      sequence([toolScript(getStore, NORTHWIND_STRUCTURED, { outputs }), toolScript(getStore, NORTHWIND_REVISED, { outputs, end: "failed" })]),
    );
    const { token } = await pairDevice(bridge);
    const captured = await captureByEvent(bridge, token, { text: "Staff Platform Engineer at Northwind Labs." });
    await waitForExtractionQueue(bridge.workspace.root);
    expect((await store.getSnapshot(captured.jobId, captured.revision))?.structured).toEqual(NORTHWIND_STRUCTURED);

    const retry = await postCaptures(bridge, retryPath(captured.jobId, captured.revision), {});
    expect(retry.status).toBe(200);
    await waitForExtractionQueue(bridge.workspace.root);
    expect(calls).toHaveLength(2);
    // The retry's tool call really accepted the new fields; its turn then failed, so none of them were saved.
    expect(outputs[1]).toMatchObject({ accepted: true, structured: NORTHWIND_REVISED });
    expect((await store.getSnapshot(captured.jobId, captured.revision))?.structured).toEqual(NORTHWIND_STRUCTURED);
    expect(await store.getExtractionState(captured.jobId, captured.revision)).toMatchObject({ status: "failed", reason: "turn_failed" });
  });

  it("during a running Re-extract the previous fields are shown, and the new ones only once its turn ends ok (round-2 T1)", async () => {
    const release = gate();
    const toolCalled = gate();
    const { bridge, calls, store } = await bridgeWithScript((getStore) =>
      sequence([
        toolScript(getStore, NORTHWIND_STRUCTURED),
        toolScript(getStore, NORTHWIND_REVISED, {
          beforeEnd: async () => {
            toolCalled.open();
            await release.opened;
          },
        }),
      ]),
    );
    const { token } = await pairDevice(bridge);
    const captured = await captureByEvent(bridge, token, { text: "Staff Platform Engineer at Northwind Labs." });
    await waitForExtractionQueue(bridge.workspace.root);

    const retry = await postCaptures(bridge, retryPath(captured.jobId, captured.revision), {});
    expect(((await retry.json()) as CaptureBody).extraction).toMatchObject({ status: "waiting" });
    await toolCalled.opened; // the Re-extract's turn has called extract_job (accepted) and is still running

    const during = await getCaptures<DetailBody>(bridge, `/${captured.jobId}`);
    expect(during.revisions[0]!.structured).toEqual(NORTHWIND_STRUCTURED);
    expect(during.extraction[0]).toMatchObject({ status: "running" });
    const listed = await getCaptures<ListBody>(bridge, "");
    expect(listed.jobs[0]!.latest?.structured).toEqual(NORTHWIND_STRUCTURED);
    expect(listed.jobs[0]!.extraction).toMatchObject({ status: "running" });

    release.open();
    await waitForExtractionQueue(bridge.workspace.root);
    expect(calls).toHaveLength(2);
    expect((await store.getSnapshot(captured.jobId, captured.revision))?.structured).toEqual(NORTHWIND_REVISED);
    expect(await store.getExtractionState(captured.jobId, captured.revision)).toMatchObject({ status: "done" });
  });

  it("a turn that isn't ok counts as not extracted, even with an accepted extract_job result inside it (mutation target: 'count a non-ok turn as extracted')", async () => {
    const jobId = randomUUID();
    const revision = 1;
    const { eve } = fakeEve(async () => [
      started(),
      actionResult("extract_job", { jobId, revision, accepted: true, message: "Fields accepted.", structured: NORTHWIND_STRUCTURED }),
      completedUsage(),
      turnFailed(),
      sessionWaiting(),
    ]);
    const bridge = await bridgeWith(eve);
    expect(await runExtraction(bridge.ctx, jobId, revision, "some text")).toEqual({ status: "not_extracted", reason: "turn_failed" });
  });

  it("an ok turn returns the accepted fields for exactly this job and revision", async () => {
    const jobId = randomUUID();
    const { eve } = fakeEve(async () => [
      started(),
      actionResult("extract_job", { jobId, revision: 1, accepted: true, message: "Fields accepted.", structured: { title: "Revision one" } }),
      actionResult("extract_job", { jobId, revision: 2, accepted: true, message: "Fields accepted.", structured: NORTHWIND_STRUCTURED }),
      completedUsage(),
      turnCompleted(),
      sessionWaiting(),
    ]);
    const bridge = await bridgeWith(eve);
    expect(await runExtraction(bridge.ctx, jobId, 2, "some text")).toEqual({ status: "extracted", structured: NORTHWIND_STRUCTURED });
  });

  it("a turn with no successful extract_job call, or an empty one, finds no fields", async () => {
    const jobId = randomUUID();
    const noCall = fakeEve(async () => [started(), turnCompleted(), sessionWaiting()]);
    expect(await runExtraction((await bridgeWith(noCall.eve)).ctx, jobId, 1, "some text")).toEqual({ status: "not_extracted", reason: "no_fields_found" });
    const empty = fakeEve(async () => [started(), actionResult("extract_job", { jobId, revision: 1, accepted: true, message: "Fields accepted.", structured: { requirements: [] } }), turnCompleted(), sessionWaiting()]);
    expect(await runExtraction((await bridgeWith(empty.eve)).ctx, jobId, 1, "some text")).toEqual({ status: "not_extracted", reason: "no_fields_found" });
  });

  it("an ok turn that found nothing keeps the fields already saved", async () => {
    const { bridge, store } = await bridgeWithScript((getStore) => sequence([toolScript(getStore, NORTHWIND_STRUCTURED), toolScript(getStore, {})]));
    const { token } = await pairDevice(bridge);
    const captured = await captureByEvent(bridge, token, { text: "Staff Platform Engineer at Northwind Labs." });
    await waitForExtractionQueue(bridge.workspace.root);
    await postCaptures(bridge, retryPath(captured.jobId, captured.revision), {});
    await waitForExtractionQueue(bridge.workspace.root);
    expect((await store.getSnapshot(captured.jobId, captured.revision))?.structured).toEqual(NORTHWIND_STRUCTURED);
    expect(await store.getExtractionState(captured.jobId, captured.revision)).toMatchObject({ status: "failed", reason: "no_fields_found" });
  });

  it("a provider-limited turn gets its own reason, and runTurn has paused the budget", async () => {
    const limited = fakeEve(async () => [started(), providerLimited(), sessionWaiting()]);
    const bridge = await bridgeWith(limited.eve);
    expect(await runExtraction(bridge.ctx, randomUUID(), 1, "some text")).toEqual({ status: "not_extracted", reason: "provider_limit" });
    expect((await getBudgetState(bridge.workspace, bridge.clock)).paused).toBe(true); // runTurn's own pause, intended (P04 prompt)
  });
});

describe("captures.ts: a state from an earlier process reads as interrupted (round-2 T2)", () => {
  it.each<[string, Omit<ExtractionState, "updatedAt">]>([
    ["waiting", { status: "waiting", owner: "an-earlier-runner-process" }],
    ["running", { status: "running", owner: "an-earlier-runner-process" }],
    ["waiting, with no owner recorded", { status: "waiting" }],
  ])("a %s state left by an earlier process reads as interrupted everywhere, and a retry queues it again", async (_label, stale) => {
    const { bridge, calls, store } = await bridgeWithScript((getStore) => toolScript(getStore, NORTHWIND_STRUCTURED));
    const { token } = await pairDevice(bridge);
    const captured = await captureByEvent(bridge, token, { text: "Staff Platform Engineer at Northwind Labs." });
    await waitForExtractionQueue(bridge.workspace.root);
    expect(calls).toHaveLength(1);

    await store.setExtractionState(captured.jobId, captured.revision, { ...stale, updatedAt: "2026-09-22T08:00:00.000Z" } as ExtractionState);
    const detail = await getCaptures<DetailBody>(bridge, `/${captured.jobId}`);
    expect(detail.extraction[0]).toEqual({ status: "failed", reason: "interrupted", updatedAt: "2026-09-22T08:00:00.000Z" });
    const list = await getCaptures<ListBody>(bridge, "");
    expect(list.jobs[0]!.extraction).toEqual({ status: "failed", reason: "interrupted", updatedAt: "2026-09-22T08:00:00.000Z" });

    const retry = await postCaptures(bridge, retryPath(captured.jobId, captured.revision), {});
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as CaptureBody).extraction).toMatchObject({ status: "waiting" });
    await waitForExtractionQueue(bridge.workspace.root);
    expect(calls).toHaveLength(2);
    expect(await describeExtractionState(bridge.ctx, captured.jobId, captured.revision)).toMatchObject({ status: "done" });
  });

  it("a waiting state this process wrote carries its owner, which the API never shows", async () => {
    const release = gate();
    const { eve } = fakeEve(async () => {
      await release.opened;
      return [turnCompleted(), sessionWaiting()];
    });
    const bridge = await bridgeWith(eve);
    const { token } = await pairDevice(bridge);
    const first = await captureByEvent(bridge, token, { url: "https://jobs.example/harbor/first", text: "Harbor posting one." });
    const second = await captureByEvent(bridge, token, { url: "https://jobs.example/harbor/second", text: "Harbor posting two." });
    expect(second.extraction).toEqual({ status: "waiting", updatedAt: expect.any(String) }); // no owner in the API
    const onDisk = await new JobsStore(bridge.workspace).getExtractionState(second.jobId, second.revision);
    expect(onDisk).toMatchObject({ status: "waiting", owner: expect.stringMatching(/\S/) });
    expect((await getCaptures<DetailBody>(bridge, `/${second.jobId}`)).extraction[0]).toMatchObject({ status: "waiting" });
    release.open();
    await waitForExtractionQueue(bridge.workspace.root);
    expect((await getCaptures<DetailBody>(bridge, `/${first.jobId}`)).extraction[0]).toMatchObject({ status: "failed", reason: "no_fields_found" });
  });
});

describe("captures.ts: the queue checks again just before each turn (round-2 T3)", () => {
  it("the first turn hits a provider limit and pauses the budget; the second never starts, and records not run", async () => {
    const release = gate();
    const { bridge, calls } = await bridgeWithScript((getStore) =>
      sequence([
        async () => {
          await release.opened;
          return [started(), providerLimited(), sessionWaiting()];
        },
        toolScript(getStore, NORTHWIND_STRUCTURED),
      ]),
    );
    const first = (await (await postCaptures(bridge, "/paste", { url: "https://jobs.example/fernwood/first", text: "Fernwood posting one." })).json()) as CaptureBody;
    const second = (await (await postCaptures(bridge, "/paste", { url: "https://jobs.example/fernwood/second", text: "Fernwood posting two." })).json()) as CaptureBody;
    expect(first.extraction).toMatchObject({ status: "waiting" });
    expect(second.extraction).toMatchObject({ status: "waiting" }); // the budget was not paused yet when it was queued

    release.open();
    await waitForExtractionQueue(bridge.workspace.root);
    expect(calls).toHaveLength(1);
    expect(await describeExtractionState(bridge.ctx, first.job.jobId, first.job.revision)).toMatchObject({ status: "failed", reason: "provider_limit" });
    expect(await describeExtractionState(bridge.ctx, second.job.jobId, second.job.revision)).toMatchObject({ status: "not_run", reason: "budget_paused" });
    expect((await getBudgetState(bridge.workspace, bridge.clock)).paused).toBe(true);
  });

  it("a revision whose snapshot became unreadable while it waited records failed/unreadable, and no turn runs for it", async () => {
    const release = gate();
    const { bridge, calls } = await bridgeWithScript((getStore) =>
      sequence([
        async () => {
          await release.opened;
          return [turnCompleted(), sessionWaiting()];
        },
        toolScript(getStore, NORTHWIND_STRUCTURED),
      ]),
    );
    await postCaptures(bridge, "/paste", { url: "https://jobs.example/harbor/first", text: "Harbor posting one." });
    const second = (await (await postCaptures(bridge, "/paste", { url: "https://jobs.example/harbor/second", text: "Harbor posting two." })).json()) as CaptureBody;
    await writeFile(path.join(bridge.workspace.root, "jobs", second.job.jobId, "snapshot-1.json"), "{ not valid json");
    release.open();
    await waitForExtractionQueue(bridge.workspace.root);
    expect(calls).toHaveLength(1);
    expect(await describeExtractionState(bridge.ctx, second.job.jobId, 1)).toMatchObject({ status: "failed", reason: "unreadable" });
  });
});

describe("captures.ts: a revision already waiting or running isn't queued again (round-2 T9)", () => {
  it("two concurrent Re-extracts of one revision queue one turn, and a third while it runs queues nothing", async () => {
    const release = gate();
    const { bridge, calls, store } = await bridgeWithScript((getStore) => sequence([toolScript(getStore, NORTHWIND_STRUCTURED), toolScript(getStore, NORTHWIND_REVISED, { beforeEnd: () => release.opened })]));
    const { token } = await pairDevice(bridge);
    const captured = await captureByEvent(bridge, token, { text: "Staff Platform Engineer at Northwind Labs." });
    await waitForExtractionQueue(bridge.workspace.root);
    expect(calls).toHaveLength(1);

    const [a, b] = await Promise.all([postCaptures(bridge, retryPath(captured.jobId, captured.revision), {}), postCaptures(bridge, retryPath(captured.jobId, captured.revision), {})]);
    expect([a.status, b.status]).toEqual([200, 200]);
    for (const body of [(await a.json()) as CaptureBody, (await b.json()) as CaptureBody]) expect(["waiting", "running"]).toContain(body.extraction?.status);
    const third = (await (await postCaptures(bridge, retryPath(captured.jobId, captured.revision), {})).json()) as CaptureBody;
    expect(["waiting", "running"]).toContain(third.extraction?.status);

    release.open();
    await waitForExtractionQueue(bridge.workspace.root);
    expect(calls).toHaveLength(2);
    expect((await store.getSnapshot(captured.jobId, captured.revision))?.structured).toEqual(NORTHWIND_REVISED);
  });
});

describe("captures.ts: one text rule on every path (round-2 T5; F6 acceptance: three paths produce identical records)", () => {
  it("extension, paste, and URL-fetch text all extract to the same structured fields for the same posting text", async () => {
    const bridge = await bridgeWith();
    const store = new JobsStore(bridge.workspace);
    const { eve } = fakeEve(toolScript(() => store, NORTHWIND_STRUCTURED));
    const ctxWithEve = { ...bridge.ctx, eve };
    const text = "Staff Platform Engineer at Northwind Labs. Fictional posting used across all three capture paths.";

    const viaExtension = await captureAndExtract(ctxWithEve, { url: "https://jobs.example/via-extension", text, extractorVersion: "extension@1", capturedAt: "2026-09-22T09:00:00.000Z" });
    const viaPaste = await captureAndExtract(ctxWithEve, { url: "https://jobs.example/via-paste", text, extractorVersion: "paste@1", capturedAt: "2026-09-22T09:00:00.000Z" });
    const viaUrlFetch = await captureAndExtract(ctxWithEve, { url: "https://jobs.example/via-url-fetch", text, extractorVersion: "url-fetch@1", capturedAt: "2026-09-22T09:00:00.000Z" });
    // Each call only queues its extraction; EXTRACTION_CHAINS runs all three in order on one chain, so one drain waits for all three.
    await waitForExtractionQueue(ctxWithEve.workspace.root);

    for (const queued of [viaExtension, viaPaste, viaUrlFetch]) {
      const snapshot = await store.getSnapshot(queued.capture.jobId, queued.capture.revision);
      expect(snapshot?.text).toBe(text);
      expect(snapshot?.contentHash).toBe(viaExtension.capture.snapshot.contentHash);
      expect(snapshot?.structured).toEqual(NORTHWIND_STRUCTURED);
    }
  });

  it.each([
    ["job-posting-northwind.txt as written", NORTHWIND_TEXT],
    ["the same posting with a double space, trailing spaces and CRLF line ends", NORTHWIND_WHITESPACE_VARIANT],
  ])("the three real routes store %s with the same text and content hash as each other and as the normalized fixture", async (_label, text) => {
    const fakeFetchUrl = async (url: string): Promise<SafeFetchResult> => ({ ok: true, status: 200, contentType: "text/plain", text, finalUrl: url });
    const modules: readonly LoadedRouteModule[] = [{ name: "captures", module: createCapturesRouteModule(fakeFetchUrl) }];
    const bridge = await makeBridge({ modules });
    const { token } = await pairDevice(bridge);

    const viaEvent = await captureByEvent(bridge, token, { url: "https://jobs.example/via-event", text });
    const pasteBody = (await (await postCaptures(bridge, "/paste", { url: "https://jobs.example/via-paste", text })).json()) as CaptureBody;
    const urlResponse = await postCaptures(bridge, "/url", { url: "https://jobs.example/via-url" });
    expect(urlResponse.status).toBe(200);
    const urlBody = (await urlResponse.json()) as CaptureBody;

    const store = new JobsStore(bridge.workspace);
    const expected = normalizePostingText(NORTHWIND_TEXT);
    const snapshots = [await store.getSnapshot(viaEvent.jobId, viaEvent.revision), await store.getSnapshot(pasteBody.job.jobId, pasteBody.job.revision), await store.getSnapshot(urlBody.job.jobId, urlBody.job.revision)];
    for (const snapshot of snapshots) {
      expect(snapshot?.text).toBe(expected);
      expect(snapshot?.contentHash).toBe(snapshots[0]?.contentHash);
    }
    expect(expected).not.toContain("\r");
    expect(expected).not.toContain("  ");
    expect(expected.endsWith("\n")).toBe(false);
  });

  it("a re-paste that differs only in whitespace creates no revision and no new extraction", async () => {
    const { bridge, calls } = await bridgeWithScript((getStore) => toolScript(getStore, NORTHWIND_STRUCTURED));
    const url = "https://jobs.example/northwind-labs/staff-platform-engineer";
    const first = (await (await postCaptures(bridge, "/paste", { url, text: NORTHWIND_TEXT })).json()) as CaptureBody;
    await waitForExtractionQueue(bridge.workspace.root);
    const again = (await (await postCaptures(bridge, "/paste", { url, text: NORTHWIND_WHITESPACE_VARIANT })).json()) as CaptureBody;
    await waitForExtractionQueue(bridge.workspace.root);
    expect(again).toMatchObject({ contentChanged: false, job: { jobId: first.job.jobId, revision: 1 } });
    expect(again.message).toContain("hasn't changed");
    expect(again.extraction).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("refuses whitespace-only pasted text with a plain 400 (never a 500)", async () => {
    const bridge = await bridgeWith();
    const response = await postCaptures(bridge, "/paste", { url: "https://jobs.example/blank", text: " \r\n\t  \n " });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "empty_text" } });
    expect(await new JobsStore(bridge.workspace).listJobs()).toEqual([]);
  });

  it("captureAndExtract takes only text the shared rule already normalized, so no route can skip it unnoticed", async () => {
    const bridge = await bridgeWith();
    const capture = { url: "https://jobs.example/raw", extractorVersion: "t", capturedAt: "2026-09-22T09:00:00.000Z" };
    await expect(captureAndExtract(bridge.ctx, { ...capture, text: "Two  spaces." })).rejects.toThrow(/normalized/);
    await expect(captureAndExtract(bridge.ctx, { ...capture, text: "" })).rejects.toThrow(/normalized/);
    expect(await new JobsStore(bridge.workspace).listJobs()).toEqual([]);
  });
});

describe("captures.ts: hostile posting through the real capture path (route-level, round-1 review L9)", () => {
  /**
   * `test/extract-job-logic.test.ts`'s own hostile-fixture test proves the
   * tool's check never touches the career profile, called directly.
   * `eval-agent/evals/job-extraction.eval.ts`'s hostile scenario proves the
   * same tool call against a real eve turn, but shares its workspace with
   * `onboarding-extraction.eval.ts`, so it cannot check the profile hash
   * there. This drives the real fixture file through the real HTTP capture
   * path (the extension event, the background queue, and a scripted turn
   * that runs the real tool check) end to end, in a private workspace where
   * the profile hash can be checked before and after.
   */
  it("job-posting-hostile.txt captured via the extension event saves only the legitimate fields, from exactly one tool call, and never touches the career profile", async () => {
    const { bridge, calls, store } = await bridgeWithScript((getStore) => toolScript(getStore, HOSTILE_JOB_STRUCTURED));
    const { token } = await pairDevice(bridge);

    const profileStore = new ProfileStore(bridge.workspace, bridge.clock);
    const before = ProfileStore.markdownHash(renderProfileMarkdown((await profileStore.load()).profile));

    const result = await captureByEvent(bridge, token, { url: "https://jobs.example/ledgerkit/backend-engineer", text: HOSTILE_TEXT });
    await waitForExtractionQueue(bridge.workspace.root);

    expect(calls).toHaveLength(1);
    const snapshot = await store.getSnapshot(result.jobId, result.revision);
    expect(snapshot?.structured).toEqual(HOSTILE_JOB_STRUCTURED);
    expect(JSON.stringify(snapshot?.structured ?? {})).not.toContain("open_application_group");

    const after = ProfileStore.markdownHash(renderProfileMarkdown((await profileStore.load()).profile));
    expect(after).toBe(before);
  });
});

describe("captures.ts: POST /api/captures/paste", () => {
  it("saves a paste-path capture and reports success", async () => {
    const bridge = await bridgeWith();
    const response = await postCaptures(bridge, "/paste", { url: "https://jobs.example/pasted-posting", text: "Pasted posting text." });
    expect(response.status).toBe(200);
    const body = (await response.json()) as CaptureBody;
    expect(body.ok).toBe(true);
    expect(body.job.revision).toBe(1);
    expect(body.extraction).toMatchObject({ status: "not_run", reason: "runner_not_running" });
  });

  it.each(["javascript:alert(1)", "file:///etc/passwd", "", "jobs.example/no-scheme"])("refuses the address %j with invalid_url (round-1 review L11)", async (url) => {
    const bridge = await bridgeWith();
    const response = await postCaptures(bridge, "/paste", { url, text: "Text" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_url" } });
  });

  it("refuses text over the 200 KB cap with text_too_large", async () => {
    const bridge = await bridgeWith();
    const response = await postCaptures(bridge, "/paste", { url: "https://jobs.example/huge", text: "x".repeat(200_001) });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "text_too_large" } });
  });

  it("measures the cap the contract's way, as JSON: 195,000 bytes with 5,000 newlines is over it, 199,998 plain bytes is not (round-2 T13)", async () => {
    const bridge = await bridgeWith();
    const newlines = "x".repeat(190_000) + "\n".repeat(5_000);
    expect(new TextEncoder().encode(newlines).length).toBe(195_000);
    const over = await postCaptures(bridge, "/paste", { url: "https://jobs.example/many-newlines", text: newlines });
    expect(over.status).toBe(413);
    expect(await over.json()).toMatchObject({ error: { code: "text_too_large" } });
    const atCap = await postCaptures(bridge, "/paste", { url: "https://jobs.example/at-cap", text: "x".repeat(199_998) });
    expect(atCap.status).toBe(200);
  });

  it("reports 'hasn't changed' for a re-paste of the same url and text, without a new revision", async () => {
    const bridge = await bridgeWith();
    await postCaptures(bridge, "/paste", { url: "https://jobs.example/pasted-posting", text: "Same text." });
    const second = await postCaptures(bridge, "/paste", { url: "https://jobs.example/pasted-posting", text: "Same text." });
    const body = (await second.json()) as CaptureBody;
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

  it("refuses a fetched page over the 200 KB text cap, the same way the paste path does (round-1 review L11)", async () => {
    const fakeFetchUrl = async (url: string): Promise<SafeFetchResult> => ({ ok: true, status: 200, contentType: "text/plain", text: "x".repeat(200_001), finalUrl: url });
    const modules: readonly LoadedRouteModule[] = [{ name: "captures", module: createCapturesRouteModule(fakeFetchUrl) }];
    const bridge = await makeBridge({ modules });
    const response = await postCaptures(bridge, "/url", { url: "https://jobs.example/huge-page" });
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("text_too_large");
  });

  it("refuses a page with no readable text once whitespace is removed (422, never a 500)", async () => {
    const fakeFetchUrl = async (url: string): Promise<SafeFetchResult> => ({ ok: true, status: 200, contentType: "text/plain", text: " \r\n \t ", finalUrl: url });
    const modules: readonly LoadedRouteModule[] = [{ name: "captures", module: createCapturesRouteModule(fakeFetchUrl) }];
    const bridge = await makeBridge({ modules });
    const response = await postCaptures(bridge, "/url", { url: "https://jobs.example/blank-page" });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "no_text_extracted" } });
  });
});

describe("captures.ts: GET /api/captures list and detail", () => {
  it("lists jobs, with the latest revision's extraction state, and returns a job's revisions", async () => {
    const bridge = await bridgeWith();
    await postCaptures(bridge, "/paste", { url: "https://jobs.example/fernwood", text: "Fernwood posting." });
    // Hono's default `strict: true` routing treats "/api/captures/" (trailing slash) as distinct from "/api/captures".
    const list = await getCaptures<ListBody>(bridge, "");
    expect(list.jobs).toHaveLength(1);
    expect(list.jobs[0]).toMatchObject({ revisionCount: 1, latestRevision: 1, url: "https://jobs.example/fernwood", unreadable: [], extraction: { status: "not_run", reason: "runner_not_running" } });
    const jobId = list.jobs[0]!.jobId;
    const detail = await getCaptures<DetailBody>(bridge, `/${jobId}`);
    expect(detail.revisions).toHaveLength(1);
    expect(detail.revisions[0]!.text).toBe("Fernwood posting.");
    expect(detail).toMatchObject({ latestRevision: 1, unreadable: [], extraction: [{ status: "not_run", reason: "runner_not_running" }] });
  });

  it("404s for a job that doesn't exist", async () => {
    const bridge = await bridgeWith();
    const response = await bridge.request("/api/captures/00000000-0000-4000-8000-000000000000", { headers: { cookie: COOKIE } });
    expect(response.status).toBe(404);
  });
});

describe("captures.ts: damaged data is named, never a 500 and never a silent gap (round-2 T6)", () => {
  async function twoRevisions(bridge: TestBridge, url: string): Promise<string> {
    const first = (await (await postCaptures(bridge, "/paste", { url, text: "Staff Platform Engineer at Northwind Labs." })).json()) as CaptureBody;
    await postCaptures(bridge, "/paste", { url, text: "Principal Platform Engineer at Northwind Labs." });
    return first.job.jobId;
  }

  it("a job whose latest revision can't be read stays in the list, by its url, with the damaged file named; its detail answers 200", async () => {
    const bridge = await bridgeWith();
    const url = "https://jobs.example/northwind-labs/platform";
    const jobId = await twoRevisions(bridge, url);
    await writeFile(path.join(bridge.workspace.root, "jobs", jobId, "snapshot-2.json"), "{ not valid json");

    const listResponse = await bridge.request("/api/captures", { headers: { cookie: COOKIE } });
    expect(listResponse.status).toBe(200);
    const [entry] = ((await listResponse.json()) as ListBody).jobs;
    expect(entry).toMatchObject({ jobId, revisionCount: 2, latestRevision: 2, url, unreadable: [{ revision: 2, path: `jobs/${jobId}/snapshot-2.json` }] });
    expect(entry!.latest).toBeUndefined();

    const detailResponse = await bridge.request(`/api/captures/${jobId}`, { headers: { cookie: COOKIE } });
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as DetailBody;
    expect(detail.revisions.map((revision) => revision.revision)).toEqual([1]);
    expect(detail).toMatchObject({ latestRevision: 2, unreadable: [{ revision: 2, path: `jobs/${jobId}/snapshot-2.json` }] });
  });

  it("a job whose only revision can't be read still lists, named by its file, and its detail answers 200", async () => {
    const bridge = await bridgeWith();
    const pasted = (await (await postCaptures(bridge, "/paste", { url: "https://jobs.example/harbor/only", text: "Harbor posting." })).json()) as CaptureBody;
    await writeFile(path.join(bridge.workspace.root, "jobs", pasted.job.jobId, "snapshot-1.json"), JSON.stringify({ not: "a snapshot" }));
    const list = await getCaptures<ListBody>(bridge, "");
    expect(list.jobs).toEqual([
      { jobId: pasted.job.jobId, revisionCount: 1, latestRevision: 1, unreadable: [{ revision: 1, path: `jobs/${pasted.job.jobId}/snapshot-1.json` }], extraction: { status: "not_run", reason: "runner_not_running", updatedAt: expect.any(String) } },
    ]);
    const detail = await bridge.request(`/api/captures/${pasted.job.jobId}`, { headers: { cookie: COOKIE } });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ revisions: [], extraction: [], unreadable: [{ revision: 1 }] });
  });

  it("Re-extract of a revision that can't be read is refused plainly with 409, naming the file", async () => {
    const bridge = await bridgeWith();
    const url = "https://jobs.example/northwind-labs/platform";
    const jobId = await twoRevisions(bridge, url);
    await writeFile(path.join(bridge.workspace.root, "jobs", jobId, "snapshot-2.json"), "{ not valid json");
    const response = await postCaptures(bridge, retryPath(jobId, 2), {});
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("snapshot_unreadable");
    expect(body.error.message).toContain(`jobs/${jobId}/snapshot-2.json`);
  });

  it("an extraction state file that can't be read reads as interrupted, and a retry rewrites it", async () => {
    const { bridge, calls, store } = await bridgeWithScript((getStore) => toolScript(getStore, NORTHWIND_STRUCTURED));
    const pasted = (await (await postCaptures(bridge, "/paste", { url: "https://jobs.example/northwind-labs/staff", text: "Staff Platform Engineer at Northwind Labs." })).json()) as CaptureBody;
    await waitForExtractionQueue(bridge.workspace.root);
    await writeFile(path.join(bridge.workspace.root, "jobs", pasted.job.jobId, "extraction-1.json"), "{ not valid json");

    const detail = await bridge.request(`/api/captures/${pasted.job.jobId}`, { headers: { cookie: COOKIE } });
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as DetailBody).extraction).toEqual([{ status: "failed", reason: "interrupted" }]);
    expect((await getCaptures<ListBody>(bridge, "")).jobs[0]!.extraction).toEqual({ status: "failed", reason: "interrupted" });

    const retry = await postCaptures(bridge, retryPath(pasted.job.jobId, 1), {});
    expect(retry.status).toBe(200);
    await waitForExtractionQueue(bridge.workspace.root);
    expect(calls).toHaveLength(2);
    expect(await store.getExtractionState(pasted.job.jobId, 1)).toMatchObject({ status: "done" });
  });

  it("a recapture of the same url lands in the same job when a readable revision records the url", async () => {
    const bridge = await bridgeWith();
    const url = "https://jobs.example/northwind-labs/platform";
    const jobId = await twoRevisions(bridge, url);
    await writeFile(path.join(bridge.workspace.root, "jobs", jobId, "snapshot-2.json"), "{ not valid json");
    const recaptured = (await (await postCaptures(bridge, "/paste", { url, text: "Principal Platform Engineer at Northwind Labs." })).json()) as CaptureBody;
    expect(recaptured.job).toMatchObject({ jobId, revision: 3 });
    expect((await getCaptures<ListBody>(bridge, "")).jobs.map((job) => job.jobId)).toEqual([jobId]);
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
    expect(start![1]).toBe(end![1]); // the same token opens and closes the block: a hostile posting can't forge a matching END of its own

    const startOfBlock = start!.index + start![0].length;
    const endOfBlock = end!.index;
    expect(startOfBlock).toBeLessThan(endOfBlock);

    // Exactly one occurrence in the whole prompt, strictly inside [startOfBlock, endOfBlock).
    expect(prompt.split(text).length - 1).toBe(1);
    const textIndex = prompt.indexOf(text);
    expect(textIndex).toBeGreaterThanOrEqual(startOfBlock);
    expect(textIndex + text.length).toBeLessThanOrEqual(endOfBlock);
    expect(prompt.slice(0, startOfBlock)).not.toContain(text);
    expect(prompt.slice(endOfBlock)).not.toContain(text);
  });
});

describe("captures.ts: stored URLs drop userinfo and fragment (round-1 review L10; WHATWG serialization accepted, round-2 T10)", () => {
  it("the extension event path strips userinfo and fragment before storing", async () => {
    const bridge = await bridgeWith();
    const { token } = await pairDevice(bridge);
    const result = await captureByEvent(bridge, token, { url: "https://user:pass@jobs.example/posting#section-2", text: "Some posting text." });
    const snapshot = await new JobsStore(bridge.workspace).getSnapshot(result.jobId, result.revision);
    expect(snapshot?.url).toBe("https://jobs.example/posting");
  });

  it("the paste path strips userinfo and fragment before storing", async () => {
    const bridge = await bridgeWith();
    const response = await postCaptures(bridge, "/paste", { url: "https://user:pass@jobs.example/pasted#frag", text: "Pasted posting text." });
    const body = (await response.json()) as CaptureBody;
    expect(body.job.url).toBe("https://jobs.example/pasted");
  });

  it("every path stores the same WHATWG serialization of one address, so the captures dedupe", async () => {
    const bridge = await bridgeWith();
    const { token } = await pairDevice(bridge);
    const viaEvent = await captureByEvent(bridge, token, { url: "https://JOBS.example:443/Roles/one", text: "Same text." });
    const viaPaste = (await (await postCaptures(bridge, "/paste", { url: "https://jobs.example/Roles/one", text: "Same text." })).json()) as CaptureBody;
    expect(viaPaste.job).toMatchObject({ jobId: viaEvent.jobId, revision: 1, url: "https://jobs.example/Roles/one" });
    expect(viaPaste.contentChanged).toBe(false);
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
    const body = (await response.json()) as CaptureBody;
    expect(body.job.url).toBe("https://jobs.example/final-page");
  });

  it("refuses a final URL that is still too long even after stripping userinfo and fragment", async () => {
    // The host alone is over the cap, so stripping the (short) fragment below could never have rescued it.
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
    const first = await captureByEvent(bridge, token, { url: "https://jobs.example/same-page#a", text: "Same text." });
    const second = await captureByEvent(bridge, token, { url: "https://jobs.example/same-page#b", text: "Same text.", eventId: randomUUID() });
    expect(second.jobId).toBe(first.jobId);
    expect(second.contentChanged).toBe(false);
  });
});
