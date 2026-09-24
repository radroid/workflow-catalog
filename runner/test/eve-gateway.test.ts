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
 * `Client` in `eve-gateway-real-client.test.ts`). It checks the adapter's own
 * decisions: "cancelled"/"parked"/"timeout" are reported with `classifyTurn`'s
 * own already-plain detail verbatim; "failed" is phrased here for a person
 * (Q3, revision 1) — never the raw code/status a `TurnResult.detail` can
 * carry for that status, which the round-1 reviewer found this file's own
 * "failed" case had degenerated into asserting as a pass-through, proving
 * nothing about the wording actually shown; and an "ok" turn is accepted only
 * when its reply text includes "ok".
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

  it("cancelled/timeout are reported with classifyTurn's own already-plain detail, verbatim (parked: see below)", () => {
    expect(interpretModelCheck({ status: "cancelled", detail: "The turn was cancelled before it finished." })).toEqual({
      ok: false,
      detail: "The turn was cancelled before it finished.",
    });
    expect(interpretModelCheck({ status: "timeout", detail: "No answer within 90 s." })).toEqual({ ok: false, detail: "No answer within 90 s." });
  });

  it("Q3 (revision 1, critic 3): 'failed' is phrased for a person, with no code, status or HTTP number — never a pass-through of TurnResult.detail", () => {
    // A real failure event happened (the model itself answered with a problem): "the model's error", whatever
    // classifyTurn's own detail says (a raw eve code:message here, exactly what must not reach the page).
    expect(
      interpretModelCheck({
        status: "failed",
        detail: "MODEL_ERROR: HTTP 400: model not supported",
        events: [{ type: "session.failed", data: { code: "MODEL_ERROR", message: "model not supported", sessionId: "s1" } } as never],
      }),
    ).toEqual({ ok: false, detail: "The model check failed: the model had a problem answering." });
    // No failure event at all (a thrown, non-abort error from sessions.create, or a quiet no-boundary end):
    // "eve or the network didn't answer" — genuinely not a claim the model itself said anything.
    expect(interpretModelCheck({ status: "failed", detail: "fetch failed", events: [] })).toEqual({
      ok: false,
      detail: "The model check failed: eve or the network didn't answer.",
    });
    expect(interpretModelCheck({ status: "failed", detail: "The turn ended without a result." })).toEqual({
      ok: false,
      detail: "The model check failed: eve or the network didn't answer.",
    });
    // A provider limit: reported as such, not folded into "the model's error" — pausing the budget stays
    // runTurn's decision, not this adapter's; checkModel calls classifyTurn directly, so it never pauses at all.
    expect(
      interpretModelCheck({
        status: "failed",
        providerLimit: true,
        detail: "provider limit (rate limited)",
        events: [{ type: "session.failed", data: { code: "rate_limited", message: "rate limited", sessionId: "s1" } } as never],
      }),
    ).toEqual({ ok: false, detail: "The model's provider is rate-limited right now. Try again later." });
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
