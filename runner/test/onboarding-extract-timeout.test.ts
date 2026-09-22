import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyAndPersistExtractedClaims } from "../agent/lib/extract-claims-logic.ts";
import { ROUTES_DIR } from "../lib/paths.ts";
import { createEveGateway } from "../server/eve-gateway.ts";
import { UI_COOKIE } from "../server/local-ui.ts";
import { loadRouteModules } from "../server/route-modules.ts";
import { EXTRACTION_TIMEOUT_MS, extractionTiming } from "../server/routes/onboarding.ts";
import { ProfileStore } from "../store/profile.ts";
import { BRIDGE, UI_TOKEN, makeBridge, type TestBridge } from "./helpers.ts";

/**
 * The extraction route's deadline (R3) against the real eve@0.63.0 client,
 * per docs/spec/research/eve-runtime.md §8 item 15. `createEveGateway` builds
 * the same `Client` the runner uses; global `fetch` is stubbed with a
 * scripted eve server, so no port is bound and nothing live is contacted.
 *
 * eve's client ends a turn quietly, as "completed", when the deadline fires
 * while it is opening or reopening the event stream. The route must still
 * report a timeout (504), cancel the session through `ClientSession.cancel()`
 * (`MessageResponse.cancel()` sends nothing before the client has seen the
 * turn start, or once the turn is parked), and record no content hash, so
 * the same text is extracted again next time.
 */

const COOKIE = `${UI_COOKIE}=${UI_TOKEN}`;
const SAME_ORIGIN = { cookie: COOKIE, origin: BRIDGE, "content-type": "application/json", "sec-fetch-site": "same-origin" };
const SESSION = "s-extract";
const CANCEL_PATH = `/eve/v1/session/${SESSION}/cancel`;
const SHORT_DEADLINE_MS = 300;
const TIMED_OUT = { code: "extraction_timed_out", message: "No answer from the model within 300 ms. The turn was stopped; try again." };
const RESUME_TEXT = "Led the payments team at Northwind Labs. Cut the Harbor release time from a day to under an hour.";
const LED_CLAIM = { text: "Led the payments team at Northwind Labs.", kind: "fact" as const, evidenceRef: "pasted.txt#1", evidenceQuote: "Led the payments team at Northwind Labs." };

type Plan =
  /** A whole turn: extract_claims persists a claim, then `session.waiting`. */
  | "finished"
  /** The deadline fires while the first event stream is still opening. */
  | "hang-open"
  /** extract_claims persists a claim, the stream lease ends, and the deadline fires while the client reopens the stream. */
  | "lease-end-then-hang-reopen"
  /** The deadline fires while an open stream is being read, so `result()` throws. */
  | "events-then-hang-read"
  /** The turn parks on an input request the page can't show. */
  | "parked";

const encoder = new TextEncoder();
let eventCounter = 0;

function line(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

function streamEvent(type: string, data?: Record<string, unknown>): Record<string, unknown> {
  eventCounter += 1;
  return { type, ...(data ? { data } : {}), meta: { at: "2026-09-22T09:00:00.000Z", id: `evt-${String(eventCounter).padStart(5, "0")}` } };
}

interface FakeEve {
  readonly requests: string[];
  cancels(): number;
  sessionsCreated(): number;
}

/**
 * Stubs global `fetch` with a scripted eve server for one plan. The stream's
 * extract_claims step runs the real verify-then-persist helper against the
 * bridge's workspace, as the tool step does inside eve, and reports its
 * output in an `action.result` event.
 */
function stubEve(plan: Plan, bridge: () => TestBridge): FakeEve {
  const requests: string[] = [];
  let streamOpens = 0;
  let cancels = 0;
  let created = 0;

  const hang = (signal: AbortSignal | undefined) =>
    new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });

  const extractClaimsResult = async (): Promise<Record<string, unknown>> => {
    const { workspace, clock } = bridge();
    const output = await verifyAndPersistExtractedClaims({ sourceCategory: "resume", claims: [LED_CLAIM] }, new ProfileStore(workspace, clock));
    return streamEvent("action.result", {
      callId: "call-1",
      result: { kind: "tool-result", callId: "call-1", toolName: "extract_claims", output },
      sequence: 2,
      status: "completed",
      stepIndex: 0,
      turnId: "t1",
    });
  };

  const fake = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const signal = init.signal ?? undefined;
    requests.push(`${method} ${url.pathname}`);

    if (method === "POST" && url.pathname === "/eve/v1/session") {
      created += 1;
      return new Response(JSON.stringify({ ok: true, sessionId: SESSION }), { status: 202, headers: { "content-type": "application/json", "x-eve-session-id": SESSION } });
    }
    if (method === "POST" && url.pathname === CANCEL_PATH) {
      cancels += 1;
      return new Response(JSON.stringify({ ok: true, sessionId: SESSION, status: "accepted" }), { status: 202, headers: { "content-type": "application/json" } });
    }
    if (method !== "GET" || url.pathname !== `/eve/v1/session/${SESSION}/stream`) return new Response("not found", { status: 404 });

    streamOpens += 1;
    if (plan === "hang-open") return hang(signal);
    if (plan === "lease-end-then-hang-reopen" && streamOpens > 1) return hang(signal);

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode("\n"));
        controller.enqueue(line(streamEvent("turn.started", { sequence: 0, turnId: "t1" })));
        controller.enqueue(line(streamEvent("step.started", { modelId: "fake-model", sequence: 1, stepIndex: 0, turnId: "t1" })));
        if (plan === "finished" || plan === "lease-end-then-hang-reopen") controller.enqueue(line(await extractClaimsResult()));
        if (plan === "finished") {
          controller.enqueue(line(streamEvent("session.waiting", { continuationToken: SESSION, wait: "next-user-message" })));
          controller.close();
          return;
        }
        if (plan === "lease-end-then-hang-reopen") {
          // eve's server ends every stream lease after 60 s; the client then reopens the stream.
          controller.enqueue(line({ $eve: "stream.lease-ended", version: 1 }));
          controller.close();
          return;
        }
        if (plan === "parked") {
          const request = { action: { callId: "call-2", input: {}, kind: "tool-call", toolName: "open_application_group" }, kind: "tool-approval", prompt: "Open this application group?", requestId: "req-1" };
          controller.enqueue(line(streamEvent("input.requested", { requests: [request], sequence: 3, stepIndex: 0, turnId: "t1" })));
          controller.enqueue(line(streamEvent("session.waiting", { continuationToken: SESSION, wait: "next-user-message" })));
          controller.close();
          return;
        }
        // events-then-hang-read: the stream stays open and silent until the deadline.
        signal?.addEventListener(
          "abort",
          () => {
            try {
              controller.error(signal.reason);
            } catch {
              // already closed
            }
          },
          { once: true },
        );
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson", "x-eve-stream-version": "25" } });
  };

  vi.stubGlobal("fetch", fake);
  return { requests, cancels: () => cancels, sessionsCreated: () => created };
}

async function bridgeWithRealClient(plan: Plan): Promise<{ bridge: TestBridge; eve: FakeEve }> {
  const holder: { bridge?: TestBridge } = {};
  const eve = stubEve(plan, () => holder.bridge!);
  // The runner's own gateway: the real eve Client, basic auth and redirect: "manual".
  const gateway = createEveGateway({ password: "fake-eve-password" });
  const bridge = await makeBridge({ modules: await loadRouteModules(ROUTES_DIR), eve: gateway });
  holder.bridge = bridge;
  return { bridge, eve };
}

function post(bridge: TestBridge, pathname: string, body: unknown = {}): Promise<Response> {
  return bridge.request(`/api/onboarding${pathname}`, { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify(body) });
}

async function provideResume(bridge: TestBridge): Promise<void> {
  expect((await post(bridge, "/sources/resume", { status: "provided" })).status).toBe(200);
  expect((await post(bridge, "/sources/resume/content", { text: RESUME_TEXT })).status).toBe(200);
}

/** Whether the route recorded the resume's content hash (R7): only a finished turn that persisted claims may. */
async function hashRecorded(bridge: TestBridge): Promise<boolean> {
  const store = new ProfileStore(bridge.workspace, bridge.clock);
  return store.isSourceContentUnchanged("resume", await store.sourceText("resume"));
}

afterEach(() => {
  vi.unstubAllGlobals();
  extractionTiming.timeoutMs = EXTRACTION_TIMEOUT_MS;
});

describe("extraction deadline against the real eve@0.63.0 client (eve-runtime §8 item 15)", () => {
  it("control: a finished turn that persisted claims is ok, records the hash, and cancels nothing", async () => {
    const { bridge, eve } = await bridgeWithRealClient("finished");
    await provideResume(bridge);
    const response = await post(bridge, "/sources/resume/extract");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; status: string; message: string; claims: Array<{ text: string }> };
    expect(body).toMatchObject({ ok: true, status: "waiting" });
    expect(body.claims.map((claim) => claim.text)).toEqual([LED_CLAIM.text]);
    expect(eve.cancels()).toBe(0);
    expect(await hashRecorded(bridge)).toBe(true);
  });

  it("the deadline fires while the stream is opening: result() resolves quietly, and the route still reports a timeout and cancels the session", async () => {
    extractionTiming.timeoutMs = SHORT_DEADLINE_MS;
    const { bridge, eve } = await bridgeWithRealClient("hang-open");
    await provideResume(bridge);
    const response = await post(bridge, "/sources/resume/extract");
    expect(response.status).toBe(504);
    expect(((await response.json()) as { error: unknown }).error).toEqual(TIMED_OUT);
    expect(eve.cancels()).toBe(1);
    expect(eve.requests.at(-1)).toBe(`POST ${CANCEL_PATH}`);
    expect(bridge.logs).toContain("onboarding: extraction turn for resume timed out after 300 ms");
    expect(await hashRecorded(bridge)).toBe(false);
  });

  it("the deadline fires while the stream reopens after a lease ends: claims the tool saved stay, but the turn is a timeout, cancelled, with no hash", async () => {
    extractionTiming.timeoutMs = SHORT_DEADLINE_MS;
    const { bridge, eve } = await bridgeWithRealClient("lease-end-then-hang-reopen");
    await provideResume(bridge);
    const response = await post(bridge, "/sources/resume/extract");
    expect(response.status).toBe(504);
    expect(((await response.json()) as { error: unknown }).error).toEqual(TIMED_OUT);
    expect(eve.cancels()).toBe(1);
    expect(eve.requests.filter((request) => request.endsWith("/stream"))).toHaveLength(2);
    expect(await hashRecorded(bridge)).toBe(false);
    // The claim the tool step saved before the deadline is a candidate on the page.
    const claims = (await new ProfileStore(bridge.workspace, bridge.clock).read()).claims;
    expect(claims.map((claim) => [claim.text, claim.status])).toEqual([[LED_CLAIM.text, "candidate"]]);
  });

  it("control: the deadline fires while an open stream is read: result() throws, and the route reports a timeout and cancels the session", async () => {
    extractionTiming.timeoutMs = SHORT_DEADLINE_MS;
    const { bridge, eve } = await bridgeWithRealClient("events-then-hang-read");
    await provideResume(bridge);
    const response = await post(bridge, "/sources/resume/extract");
    expect(response.status).toBe(504);
    expect(((await response.json()) as { error: unknown }).error).toEqual(TIMED_OUT);
    expect(eve.cancels()).toBe(1);
    expect(await hashRecorded(bridge)).toBe(false);
  });

  it("a turn parked on an input request is cancelled through the session (MessageResponse.cancel() would send nothing)", async () => {
    const { bridge, eve } = await bridgeWithRealClient("parked");
    await provideResume(bridge);
    const response = await post(bridge, "/sources/resume/extract");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: false,
      status: "waiting",
      message: "Extraction from Resume did not finish: The model asked a question instead of finishing. This page can't show or answer it; try again, or simplify the source text.",
    });
    expect(eve.cancels()).toBe(1);
    expect(eve.requests.at(-1)).toBe(`POST ${CANCEL_PATH}`);
    expect(await hashRecorded(bridge)).toBe(false);
  });

  it("after a timeout, the same text is extracted again (no hash was recorded)", async () => {
    extractionTiming.timeoutMs = SHORT_DEADLINE_MS;
    const { bridge, eve } = await bridgeWithRealClient("hang-open");
    await provideResume(bridge);
    expect((await post(bridge, "/sources/resume/extract")).status).toBe(504);
    expect((await post(bridge, "/sources/resume/extract")).status).toBe(504);
    expect(eve.sessionsCreated()).toBe(2);
    expect(eve.cancels()).toBe(2);
  });
});
