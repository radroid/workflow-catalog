import { afterEach, describe, expect, it } from "vitest";
import { ROUTES_DIR } from "../lib/paths.ts";
import { UI_COOKIE } from "../server/local-ui.ts";
import { loadRouteModules } from "../server/route-modules.ts";
import { readModelCheck } from "../store/model-check.ts";
import { BRIDGE, UI_TOKEN, makeBridge } from "./helpers.ts";
import { cancelledTurn, failedTurn, parkedTurn, rateLimitedTurn, replyTurn, scriptedEve, type Script, type ScriptedEve } from "./scripted-eve.ts";

/**
 * P03.2 revision 2, S5 (round-2 UI critic issue 1) and S8: the whole answer
 * `POST /api/model/check` returns, for each outcome, through the real route,
 * the real `checkModel` and the real eve@0.63.0 `Client` over a scripted eve
 * (`scripted-eve.ts`).
 *
 * The route's `detail` is shown after "The check failed: " on the Status page
 * (`ui/assets/status.js`) and after "the last model check failed: " by doctor
 * (`lib/doctor.ts`, reading `.runner/model-check.json`). Revision 1's
 * "The model check failed: …" read twice there. So each detail is a
 * lower-case clause that never says the check failed again, and never uses
 * eve's words "turn" or "run".
 *
 * The timeout isn't reachable here without waiting the route's 90 s: it is
 * asserted in `eve-gateway.test.ts` (90 s) and, over the real `Client`, in
 * `eve-gateway-real-client.test.ts` (300 ms).
 */

const COOKIE = `${UI_COOKIE}=${UI_TOKEN}`;
const SAME_ORIGIN = { cookie: COOKIE, origin: BRIDGE, "content-type": "application/json", "sec-fetch-site": "same-origin" };

let scripted: ScriptedEve | undefined;

afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

async function checkModelThroughTheRoute(script: Script) {
  scripted = scriptedEve(script);
  const bridge = await makeBridge({ modules: await loadRouteModules(ROUTES_DIR), eve: scripted.eve });
  const response = await bridge.request("/api/model/check", { method: "POST", headers: SAME_ORIGIN, body: "{}" });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    saved: await readModelCheck(bridge.workspace),
    checkedAt: bridge.clock.now().toISOString(),
  };
}

/** Q3's cases for the model check, each with the detail the route returns, whole. */
const FAILURES: ReadonlyArray<readonly [string, Script, string]> = [
  ["the model's error (turn.failed)", failedTurn("MODEL_CALL_FAILED", "Model provider API request failed (HTTP 400).", { statusCode: 400 }), "the model had a problem answering."],
  ["the provider's limit", rateLimitedTurn(), "the model's provider is rate-limited right now. Try again later."],
  ["eve or the network not answering (the session is created, then its stream refused with a 401)", "stream-401", "eve or the network didn't answer."],
  ["cancelled elsewhere (turn.cancelled)", cancelledTurn(), "it was cancelled before the model answered."],
  ["waiting on an input (a non-empty input.requested)", parkedTurn(), "the model asked a question instead of replying."],
  ["no usable result (the reply isn't 'ok')", replyTurn("pong"), "the model answered, but not with the expected reply."],
];

describe("POST /api/model/check: the whole answer, for each outcome (P03.2 revision 2, S5 and S8)", () => {
  it("the spike's normal turn, replying 'ok': ok, with no detail", async () => {
    const { status, body, saved, checkedAt } = await checkModelThroughTheRoute(replyTurn("ok"));
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, checkedAt, detail: null, modelId: null });
    expect(saved).toMatchObject({ ok: true, via: "runner" });
    expect(saved).not.toHaveProperty("detail");
  });

  for (const [what, script, detail] of FAILURES) {
    it(`${what}: the Status page reads "The check failed: ${detail}"`, async () => {
      const { status, body, saved, checkedAt } = await checkModelThroughTheRoute(script);
      expect(status).toBe(200);
      expect(body).toEqual({ ok: false, checkedAt, detail, modelId: null });
      expect(saved).toMatchObject({ ok: false, via: "runner", detail }); // what doctor reads back
      // Both places that show it already say the check failed, just before the detail.
      expect(detail).not.toMatch(/fail/i);
      expect(detail).not.toMatch(/\b(turn|run)\b/i);
      expect(detail[0]).toBe(detail[0]!.toLowerCase());
      expect(`The check failed: ${detail}`.length).toBeLessThanOrEqual(90);
    });
  }
});
