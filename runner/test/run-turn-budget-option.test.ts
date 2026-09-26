import { afterEach, describe, expect, it } from "vitest";
import { PROVIDER_LIMIT_REASON, runTurn } from "../server/run-harness.ts";
import { getBudgetState } from "../store/budget.ts";
import { makeBridge } from "./helpers.ts";
import { rateLimitedTurn, scriptedEve, type ScriptedEve } from "./scripted-eve.ts";

/**
 * `runTurn`'s `pauseBudgetOnProviderLimit` option (P03.2 deliverable 1, Q5),
 * tested directly. Revision 1's record credited a `run-harness.test.ts` test
 * for "`false` doesn't pause" that doesn't exist; the option was proved only
 * through the extraction route (`onboarding-routes.test.ts`, the Q5 block).
 * `run-harness.test.ts` is P08-A's and stays unedited, so revision 2 (S3's
 * correction) adds the direct test here: the real eve@0.63.0 `Client` over a
 * scripted eve (`scripted-eve.ts`) whose turn fails with eve's primary
 * provider-limit signal (`semanticErrorId: "gateway-rate-limited"`).
 */

let scripted: ScriptedEve | undefined;

afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

async function providerLimitedTurn(pauseBudgetOnProviderLimit?: boolean) {
  scripted = scriptedEve(rateLimitedTurn());
  const bridge = await makeBridge({ eve: scripted.eve });
  const result = await runTurn(bridge.ctx, { message: "go", ...(pauseBudgetOnProviderLimit === undefined ? {} : { pauseBudgetOnProviderLimit }) });
  return { result, budget: await getBudgetState(bridge.workspace, bridge.clock) };
}

describe("runTurn: pauseBudgetOnProviderLimit (Q5, tested directly in revision 2)", () => {
  it("false: the provider limit is still detected and reported, and the budget stays unpaused", async () => {
    const { result, budget } = await providerLimitedTurn(false);
    expect(result).toMatchObject({ status: "failed", providerLimit: true });
    expect(budget.paused).toBe(false);
  });

  it("the default (the option left out) still pauses the budget, with the reason 'provider limit'", async () => {
    const { result, budget } = await providerLimitedTurn();
    expect(result).toMatchObject({ status: "failed", providerLimit: true });
    expect(budget).toMatchObject({ paused: true, pausedReason: PROVIDER_LIMIT_REASON });
  });

  it("true pauses, the same as the default", async () => {
    const { budget } = await providerLimitedTurn(true);
    expect(budget).toMatchObject({ paused: true, pausedReason: PROVIDER_LIMIT_REASON });
  });
});
