import type { Client, ClientSession, MessageResponse, MessageStreamEvent } from "eve/client";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../lib/clock.ts";
import { createRunnerContext, silentLogger } from "../server/context.ts";
import type { EveGateway } from "../server/eve-gateway.ts";
import { runTurn } from "../server/run-harness.ts";
import { newWorkspace } from "./helpers.ts";

/**
 * P04's one additive change to `run-harness.ts`: `RunTurnInput.collectEvents`
 * and `TurnResult.events`, so a caller (`captures.ts`'s extraction turn) can
 * read a tool's `action.result` off the real event stream — P03's pattern for
 * reading `extract_claims`'s output — without `runTurn` growing a second
 * turn classifier. Purely additive: every existing caller (which never sets
 * `collectEvents`) gets exactly the same `TurnResult` shape as before, which
 * `run-harness.test.ts`'s own suite (unedited by this packet) already proves
 * by continuing to pass.
 */

const META = { at: "2026-09-22T09:00:00.000Z", id: "evt-0" };

function started(modelId: string): MessageStreamEvent {
  return { type: "step.started", data: { modelId, sequence: 0, stepIndex: 0, turnId: "t1" }, meta: META };
}

function actionResult(toolName: string, output: unknown): MessageStreamEvent {
  return {
    type: "action.result",
    data: { status: "completed", result: { kind: "tool-result", callId: "call-1", toolName, output }, sequence: 1, stepIndex: 0, turnId: "t1" },
    meta: META,
  } as MessageStreamEvent;
}

function completed(): MessageStreamEvent {
  return { type: "step.completed", data: { finishReason: "stop", sequence: 2, stepIndex: 0, turnId: "t1", usage: { inputTokens: 5, outputTokens: 1 } }, meta: META };
}

function turnCompleted(): MessageStreamEvent {
  return { type: "turn.completed", data: { sequence: 3, turnId: "t1" }, meta: META };
}

function sessionWaiting(): MessageStreamEvent {
  return { type: "session.waiting", data: { continuationToken: "s1", wait: "next-user-message" }, meta: META };
}

function fakeEve(events: readonly MessageStreamEvent[]): EveGateway {
  const create = async () => {
    const response = {
      [Symbol.asyncIterator]: () =>
        (async function* () {
          for (const event of events) yield event;
        })(),
    } as unknown as MessageResponse;
    const session = { cancel: async () => ({ status: "accepted" as const, sessionId: "s1" }) } as unknown as ClientSession;
    return { response, session };
  };
  return {
    url: "http://127.0.0.1:3210",
    client: { sessions: { create } } as unknown as Client,
    health: async () => ({ ok: true }),
    modelId: async () => undefined,
    checkModel: async () => ({ ok: true }),
  };
}

async function contextWith(eve?: EveGateway) {
  const workspace = await newWorkspace();
  return createRunnerContext({ workspace, clock: new ManualClock(), packageVersion: "0.1.0", eve, log: silentLogger });
}

describe("run-harness.ts: runTurn collectEvents (P04, additive)", () => {
  it("without collectEvents, the result carries no events field at all (existing callers unaffected)", async () => {
    const ctx = await contextWith(fakeEve([started("m1"), actionResult("extract_job", { ok: true }), completed(), turnCompleted(), sessionWaiting()]));
    const result = await runTurn(ctx, { message: "go" });
    expect(result.status).toBe("ok");
    expect("events" in result).toBe(false);
  });

  it("with collectEvents: true, the result carries every stream event in order, including action.result", async () => {
    const events = [started("m1"), actionResult("extract_job", { jobId: "j1", revision: 1, persisted: true, message: "Saved." }), completed(), turnCompleted(), sessionWaiting()];
    const ctx = await contextWith(fakeEve(events));
    const result = await runTurn(ctx, { message: "go", collectEvents: true });
    expect(result.status).toBe("ok");
    expect(result.events).toEqual(events);
  });

  it("a caller reads a tool's action.result off the collected events, the same way P03's onboarding route does", async () => {
    const events = [started("m1"), actionResult("extract_job", { jobId: "job-1", revision: 2, persisted: true, message: "Saved the extracted fields." }), turnCompleted(), sessionWaiting()];
    const ctx = await contextWith(fakeEve(events));
    const result = await runTurn(ctx, { message: "go", collectEvents: true });
    const actionResultEvent = result.events?.find((event) => event.type === "action.result");
    expect(actionResultEvent).toBeDefined();
    if (actionResultEvent?.type === "action.result" && actionResultEvent.data.result.kind === "tool-result") {
      expect(actionResultEvent.data.result.toolName).toBe("extract_job");
      expect(actionResultEvent.data.result.output).toMatchObject({ jobId: "job-1", revision: 2, persisted: true });
    } else {
      throw new Error("expected an action.result tool-result event");
    }
  });

  it("events are still collected on a non-ok turn (e.g. failed), when asked for", async () => {
    const ctx = await contextWith(fakeEve([started("m1")])); // ends with no boundary at all: classified "failed" (G1)
    const result = await runTurn(ctx, { message: "go", collectEvents: true });
    expect(result.status).toBe("failed");
    expect(result.events).toEqual([started("m1")]);
  });

  it("events is an empty array (not omitted) when eve is not running and collectEvents was requested", async () => {
    const ctx = await contextWith(undefined);
    const result = await runTurn(ctx, { message: "go", collectEvents: true });
    expect(result.status).toBe("failed");
    expect(result.events).toEqual([]);
  });
});
