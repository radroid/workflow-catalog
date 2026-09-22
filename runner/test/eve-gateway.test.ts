import type { MessageResult } from "eve/client";
import { describe, expect, it } from "vitest";
import { interpretModelCheck } from "../server/eve-gateway.ts";

type Outcome = Parameters<typeof interpretModelCheck>[0];

function turn(overrides: Partial<Outcome> = {}): Outcome {
  return { status: "waiting", events: [], message: "ok", inputRequests: [], ...overrides };
}

describe("model check through eve", () => {
  it("accepts a completed turn: the session parks, waiting for the next message", () => {
    expect(interpretModelCheck(turn())).toEqual({ ok: true });
    expect(interpretModelCheck(turn({ status: "completed", message: "OK." }))).toEqual({ ok: true });
  });

  it("reports a failed model call with its code and message", () => {
    const events = [{ type: "turn.failed", data: { code: "MODEL_ERROR", message: "HTTP 400: model not supported", sequence: 1, turnId: "t" } }] as unknown as MessageResult["events"];
    expect(interpretModelCheck(turn({ events, message: undefined }))).toEqual({ ok: false, detail: "MODEL_ERROR: HTTP 400: model not supported" });
    expect(interpretModelCheck(turn({ status: "failed", message: undefined }))).toEqual({ ok: false, detail: 'The turn ended as "failed".' });
  });

  it("does not count an unexpected answer or a request for input", () => {
    expect(interpretModelCheck(turn({ message: "pong" })).ok).toBe(false);
    expect(interpretModelCheck(turn({ inputRequests: [{}] as unknown as MessageResult["inputRequests"] })).ok).toBe(false);
  });
});
