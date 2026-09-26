import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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
  REPAIRED_BUDGET_REASON,
  resumeBudget,
  runLogUnreadableReason,
  setBudgetLimits,
  withBudgetLock,
} from "../store/budget.ts";
import { finishRun, localDateString, startRun, writePausedRun } from "../store/runs.ts";
import { Workspace } from "../store/workspace.ts";
import { newWorkspace } from "./helpers.ts";

/** chmod can only deny access to a non-root user on a POSIX filesystem; CI (ubuntu, non-root) and macOS qualify. */
const canDenyAccess = process.platform !== "win32" && process.getuid?.() !== 0;

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

    // Nit (round-1 review): read the raw bytes directly, bypassing getBudgetState's own read path entirely —
    // pins that the pause is genuinely durable on disk, not reconstructible only through an in-memory shortcut
    // this design doesn't have today but a future regression could add.
    const raw = JSON.parse(await readFile(workspace.resolve("runs", "budget.json"), "utf8")) as Record<string, unknown>;
    expect(raw).toMatchObject({ paused: true, pausedReason: "provider limit", dailyRunLimit: 33, itemCap: 9, pausedSince: clock.now().toISOString() });
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

  it("runs are refused with a paused record while the file is corrupt (proven at the store layer; run-harness.test.ts's 'a corrupt runs/budget.json refuses withRun' test proves it end to end)", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await writeFile(workspace.resolve("runs", "budget.json"), "not json at all", "utf8");
    const state = await getBudgetState(workspace, clock);
    expect(state.paused).toBe(true);
  });

  it("Resume rewrites a valid file with the default limits, unpaused (a corrupt file has nothing to restore), and says so", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await writeFile(workspace.resolve("runs", "budget.json"), "{ broken", "utf8");
    expect((await getBudgetState(workspace, clock)).pauseKind).toBe("budget_unreadable");
    expect(await resumeBudget(workspace)).toEqual({ restoredDefaults: true });
    const state = await getBudgetState(workspace, clock);
    expect(state).toMatchObject({ paused: false, dailyRunLimit: DEFAULT_DAILY_RUN_LIMIT, itemCap: DEFAULT_ITEM_CAP, corrupt: false });
    expect(state.pauseKind).toBeUndefined();
  });

  it("Save repairs a corrupt file with the submitted limits but keeps it paused until Resume, with a reason that is true once the file is readable (I4)", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await writeFile(workspace.resolve("runs", "budget.json"), "{ broken", "utf8");
    await setBudgetLimits(workspace, { dailyRunLimit: 12, itemCap: 4 });
    const state = await getBudgetState(workspace, clock);
    expect(state).toMatchObject({ paused: true, pausedReason: REPAIRED_BUDGET_REASON, pauseKind: "budget_repaired", dailyRunLimit: 12, itemCap: 4, corrupt: false });
    const raw = JSON.parse(await readFile(workspace.resolve("runs", "budget.json"), "utf8")) as Record<string, unknown>;
    expect(raw).toEqual({ dailyRunLimit: 12, itemCap: 4, paused: true, pausedReason: REPAIRED_BUDGET_REASON });

    // Resume after the repairing Save keeps the person's limits: the file was readable at that moment.
    expect(await resumeBudget(workspace)).toEqual({ restoredDefaults: false });
    expect(await getBudgetState(workspace, clock)).toMatchObject({ paused: false, dailyRunLimit: 12, itemCap: 4 });
  });

  it("a file an earlier version repaired (stored reason still the 'unreadable' one) reads as repaired, not as unreadable now", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await workspace.writeJson(["runs", "budget.json"], { dailyRunLimit: 8, itemCap: 4, paused: true, pausedReason: CORRUPT_BUDGET_REASON });
    expect(await getBudgetState(workspace, clock)).toMatchObject({ paused: true, pauseKind: "budget_repaired", corrupt: false, dailyRunLimit: 8, itemCap: 4 });
  });

  it("a normal Resume reports restoredDefaults false", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await pauseBudget(workspace, clock, "provider limit");
    expect(await resumeBudget(workspace)).toEqual({ restoredDefaults: false });
  });
});

describe("store/budget.ts: I2 — getBudgetState never throws", () => {
  it.skipIf(!canDenyAccess)("today's run folder can't be listed (chmod 000): a synthetic pause naming the folder, never thrown, and it clears once the folder is readable", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await setBudgetLimits(workspace, { dailyRunLimit: 7, itemCap: 3 });
    const date = localDateString(clock.now());
    const today = workspace.resolve("runs", date);
    await mkdir(today, { recursive: true });
    await chmod(today, 0o000);
    try {
      const state = await getBudgetState(workspace, clock);
      expect(state).toMatchObject({
        dailyRunLimit: 7,
        itemCap: 3,
        runsUsedToday: 0,
        paused: true,
        pausedReason: runLogUnreadableReason(date),
        pauseKind: "run_log_unreadable",
        corrupt: false,
        runLogUnreadable: true,
      });
      expect(state.pausedReason).toBe(`run log unreadable (runs/${date}/)`);
      const status = await getBudgetStatus(workspace, clock);
      expect(budgetStatusSchema.safeParse(status).success).toBe(true);
      expect(status).toEqual({ dailyRunLimit: 7, runsUsedToday: 0, paused: true, pausedReason: runLogUnreadableReason(date) });

      // Resume can't clear it: the pause is derived from the folder on every read, never stored.
      await resumeBudget(workspace);
      expect((await getBudgetState(workspace, clock)).pauseKind).toBe("run_log_unreadable");
    } finally {
      await chmod(today, 0o700);
    }
    expect(await getBudgetState(workspace, clock)).toMatchObject({ paused: false, runLogUnreadable: false });
  });

  it.skipIf(!canDenyAccess)("precedence: a stored pause is reported ahead of the run-log pause, and the run log stays flagged", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await pauseBudget(workspace, clock, "provider limit");
    const today = workspace.resolve("runs", localDateString(clock.now()));
    await mkdir(today, { recursive: true });
    await chmod(today, 0o000);
    try {
      expect(await getBudgetState(workspace, clock)).toMatchObject({ paused: true, pausedReason: "provider limit", pauseKind: "stored", runLogUnreadable: true });
    } finally {
      await chmod(today, 0o700);
    }
  });

  it.skipIf(!canDenyAccess)("all of runs/ unreadable (chmod 000): the budget file can't be read either, so it fails closed as unreadable, never thrown", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await setBudgetLimits(workspace, { dailyRunLimit: 7, itemCap: 3 });
    const runs = workspace.resolve("runs");
    await chmod(runs, 0o000);
    try {
      const state = await getBudgetState(workspace, clock);
      expect(state).toMatchObject({ paused: true, pausedReason: CORRUPT_BUDGET_REASON, pauseKind: "budget_unreadable", corrupt: true, runLogUnreadable: true });
      expect(budgetStatusSchema.safeParse(await getBudgetStatus(workspace, clock)).success).toBe(true);
    } finally {
      await chmod(runs, 0o700);
    }
  });
});

describe("store/budget.ts: G4 (round-1 revision, reviewer issue 5) — serialized writes", () => {
  it("a Save racing a provider-limit pause keeps both writes, every time (mutation target: un-serialize the writes)", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    let pausesLost = 0;
    let limitsLost = 0;
    const trials = 40;
    for (let i = 0; i < trials; i += 1) {
      await setBudgetLimits(workspace, { dailyRunLimit: 10, itemCap: 5 });
      await resumeBudget(workspace); // a clean, unpaused starting state each trial
      await Promise.all([setBudgetLimits(workspace, { dailyRunLimit: 12, itemCap: 4 }), pauseBudget(workspace, clock, "provider limit")]);
      const state = await getBudgetState(workspace, clock);
      if (!state.paused || state.pausedReason !== "provider limit") pausesLost += 1;
      if (state.dailyRunLimit !== 12 || state.itemCap !== 4) limitsLost += 1;
    }
    // Nit 5 (round 2): assert both writes, not just the pause.
    expect({ pausesLost, limitsLost }).toEqual({ pausesLost: 0, limitsLost: 0 });
  });

  it("withBudgetLock runs callers strictly one at a time per workspace", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const order: number[] = [];
    let active = 0;
    let overlapped = false;
    const task = (n: number) =>
      withBudgetLock(workspace, async () => {
        active += 1;
        if (active > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(n);
        active -= 1;
      });
    await Promise.all([task(1), task(2), task(3)]);
    expect(overlapped).toBe(false);
    expect(order).toEqual([1, 2, 3]); // queued in call order
  });

  it("a rejecting callback does not poison the chain for the next caller", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await expect(
      withBudgetLock(workspace, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // A later, unrelated lock use still runs (this is what a broken chain would hang or reject).
    const result = await withBudgetLock(workspace, async () => "ok");
    expect(result).toBe("ok");
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
