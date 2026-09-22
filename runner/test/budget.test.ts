import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { budgetStatusSchema } from "@workflow-catalog/contracts";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../lib/clock.ts";
import {
  CORRUPT_BUDGET_REASON,
  DEFAULT_DAILY_RUN_LIMIT,
  DEFAULT_ITEM_CAP,
  getBudgetState,
  getBudgetStatus,
  pauseBudget,
  resumeBudget,
  setBudgetLimits,
} from "../store/budget.ts";
import { finishRun, startRun, writePausedRun } from "../store/runs.ts";
import { Workspace } from "../store/workspace.ts";
import { newWorkspace } from "./helpers.ts";

describe("store/budget.ts: defaults and limits", () => {
  it("a missing file gives the defaults, unpaused", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const state = await getBudgetState(workspace, clock);
    expect(state).toMatchObject({ dailyRunLimit: DEFAULT_DAILY_RUN_LIMIT, itemCap: DEFAULT_ITEM_CAP, runsUsedToday: 0, paused: false, corrupt: false });
    expect(state.pausedReason).toBeUndefined();
  });

  it("setBudgetLimits saves within-bounds limits", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await setBudgetLimits(workspace, { dailyRunLimit: 20, itemCap: 8 });
    const state = await getBudgetState(workspace, clock);
    expect(state).toMatchObject({ dailyRunLimit: 20, itemCap: 8, paused: false });
  });

  it("rejects an out-of-bounds limit even at the store layer (defense in depth beneath the route's own zod check)", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await expect(setBudgetLimits(workspace, { dailyRunLimit: 999, itemCap: 5 })).rejects.toThrow();
    await expect(setBudgetLimits(workspace, { dailyRunLimit: 10, itemCap: 0 })).rejects.toThrow();
  });

  it("getBudgetStatus always validates against the wire budgetStatusSchema", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const status = await getBudgetStatus(workspace, clock);
    expect(budgetStatusSchema.safeParse(status).success).toBe(true);
    await pauseBudget(workspace, clock, "provider limit");
    const paused = await getBudgetStatus(workspace, clock);
    expect(budgetStatusSchema.safeParse(paused).success).toBe(true);
    expect(paused.pausedReason).toBe("provider limit");
  });
});

describe("store/budget.ts: pause and resume", () => {
  it("pauseBudget sets paused/reason/since and survives a restart (a new store instance reads it)", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await setBudgetLimits(workspace, { dailyRunLimit: 33, itemCap: 9 });
    await pauseBudget(workspace, clock, "provider limit");

    const reopened = await Workspace.open(workspace.root);
    const state = await getBudgetState(reopened, clock);
    expect(state).toMatchObject({ paused: true, pausedReason: "provider limit", dailyRunLimit: 33, itemCap: 9 });
    expect(state.pausedSince).toBe(clock.now().toISOString());
  });

  it("resumeBudget clears the pause and keeps the existing limits", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await setBudgetLimits(workspace, { dailyRunLimit: 33, itemCap: 9 });
    await pauseBudget(workspace, clock, "provider limit");
    await resumeBudget(workspace);
    const state = await getBudgetState(workspace, clock);
    expect(state).toMatchObject({ paused: false, dailyRunLimit: 33, itemCap: 9 });
    expect(state.pausedReason).toBeUndefined();
  });

  it("setBudgetLimits (Save) keeps an existing pause until Resume", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await pauseBudget(workspace, clock, "provider limit");
    await setBudgetLimits(workspace, { dailyRunLimit: 15, itemCap: 3 });
    const state = await getBudgetState(workspace, clock);
    expect(state).toMatchObject({ paused: true, pausedReason: "provider limit", dailyRunLimit: 15, itemCap: 3 });
  });
});

describe("store/budget.ts: decision 2 — corrupt runs/budget.json fails closed, never crashes", () => {
  it("malformed JSON: reported as paused with the fixed reason, never thrown", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const file = workspace.resolve("runs", "budget.json");
    await writeFile(file, "{ this is not json", "utf8");

    const state = await getBudgetState(workspace, clock);
    expect(state).toMatchObject({ paused: true, pausedReason: CORRUPT_BUDGET_REASON, corrupt: true, dailyRunLimit: DEFAULT_DAILY_RUN_LIMIT, itemCap: DEFAULT_ITEM_CAP });
    const status = await getBudgetStatus(workspace, clock);
    expect(budgetStatusSchema.safeParse(status).success).toBe(true);
    expect(status).toMatchObject({ paused: true, pausedReason: CORRUPT_BUDGET_REASON });
  });

  it("valid JSON that fails the schema: same fail-closed behavior", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await workspace.writeJson(["runs", "budget.json"], { dailyRunLimit: 999, itemCap: 5, paused: false });

    const state = await getBudgetState(workspace, clock);
    expect(state).toMatchObject({ paused: true, pausedReason: CORRUPT_BUDGET_REASON, corrupt: true });
  });

  it("runs are refused with a paused record while the file is corrupt (proven at the store layer; run-harness.test.ts proves it end to end)", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await writeFile(workspace.resolve("runs", "budget.json"), "not json at all", "utf8");
    const state = await getBudgetState(workspace, clock);
    expect(state.paused).toBe(true);
  });

  it("Resume rewrites a valid file with the default limits, unpaused (a corrupt file has nothing to restore)", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await writeFile(workspace.resolve("runs", "budget.json"), "{ broken", "utf8");
    await resumeBudget(workspace);
    const state = await getBudgetState(workspace, clock);
    expect(state).toMatchObject({ paused: false, dailyRunLimit: DEFAULT_DAILY_RUN_LIMIT, itemCap: DEFAULT_ITEM_CAP, corrupt: false });
  });

  it("Save repairs a corrupt file with the submitted limits but keeps it paused until Resume", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await writeFile(workspace.resolve("runs", "budget.json"), "{ broken", "utf8");
    await setBudgetLimits(workspace, { dailyRunLimit: 12, itemCap: 4 });
    const state = await getBudgetState(workspace, clock);
    expect(state).toMatchObject({ paused: true, pausedReason: CORRUPT_BUDGET_REASON, dailyRunLimit: 12, itemCap: 4, corrupt: false });
  });
});

describe("store/budget.ts: runsUsedToday derivation", () => {
  it("never counts paused records toward today's usage", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const successId = randomUUID();
    const { startedAt } = await startRun(workspace, clock, { runId: successId, kind: "manual", isCatchUp: false, idempotencyKey: "s", inputs: {} });
    await finishRun(workspace, clock, { runId: successId, kind: "manual", isCatchUp: false, idempotencyKey: "s", inputs: {}, startedAt, outcome: "success", model: "m", tokens: { input: 0, output: 0 } });
    await writePausedRun(workspace, clock, { runId: randomUUID(), kind: "manual", isCatchUp: false, idempotencyKey: "p1", inputs: {}, reason: "r" });
    await writePausedRun(workspace, clock, { runId: randomUUID(), kind: "manual", isCatchUp: false, idempotencyKey: "p2", inputs: {}, reason: "r" });

    const state = await getBudgetState(workspace, clock);
    expect(state.runsUsedToday).toBe(1);
  });

  it("resets on the next local day (an injected clock advance)", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const runId = randomUUID();
    const { startedAt } = await startRun(workspace, clock, { runId, kind: "manual", isCatchUp: false, idempotencyKey: "s", inputs: {} });
    await finishRun(workspace, clock, { runId, kind: "manual", isCatchUp: false, idempotencyKey: "s", inputs: {}, startedAt, outcome: "success", model: "m", tokens: { input: 0, output: 0 } });
    expect((await getBudgetState(workspace, clock)).runsUsedToday).toBe(1);

    clock.advance(24 * 60 * 60_000);
    expect((await getBudgetState(workspace, clock)).runsUsedToday).toBe(0);
  });
});
