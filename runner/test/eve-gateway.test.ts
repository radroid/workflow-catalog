import type { MessageStreamEvent } from "eve/client";
import { describe, expect, it } from "vitest";
import { interpretModelCheck } from "../server/eve-gateway.ts";
import type { TurnResult } from "../server/run-harness.ts";

/**
 * P03.2 (deliverable 1): `interpretModelCheck` is now a thin adapter over
 * `classifyTurn`'s own `TurnResult` (run-harness.ts) — it does no turn
 * classification of its own, so this file no longer scripts a raw
 * `MessageResult`/event stream and re-derives ok/failed/parked from it (that
 * is `classifyTurn`'s job, covered end to end against the real eve@0.63.0
 * `Client` in `eve-gateway-real-client.test.ts`). It only checks the
 * adapter's own two decisions: a non-"ok" `TurnResult` is reported with
 * `runTurn`'s own detail, and an "ok" turn is accepted only when its reply
 * text includes "ok".
 */

const ZERO = { input: 0, output: 0 };

function messageCompleted(message: string): MessageStreamEvent {
  return { type: "message.completed", data: { finishReason: "stop", message, sequence: 0, stepIndex: 0, turnId: "t1" }, meta: { at: "2026-09-22T09:00:00.000Z", id: "evt-0" } } as MessageStreamEvent;
}

function ok(reply: string): TurnResult {
  return { status: "ok", tokens: ZERO, events: [messageCompleted(reply)] };
}

describe("interpretModelCheck: a thin adapter over classifyTurn's TurnResult", () => {
  it("accepts an 'ok' turn whose reply includes ok, whatever eve's own boundary was (classifyTurn already normalised that)", () => {
    expect(interpretModelCheck(ok("ok"))).toEqual({ ok: true });
    expect(interpretModelCheck(ok("OK."))).toEqual({ ok: true }); // case and trailing punctuation don't matter
  });

  it("reports any non-'ok' status with runTurn's own detail, not a reinvented one", () => {
    expect(interpretModelCheck({ status: "failed", detail: "MODEL_ERROR: HTTP 400: model not supported" })).toEqual({
      ok: false,
      detail: "MODEL_ERROR: HTTP 400: model not supported",
    });
    expect(interpretModelCheck({ status: "failed", detail: "The turn ended without a result." })).toEqual({
      ok: false,
      detail: "The turn ended without a result.",
    });
    // A provider limit: runTurn's own detail names it, and pausing the budget is runTurn's decision, not this adapter's.
    expect(interpretModelCheck({ status: "failed", detail: "provider limit (rate limited)" })).toEqual({
      ok: false,
      detail: "provider limit (rate limited)",
    });
    expect(interpretModelCheck({ status: "cancelled", detail: "The turn was cancelled before it finished." })).toEqual({
      ok: false,
      detail: "The turn was cancelled before it finished.",
    });
    expect(interpretModelCheck({ status: "timeout", detail: "No answer within 90 s." })).toEqual({ ok: false, detail: "No answer within 90 s." });
  });

  it("does not count an unexpected answer or a park as ok", () => {
    expect(interpretModelCheck(ok("pong")).ok).toBe(false);
    expect(interpretModelCheck(ok("pong"))).toEqual({ ok: false, detail: "The model answered, but not with the expected reply." });
    // A non-empty input.requested parks the turn (eve-runtime.md §8 item 15): classifyTurn reports "parked", never "ok".
    expect(interpretModelCheck({ status: "parked", detail: "The model asked for input instead of finishing the run." })).toEqual({
      ok: false,
      detail: "The model asked for input instead of finishing the run.",
    });
  });

  it("an 'ok' turn with no message.completed event (defensive) reads as no reply, so it fails the same way", () => {
    expect(interpretModelCheck({ status: "ok", events: [] })).toEqual({ ok: false, detail: "The model answered, but not with the expected reply." });
    expect(interpretModelCheck({ status: "ok" })).toEqual({ ok: false, detail: "The model answered, but not with the expected reply." });
  });
});
