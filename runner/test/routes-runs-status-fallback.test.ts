// I2 (round-2 escalation): `GET /status` must stay 200. Its handler (server/extension-api.ts, P02) awaits every
// route module's `status()` with no catch of its own, so routes/runs.ts's `status()` must be unable to throw.
// `getBudgetState` is built never to throw (budget.test.ts proves that against real filesystem failures); this
// file proves the second line of defence by making `getBudgetStatus` reject outright. The module mock applies to
// this whole file, which is why it lives apart from routes-runs.test.ts.
import { budgetStatusSchema, statusResponseSchema } from "@workflow-catalog/contracts";
import { describe, expect, it, vi } from "vitest";
import runsRoutes from "../server/routes/runs.ts";
import { BUDGET_UNAVAILABLE_REASON, DEFAULT_DAILY_RUN_LIMIT } from "../store/budget.ts";
import { EXTENSION_ORIGIN, makeBridge, pairDevice } from "./helpers.ts";

vi.mock("../store/budget.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store/budget.ts")>();
  return {
    ...actual,
    getBudgetStatus: vi.fn(async () => {
      throw new Error("simulated: the budget could not be computed");
    }),
  };
});

describe("routes/runs.ts: status() never throws (I2)", () => {
  it("resolves with a fail-closed paused budget that validates, and logs why", async () => {
    const bridge = await makeBridge({ modules: [{ name: "runs", module: runsRoutes }] });
    const contribution = await runsRoutes.status!(bridge.ctx);
    expect(contribution.budget).toEqual({ dailyRunLimit: DEFAULT_DAILY_RUN_LIMIT, runsUsedToday: 0, paused: true, pausedReason: BUDGET_UNAVAILABLE_REASON });
    expect(budgetStatusSchema.safeParse(contribution.budget).success).toBe(true);
    expect(bridge.logs.some((line) => line.includes("the budget could not be computed"))).toBe(true);
  });

  it("GET /status stays 200 and matches the contract", async () => {
    const bridge = await makeBridge({ modules: [{ name: "runs", module: runsRoutes }] });
    const { token } = await pairDevice(bridge);
    const response = await bridge.request("/status", { headers: { authorization: `Bearer ${token}`, origin: EXTENSION_ORIGIN } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(statusResponseSchema.safeParse(body).success).toBe(true);
    expect((body as { budget: { paused: boolean; pausedReason?: string } }).budget).toMatchObject({ paused: true, pausedReason: BUDGET_UNAVAILABLE_REASON });
  });
});
