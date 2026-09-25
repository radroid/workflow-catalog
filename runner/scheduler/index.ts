import type { RunnerContext } from "../server/context.ts";
import { runDueSchedules } from "./dispatch.ts";

/**
 * How often the fallback trigger re-checks whether a schedule is due
 * (design note): frequent enough that a missed exact minute — a long-running
 * previous turn, the laptop briefly asleep — is picked up again within a
 * few minutes, cheap enough (two schedules, each a handful of small file
 * reads when nothing is due) to run in the background of a person's laptop
 * indefinitely.
 */
export const FALLBACK_TICK_MS = 5 * 60_000;

function logFailure(ctx: RunnerContext, when: string) {
  return (error: unknown) => ctx.log.error(`scheduler: the ${when} check failed (${error instanceof Error ? error.message : String(error)}).`);
}

/**
 * `route-modules.ts`'s `start(ctx)` hook (README: "P08's scheduler catch-up"):
 * runs the catch-up check once, immediately, then the fallback trigger on a
 * recurring interval. Returns a stop function so the bridge can clear the
 * interval on shutdown (route-modules.ts's `StopFunction`).
 */
export function startScheduler(ctx: RunnerContext): () => void {
  void runDueSchedules(ctx).catch(logFailure(ctx, "startup catch-up"));
  const timer = setInterval(() => {
    void runDueSchedules(ctx).catch(logFailure(ctx, "fallback-trigger"));
  }, FALLBACK_TICK_MS);
  // Node-only: lets a short-lived process (a CLI, a test) exit without this timer keeping it alive. No-op under
  // other runtimes' setInterval, which is fine — nothing here depends on it existing.
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

export { runDailyPrepare, runDueSchedules, runWeeklyReview, type DispatchOutcome } from "./dispatch.ts";
export { SCHEDULES, scheduleById, type ScheduleDefinition } from "./config.ts";
export { claimSlot, getScheduleState, pauseSchedule, resumeSchedule } from "./store.ts";
export { scheduleStatuses, scheduleSummaries, type ScheduleSummary } from "./status.ts";
export { mostRecentFireAt, nextFireAt, slotId, type Cadence } from "./time.ts";
