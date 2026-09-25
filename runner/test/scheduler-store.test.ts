import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../lib/clock.ts";
import { claimSlot, getAllScheduleStates, getScheduleState, pauseSchedule, recordAttempt, resumeSchedule } from "../scheduler/store.ts";
import { Workspace } from "../store/workspace.ts";
import { newWorkspace } from "./helpers.ts";

describe("scheduler/store.ts: per-schedule pause (distinct from the budget's)", () => {
  it("a schedule not yet touched reads as not paused", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    expect(await getScheduleState(workspace, "daily-prepare")).toEqual({ paused: false });
  });

  it("pauseSchedule sets a reason and a timestamp; resumeSchedule clears them", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await pauseSchedule(workspace, clock, "daily-prepare", "provider limit");
    const paused = await getScheduleState(workspace, "daily-prepare");
    expect(paused.paused).toBe(true);
    expect(paused.pausedReason).toBe("provider limit");
    expect(paused.pausedSince).toBe(clock.now().toISOString());

    await resumeSchedule(workspace, "daily-prepare");
    const resumed = await getScheduleState(workspace, "daily-prepare");
    expect(resumed.paused).toBe(false);
    expect(resumed.pausedReason).toBeUndefined();
    expect(resumed.pausedSince).toBeUndefined();
  });

  it("pausing one schedule leaves the other untouched", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await pauseSchedule(workspace, clock, "daily-prepare", "paused from Settings");
    expect((await getScheduleState(workspace, "weekly-review")).paused).toBe(false);
  });

  it("Acceptance: pause state survives a restart — a fresh Workspace handle over the same directory still reads it", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await pauseSchedule(workspace, clock, "weekly-review", "provider limit");
    await recordAttempt(workspace, { id: "daily-prepare", slotId: "2026-09-25", at: clock.now().toISOString(), succeeded: true, summary: "attempted 1." });

    // Simulate a restart: reopen the same on-disk workspace as a brand-new Workspace instance (no in-memory
    // state carried over — the locks WeakMap is keyed by instance, so this also proves persistence doesn't
    // depend on the lock surviving).
    const reopened = await Workspace.open(workspace.root);
    const reReadPause = await getScheduleState(reopened, "weekly-review");
    expect(reReadPause).toMatchObject({ paused: true, pausedReason: "provider limit" });
    const reReadAttempt = await getScheduleState(reopened, "daily-prepare");
    expect(reReadAttempt).toMatchObject({ lastSlotId: "2026-09-25", lastSummary: "attempted 1." });
  });

  it("the state file on disk is plain, human-readable JSON", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await pauseSchedule(workspace, clock, "daily-prepare", "paused from Settings");
    const raw = await readFile(workspace.resolve("scheduler", "state.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed["daily-prepare"]).toMatchObject({ paused: true, pausedReason: "paused from Settings" });
  });
});

describe("scheduler/store.ts: claimSlot", () => {
  it("the first claim for a (schedule, slot) succeeds; a second claim for the same pair fails", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    expect(await claimSlot(workspace, clock, "daily-prepare", "2026-09-25")).toBe(true);
    expect(await claimSlot(workspace, clock, "daily-prepare", "2026-09-25")).toBe(false);
  });

  it("different slots, or different schedules, claim independently", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    expect(await claimSlot(workspace, clock, "daily-prepare", "2026-09-25")).toBe(true);
    expect(await claimSlot(workspace, clock, "daily-prepare", "2026-09-26")).toBe(true);
    expect(await claimSlot(workspace, clock, "weekly-review", "2026-09-25")).toBe(true);
  });

  it("concurrent claims for the same slot: exactly one wins", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const results = await Promise.all(Array.from({ length: 10 }, () => claimSlot(workspace, clock, "daily-prepare", "2026-09-25")));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe("scheduler/store.ts: recordAttempt and getAllScheduleStates", () => {
  it("records the last attempt always, and the last success only when succeeded", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await recordAttempt(workspace, { id: "daily-prepare", slotId: "2026-09-25", at: "2026-09-25T09:00:00.000Z", succeeded: false, summary: "Skipped: budget paused." });
    const afterFailure = await getScheduleState(workspace, "daily-prepare");
    expect(afterFailure.lastAttemptAt).toBe("2026-09-25T09:00:00.000Z");
    expect(afterFailure.lastSuccessfulRunAt).toBeUndefined();

    await recordAttempt(workspace, { id: "daily-prepare", slotId: "2026-09-26", at: "2026-09-26T09:00:00.000Z", succeeded: true, summary: "attempted 1." });
    const afterSuccess = await getScheduleState(workspace, "daily-prepare");
    expect(afterSuccess.lastSuccessfulRunAt).toBe("2026-09-26T09:00:00.000Z");
    expect(afterSuccess.lastSlotId).toBe("2026-09-26");
  });

  it("getAllScheduleStates returns every schedule that has been touched, keyed by id", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await pauseSchedule(workspace, clock, "daily-prepare", "paused from Settings");
    const all = await getAllScheduleStates(workspace);
    expect(Object.keys(all)).toEqual(["daily-prepare"]);
  });
});
