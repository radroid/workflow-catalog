// P03.2 (deliverable 1, acceptance): a real-Client test for the model-check caller, the same shape as
// run-harness-eve-client.test.ts's for runTurn — global fetch stubbed by a scripted fake eve server, no port bound,
// nothing live contacted. `createEveGateway`'s `checkModel` now runs the shared `classifyTurn` (eve-runtime.md §8
// item 15), so this proves the gateway's own real-Client wiring (the fixed MODEL_CHECK_PROMPT, modelId(), and
// interpretModelCheck's reply check) end to end, covering:
//   - the spike's normal sequence (turn.completed → session.waiting), replying "ok": accepted;
//   - turn.cancelled (not ok);
//   - an abort (a timeout, with one real cancel through ClientSession.cancel(), never MessageResponse.cancel());
//   - a non-empty input.requested (parked, not ok, with one real cancel).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEveGateway, MODEL_CHECK_PROMPT } from "../server/eve-gateway.ts";

// createEveGateway defaults to 127.0.0.1:3210 (never contacted: fetch is stubbed).
const SESSION = "s-check";
const enc = new TextEncoder();
let seq = 0;
const ev = (type: string, data: Record<string, unknown>) => ({ type, data, meta: { at: "2026-09-24T09:00:00.000Z", id: `evt-${String(seq++).padStart(5, "0")}` } });
const line = (o: unknown) => enc.encode(`${JSON.stringify(o)}\n`);
const WAITING = () => ev("session.waiting", { continuationToken: SESSION, wait: "next-user-message" });

type Plan = "normal-ok" | "normal-bad-reply" | "cancelled-elsewhere" | "parked" | "hang-open";

/** A scripted fake eve HTTP server for one plan, stood up entirely through a stubbed `fetch`. */
function stubEve(plan: Plan) {
  const requests: string[] = [];
  let cancels = 0;
  const fake = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const signal = init.signal ?? undefined;
    requests.push(`${method} ${url.pathname}`);
    const hang = () =>
      new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    // `/eve/v1/info` is deliberately not stubbed: its response schema is large and unrelated to what this file
    // proves (the classifier), so `client.info()` 404s and `modelId()` — untouched by this packet — resolves
    // undefined the same way it already does whenever eve answers with anything `AgentInfoResultSchema` rejects.
    if (method === "POST" && url.pathname === "/eve/v1/session") {
      return new Response(JSON.stringify({ ok: true, sessionId: SESSION }), { status: 202, headers: { "content-type": "application/json", "x-eve-session-id": SESSION } });
    }
    if (method === "POST" && url.pathname === `/eve/v1/session/${SESSION}/cancel`) {
      cancels += 1;
      return new Response(JSON.stringify({ ok: true, sessionId: SESSION, status: "accepted" }), { status: 202, headers: { "content-type": "application/json" } });
    }
    if (method === "GET" && url.pathname === `/eve/v1/session/${SESSION}/stream`) {
      if (plan === "hang-open") return hang();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const push = (o: unknown) => controller.enqueue(line(o));
          controller.enqueue(enc.encode("\n"));
          push(ev("session.started", {}));
          push(ev("turn.started", { sequence: 0, turnId: "t1" }));
          push(ev("message.received", { message: MODEL_CHECK_PROMPT, parts: [{ type: "text", text: MODEL_CHECK_PROMPT }], sequence: 1, turnId: "t1" }));
          push(ev("step.started", { modelId: "probe-model", sequence: 2, stepIndex: 0, turnId: "t1" }));
          if (plan === "parked") {
            push(
              ev("input.requested", {
                requests: [{ action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "ask_question" }, kind: "question", prompt: "Which model?", requestId: "req-1" }],
                sequence: 3,
                stepIndex: 0,
                turnId: "t1",
              }),
            );
            push(WAITING());
            controller.close();
            return;
          }
          if (plan === "cancelled-elsewhere") {
            push(ev("turn.cancelled", { sequence: 3, turnId: "t1" }));
            push(WAITING());
            controller.close();
            return;
          }
          const reply = plan === "normal-bad-reply" ? "pong" : "ok";
          push(ev("message.appended", { messageDelta: reply, sequence: 3, stepIndex: 0, turnId: "t1" }));
          push(ev("message.completed", { message: reply, finishReason: "stop", sequence: 4, stepIndex: 0, turnId: "t1" }));
          push(ev("step.completed", { finishReason: "stop", sequence: 5, stepIndex: 0, turnId: "t1", usage: { inputTokens: 9, outputTokens: 1 } }));
          push(ev("turn.completed", { sequence: 6, turnId: "t1" }));
          push(WAITING());
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson", "x-eve-stream-version": "25" } });
    }
    return new Response("not found", { status: 404 });
  };
  vi.stubGlobal("fetch", fake);
  return { requests, cancels: () => cancels };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createEveGateway(...).checkModel against the real eve@0.63.0 client (P03.2, eve-runtime.md §8 item 15)", () => {
  it("the spike's normal sequence, replying 'ok': accepted, with no cancel", async () => {
    const fake = stubEve("normal-ok");
    const gateway = createEveGateway({ password: "fake-eve-password" });
    const result = await gateway.checkModel(5_000);
    expect(result.ok).toBe(true);
    expect(result.detail).toBeUndefined();
    expect(fake.cancels()).toBe(0);
  });

  it("a reply that isn't 'ok' is reported, not accepted", async () => {
    stubEve("normal-bad-reply");
    const gateway = createEveGateway({ password: "fake-eve-password" });
    const result = await gateway.checkModel(5_000);
    expect(result).toMatchObject({ ok: false, detail: "The model answered, but not with the expected reply." });
  });

  it("turn.cancelled then session.waiting is not ok, with no cancel of our own", async () => {
    const fake = stubEve("cancelled-elsewhere");
    const gateway = createEveGateway({ password: "fake-eve-password" });
    const result = await gateway.checkModel(5_000);
    expect(result).toMatchObject({ ok: false, detail: "The turn was cancelled before it finished." });
    expect(fake.cancels()).toBe(0);
  });

  it("waiting on the person (input.requested) is parked, not ok, with one real cancel through the session", async () => {
    const fake = stubEve("parked");
    const gateway = createEveGateway({ password: "fake-eve-password" });
    const result = await gateway.checkModel(5_000);
    expect(result).toMatchObject({ ok: false, detail: "The model asked for input instead of finishing the run." });
    expect(fake.cancels()).toBe(1);
  });

  it("an abort while the stream is opening ends quietly (no throw) but is still classified 'timeout', with one real cancel", async () => {
    const fake = stubEve("hang-open");
    const gateway = createEveGateway({ password: "fake-eve-password" });
    const started = performance.now();
    const result = await gateway.checkModel(300);
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("No answer within 0.3 s.");
    expect(fake.cancels()).toBe(1); // a real POST .../cancel, not just a no-op response.cancel()
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
