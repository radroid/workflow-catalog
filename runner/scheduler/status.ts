import { scheduleStatusSchema, type ScheduleStatus } from "@workflow-catalog/contracts";
import type { RunnerContext } from "../server/context.ts";
import { getBudgetState } from "../store/budget.ts";
import { SCHEDULES } from "./config.ts";
import { getScheduleState, type ScheduleState } from "./store.ts";
import { nextFireAt } from "./time.ts";

/** `GET /status`'s `schedules` (bridge-http.ts's `scheduleStatusSchema`, already reserved for P08-B): `paused` here is the schedule's own pause only — a consumer checks `budget.paused` (the sibling field) separately for "nothing will run right now regardless." No personal data (mvp-spec §5). */
export async function scheduleStatuses(ctx: RunnerContext): Promise<readonly ScheduleStatus[]> {
  const statuses: ScheduleStatus[] = [];
  for (const schedule of SCHEDULES) {
    const state = await getScheduleState(ctx.workspace, schedule.id);
    statuses.push(
      scheduleStatusSchema.parse({
        id: schedule.id,
        kind: schedule.kind,
        paused: state.paused,
        nextRunAt: nextFireAt(schedule.cadence, ctx.clock.now()).toISOString(),
        ...(state.lastSuccessfulRunAt !== undefined ? { lastRunAt: state.lastSuccessfulRunAt } : {}),
      }),
    );
  }
  return statuses;
}

/** The richer, local-API-only shape for Settings → Schedules: everything `scheduleStatuses` reports, plus the plain-words description, the pause reason/since, the per-run cap (daily-prepare only — a weekly review has no per-run item list), and the last attempt (whatever its outcome) alongside the last success. */
export interface ScheduleSummary {
  readonly id: string;
  readonly kind: string;
  readonly description: string;
  readonly paused: boolean;
  readonly pausedReason?: string;
  readonly pausedSince?: string;
  readonly itemCap?: number;
  readonly nextRunAt: string;
  readonly lastRunAt?: string;
  readonly lastAttemptAt?: string;
  readonly lastSummary?: string;
}

function toSummary(state: ScheduleState, id: string, kind: string, description: string, nextRunAt: string, itemCap: number | undefined): ScheduleSummary {
  return {
    id,
    kind,
    description,
    paused: state.paused,
    ...(state.pausedReason !== undefined ? { pausedReason: state.pausedReason } : {}),
    ...(state.pausedSince !== undefined ? { pausedSince: state.pausedSince } : {}),
    ...(itemCap !== undefined ? { itemCap } : {}),
    nextRunAt,
    ...(state.lastSuccessfulRunAt !== undefined ? { lastRunAt: state.lastSuccessfulRunAt } : {}),
    ...(state.lastAttemptAt !== undefined ? { lastAttemptAt: state.lastAttemptAt } : {}),
    ...(state.lastSummary !== undefined ? { lastSummary: state.lastSummary } : {}),
  };
}

export async function scheduleSummaries(ctx: RunnerContext): Promise<readonly ScheduleSummary[]> {
  const budget = await getBudgetState(ctx.workspace, ctx.clock);
  const summaries: ScheduleSummary[] = [];
  for (const schedule of SCHEDULES) {
    const state = await getScheduleState(ctx.workspace, schedule.id);
    const itemCap = schedule.kind === "prepare_newly_saved_jobs" ? budget.itemCap : undefined;
    summaries.push(toSummary(state, schedule.id, schedule.kind, schedule.description, nextFireAt(schedule.cadence, ctx.clock.now()).toISOString(), itemCap));
  }
  return summaries;
}
