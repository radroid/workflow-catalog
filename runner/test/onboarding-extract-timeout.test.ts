import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyExtractedClaims } from "../agent/lib/extract-claims-logic.ts";
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
 * `run-harness.ts`'s `classifyTurn` is what the route now runs every turn
 * through (P03.2 deliverable 1), so this file also doubles as its one
 * real-`Client` acceptance test for the extraction caller: the spike's
 * normal sequence (ok), `turn.cancelled` (not ok), an abort (timeout, with a
 * cancel through the session, below in three variants), and a non-empty
 * `input.requested` (parked).
 *
 * eve's client ends a turn quietly, as "completed", when the deadline fires
 * while it is opening or reopening the event stream. `classifyTurn` still
 * reports a timeout, cancels the session through `ClientSession.cancel()`
 * (`MessageResponse.cancel()` sends nothing before the client has seen the
 * turn start, or once the turn is parked), and the route records no content
 * hash for it, so the same text is extracted again next time. `runTurn`
 * never rejects (P03.2): every outcome below, including a timeout, comes
 * back as a normal `ok: false` JSON response, not a distinct HTTP code —
 * mvp-spec.md specifies none, and the page never reads the route's own HTTP
 * status for this call, only `ok`/`message` (see the report).
 *
 * J1 (P03 revision 3): a turn eve cancelled ends `turn.cancelled`, then
 * `session.waiting`; it is not ok either. The control is the P02 spike's
 * normal turn (docs/spec/research/eve-spike.md), with the extract_claims
 * result in the middle: `session.started → turn.started → message.received →
 * step.started → action.result → message.appended → message.completed →
 * step.completed → turn.completed → session.waiting`.
 *
 * P03.2 (deliverable 5, P04's T1 rule): `extract_claims` only verifies and
 * returns now; the route persists what it verified through
 * `ProfileStore.extractClaims`, and only once `classifyTurn` reports the
 * whole turn "ok". The J1 (cancelled) and lease-end-then-hang-reopen
 * (timeout) cases below are this packet's mutation-proof regression tests
 * for the bug that fixes: a claim the tool step verified mid-turn must not
 * survive a turn that did not finish ok.
 */

const COOKIE = `${UI_COOKIE}=${UI_TOKEN}`;
const SAME_ORIGIN = { cookie: COOKIE, origin: BRIDGE, "content-type": "application/json", "sec-fetch-site": "same-origin" };
const SESSION = "s-extract";
const CANCEL_PATH = `/eve/v1/session/${SESSION}/cancel`;
const SHORT_DEADLINE_MS = 300;
// S6 (revision 2, UI critic issue 2): the consequence first.
const TIMED_OUT = { ok: false, status: "timeout", message: "The extraction stopped: no answer from the model within 300 ms. Try again.", claims: [] };
const RESUME_TEXT = "Led the payments team at Northwind Labs. Cut the Harbor release time from a day to under an hour.";
const LED_CLAIM = { text: "Led the payments team at Northwind Labs.", kind: "fact" as const, evidenceRef: "pasted.txt#1", evidenceQuote: "Led the payments team at Northwind Labs." };

type Plan =
  /** The spike's normal turn, with extract_claims persisting a claim: ends `turn.completed → session.waiting`. */
  | "finished"
  /** extract_claims persists a claim, then eve cancels the turn: `turn.cancelled → session.waiting` (J1). */
  | "cancelled"
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

  const extractClaimsResult = async (sequence: number): Promise<Record<string, unknown>> => {
    const { workspace, clock } = bridge();
    const output = await verifyExtractedClaims({ sourceCategory: "resume", claims: [LED_CLAIM] }, new ProfileStore(workspace, clock));
    return streamEvent("action.result", {
      callId: "call-1",
      result: { kind: "tool-result", callId: "call-1", toolName: "extract_claims", output },
      sequence,
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
        if (plan === "finished" || plan === "cancelled") {
          controller.enqueue(line(streamEvent("session.started", {})));
          controller.enqueue(line(streamEvent("turn.started", { sequence: 0, turnId: "t1" })));
          controller.enqueue(line(streamEvent("message.received", { message: "Extract candidate claims…", sequence: 1, turnId: "t1" })));
          controller.enqueue(line(streamEvent("step.started", { modelId: "fake-model", sequence: 2, stepIndex: 0, turnId: "t1" })));
          controller.enqueue(line(await extractClaimsResult(3)));
          if (plan === "finished") {
            controller.enqueue(line(streamEvent("message.appended", { messageDelta: "Done.", sequence: 4, stepIndex: 0, turnId: "t1" })));
            controller.enqueue(line(streamEvent("message.completed", { finishReason: "stop", message: "Done.", sequence: 5, stepIndex: 0, turnId: "t1" })));
            controller.enqueue(line(streamEvent("step.completed", { finishReason: "stop", sequence: 6, stepIndex: 0, turnId: "t1" })));
            controller.enqueue(line(streamEvent("turn.completed", { sequence: 7, turnId: "t1" })));
          } else {
            controller.enqueue(line(streamEvent("turn.cancelled", { sequence: 4, turnId: "t1" })));
          }
          controller.enqueue(line(streamEvent("session.waiting", { continuationToken: SESSION, wait: "next-user-message" })));
          controller.close();
          return;
        }
        controller.enqueue(line(streamEvent("turn.started", { sequence: 0, turnId: "t1" })));
        controller.enqueue(line(streamEvent("step.started", { modelId: "fake-model", sequence: 1, stepIndex: 0, turnId: "t1" })));
        if (plan === "lease-end-then-hang-reopen") {
          controller.enqueue(line(await extractClaimsResult(2)));
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
  it("control: the spike's normal turn (… turn.completed → session.waiting) that persisted claims is ok, records the hash, and cancels nothing", async () => {
    const { bridge, eve } = await bridgeWithRealClient("finished");
    await provideResume(bridge);
    const response = await post(bridge, "/sources/resume/extract");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; status: string; message: string; claims: Array<{ text: string }> };
    // P03.2 (deliverable 1): TurnResult's own vocabulary ("ok"), not eve's raw "waiting" boundary.
    expect(body).toMatchObject({ ok: true, status: "ok", message: "1 candidate claim extracted from Resume." });
    expect(body.claims.map((claim) => claim.text)).toEqual([LED_CLAIM.text]);
    expect(eve.cancels()).toBe(0);
    expect(await hashRecorded(bridge)).toBe(true);
    // Unchanged text is not sent to eve again (R7).
    expect(((await (await post(bridge, "/sources/resume/extract")).json()) as { status: string }).status).toBe("unchanged");
    expect(eve.sessionsCreated()).toBe(1);
  });

  it("J1, deliverable 5: a cancelled turn (extract_claims verified → turn.cancelled → session.waiting) is not ok, records no hash, and saves nothing — the claim the tool step verified before the cancel is never persisted", async () => {
    const { bridge, eve } = await bridgeWithRealClient("cancelled");
    await provideResume(bridge);
    const response = await post(bridge, "/sources/resume/extract");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; status: string; message: string; claims: Array<{ text: string; status: string }> };
    // TurnResult's own vocabulary ("cancelled"), not eve's raw "waiting" boundary (deliverable 1).
    expect(body).toMatchObject({ ok: false, status: "cancelled", message: "The extraction was stopped before it finished. Try again." });
    // P04's T1 rule (deliverable 5): extract_claims only verifies now; the route persists only after an ok
    // turn, so a claim the tool step verified before the cancel is never saved — this is the regression test
    // for the bug the packet describes: "a turn that fails after the tool ran leaves claims behind".
    expect(body.claims).toEqual([]);
    expect((await new ProfileStore(bridge.workspace, bridge.clock).read()).claims).toEqual([]);
    expect(await hashRecorded(bridge)).toBe(false);
    // The turn already ended (session.waiting follows the cancel), so there is nothing to cancel.
    expect(eve.cancels()).toBe(0);
    const again = await post(bridge, "/sources/resume/extract");
    expect(((await again.json()) as { status: string }).status).not.toBe("unchanged");
    expect(eve.sessionsCreated()).toBe(2);
  });

  it("the deadline fires while the stream is opening: the stream resolves quietly, and the route still reports a timeout and cancels the session", async () => {
    extractionTiming.timeoutMs = SHORT_DEADLINE_MS;
    const { bridge, eve } = await bridgeWithRealClient("hang-open");
    await provideResume(bridge);
    const response = await post(bridge, "/sources/resume/extract");
    // P03.2 (deliverable 1): runTurn never rejects — a timeout is a normal ok:false TurnResult, the same as
    // every other non-ok status, not a distinct HTTP code (mvp-spec.md specifies none; mirrors eve-gateway.ts).
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(TIMED_OUT);
    expect(eve.cancels()).toBe(1);
    expect(eve.requests.at(-1)).toBe(`POST ${CANCEL_PATH}`);
    expect(bridge.logs).toContain("onboarding: extraction turn for resume ended timeout (No answer within 0.3 s.)");
    expect(await hashRecorded(bridge)).toBe(false);
  });

  it("the deadline fires while the stream reopens after a lease ends: the turn is a timeout, cancelled, with no hash, and deliverable 5 saves nothing the tool verified before the deadline", async () => {
    extractionTiming.timeoutMs = SHORT_DEADLINE_MS;
    const { bridge, eve } = await bridgeWithRealClient("lease-end-then-hang-reopen");
    await provideResume(bridge);
    const response = await post(bridge, "/sources/resume/extract");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(TIMED_OUT);
    expect(eve.cancels()).toBe(1);
    expect(eve.requests.filter((request) => request.endsWith("/stream"))).toHaveLength(2);
    expect(await hashRecorded(bridge)).toBe(false);
    // Deliverable 5: the claim the tool step verified before the deadline is never persisted — the turn never
    // reached "ok", so the route never calls ProfileStore.extractClaims.
    const claims = (await new ProfileStore(bridge.workspace, bridge.clock).read()).claims;
    expect(claims).toEqual([]);
  });

  it("control: the deadline fires while an open stream is read: the route reports a timeout and cancels the session", async () => {
    extractionTiming.timeoutMs = SHORT_DEADLINE_MS;
    const { bridge, eve } = await bridgeWithRealClient("events-then-hang-read");
    await provideResume(bridge);
    const response = await post(bridge, "/sources/resume/extract");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(TIMED_OUT);
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
      status: "parked", // TurnResult's own vocabulary, not eve's raw "waiting" boundary (deliverable 1)
      message: "The extraction stopped: the model asked a question this page can't show. Try again.", // S6: the consequence first
    });
    expect(eve.cancels()).toBe(1);
    expect(eve.requests.at(-1)).toBe(`POST ${CANCEL_PATH}`);
    expect(await hashRecorded(bridge)).toBe(false);
  });

  it("after a timeout, the same text is extracted again (no hash was recorded)", async () => {
    extractionTiming.timeoutMs = SHORT_DEADLINE_MS;
    const { bridge, eve } = await bridgeWithRealClient("hang-open");
    await provideResume(bridge);
    expect((await (await post(bridge, "/sources/resume/extract")).json()) as { status: string }).toMatchObject({ status: "timeout" });
    expect((await (await post(bridge, "/sources/resume/extract")).json()) as { status: string }).toMatchObject({ status: "timeout" });
    expect(eve.sessionsCreated()).toBe(2);
    expect(eve.cancels()).toBe(2);
  });
});
