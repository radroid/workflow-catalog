import { vi } from "vitest";
import { createEveGateway, MODEL_CHECK_PROMPT, type EveGateway } from "../server/eve-gateway.ts";

/**
 * A scripted eve for route tests (P03.2 revision 2, S5 and S8): the runner's
 * own gateway (`createEveGateway`: the real eve@0.63.0 `Client`, basic auth,
 * `redirect: "manual"`) with global `fetch` stubbed, so the session, stream
 * and cancel requests answer from a script. No port is bound and nothing
 * live is contacted: the same technique as `eve-gateway-real-client.test.ts`
 * and `onboarding-extract-timeout.test.ts`. `/eve/v1/info` is left
 * unanswered (404), so `modelId()` resolves undefined, as it does there.
 *
 * Not a test file (vitest runs only `*.test.ts`). The bridge's own requests
 * go through Hono's `app.request`, never the global `fetch`, so only eve's
 * traffic reaches the stub.
 */

const SESSION = "s-scripted";
const encoder = new TextEncoder();
let counter = 0;

export type ScriptedEvent = Record<string, unknown>;

export function eveEvent(type: string, data: Record<string, unknown> = {}): ScriptedEvent {
  counter += 1;
  return { type, data, meta: { at: "2026-09-24T09:00:00.000Z", id: `evt-${String(counter).padStart(5, "0")}` } };
}

function head(): ScriptedEvent[] {
  return [
    eveEvent("session.started"),
    eveEvent("turn.started", { sequence: 0, turnId: "t1" }),
    eveEvent("message.received", { message: MODEL_CHECK_PROMPT, parts: [{ type: "text", text: MODEL_CHECK_PROMPT }], sequence: 1, turnId: "t1" }),
    eveEvent("step.started", { modelId: "fake-model", sequence: 2, stepIndex: 0, turnId: "t1" }),
  ];
}

const waiting = () => eveEvent("session.waiting", { continuationToken: SESSION, wait: "next-user-message" });

/** The P02 spike's normal turn, replying `reply`: … `turn.completed → session.waiting`. */
export function replyTurn(reply: string): ScriptedEvent[] {
  return [
    ...head(),
    eveEvent("message.appended", { messageDelta: reply, sequence: 3, stepIndex: 0, turnId: "t1" }),
    eveEvent("message.completed", { message: reply, finishReason: "stop", sequence: 4, stepIndex: 0, turnId: "t1" }),
    eveEvent("step.completed", { finishReason: "stop", sequence: 5, stepIndex: 0, turnId: "t1", usage: { inputTokens: 9, outputTokens: 1 } }),
    eveEvent("turn.completed", { sequence: 6, turnId: "t1" }),
    waiting(),
  ];
}

/** The model call fails: `turn.failed` (eve's `TurnFailedStreamEvent` shape), then `session.waiting`. */
export function failedTurn(code: string, message: string, details?: Record<string, unknown>): ScriptedEvent[] {
  return [...head(), eveEvent("turn.failed", { code, message, ...(details ? { details } : {}), sequence: 3, turnId: "t1" }), waiting()];
}

/** A provider limit by eve's primary signal (`semanticErrorId: "gateway-rate-limited"`), as run-harness.test.ts scripts it. */
export function rateLimitedTurn(): ScriptedEvent[] {
  return failedTurn("MODEL_CALL_FAILED", "AI Gateway rate-limited the request.", { semanticErrorId: "gateway-rate-limited" });
}

/** Someone else cancelled the turn: `turn.cancelled`, then `session.waiting`. */
export function cancelledTurn(): ScriptedEvent[] {
  return [...head(), eveEvent("turn.cancelled", { sequence: 3, turnId: "t1" }), waiting()];
}

/** The turn waits on the person: a non-empty `input.requested`, then `session.waiting`. */
export function parkedTurn(): ScriptedEvent[] {
  const request = { action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "ask_question" }, kind: "question", prompt: "Which model?", requestId: "req-1" };
  return [...head(), eveEvent("input.requested", { requests: [request], sequence: 3, stepIndex: 0, turnId: "t1" }), waiting()];
}

/** What eve's stream does: the events above; or the session is created, then opening its stream is refused (401); or the stream never opens. */
export type Script = readonly ScriptedEvent[] | "stream-401" | "hang-open";

export interface ScriptedEve {
  /** A real gateway: `createEveGateway`, over the stubbed `fetch`. */
  readonly eve: EveGateway;
  /** How many `POST /eve/v1/session/:id/cancel` requests eve received. */
  cancels(): number;
  /** How many sessions were created. */
  sessions(): number;
  /** Puts the real `fetch` back (`vi.unstubAllGlobals()`). */
  restore(): void;
}

/** Stubs global `fetch` with eve answering `script` for every session, and returns the runner's own gateway over it. */
export function scriptedEve(script: Script): ScriptedEve {
  let cancels = 0;
  let sessions = 0;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const signal = init.signal ?? undefined;
    if (method === "POST" && url.pathname === "/eve/v1/session") {
      sessions += 1;
      return new Response(JSON.stringify({ ok: true, sessionId: SESSION }), { status: 202, headers: { "content-type": "application/json", "x-eve-session-id": SESSION } });
    }
    if (method === "POST" && url.pathname === `/eve/v1/session/${SESSION}/cancel`) {
      cancels += 1;
      return new Response(JSON.stringify({ ok: true, sessionId: SESSION, status: "accepted" }), { status: 202, headers: { "content-type": "application/json" } });
    }
    if (method === "GET" && url.pathname === `/eve/v1/session/${SESSION}/stream`) {
      if (script === "stream-401") return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
      if (script === "hang-open") {
        return new Promise<Response>((_resolve, reject) => {
          if (signal?.aborted) return reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("\n"));
          for (const event of script) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson", "x-eve-stream-version": "25" } });
    }
    return new Response("not found", { status: 404 });
  });
  return {
    eve: createEveGateway({ password: "fake-eve-password" }),
    cancels: () => cancels,
    sessions: () => sessions,
    restore: () => vi.unstubAllGlobals(),
  };
}
