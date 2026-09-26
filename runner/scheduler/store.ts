import { z } from "zod";
import type { Clock } from "../lib/clock.ts";
import type { Workspace } from "../store/workspace.ts";

/**
 * Per-schedule state (mvp-spec §5 layout: `scheduler/state.json`, `scheduler/
 * claims/<scheduleId>--<slotId>.json`): each schedule's own pause (distinct
 * from the budget's — "Pause state survives a restart: each schedule's own
 * pause, and the budget's"), and a "last-successful-run marker per schedule"
 * (F10) plus the last attempt, whatever its outcome. Same shape/lock idiom
 * as `store/budget.ts`'s single-file store, since this is the same kind of
 * small, rarely-written, always-read-fresh record.
 */

const STATE_SEGMENTS = ["scheduler", "state.json"] as const;

const scheduleStateSchema = z
  .object({
    paused: z.boolean(),
    pausedReason: z.string().min(1).optional(),
    pausedSince: z.string().optional(),
    lastAttemptAt: z.string().optional(),
    lastSuccessfulRunAt: z.string().optional(),
    lastSlotId: z.string().optional(),
    lastSummary: z.string().optional(),
  })
  .strict();

export type ScheduleState = z.infer<typeof scheduleStateSchema>;

const stateFileSchema = z.record(z.string(), scheduleStateSchema);
export type ScheduleStateFile = z.infer<typeof stateFileSchema>;

export const DEFAULT_SCHEDULE_STATE: ScheduleState = { paused: false };

/** One in-process lock per workspace (mirrors `store/budget.ts`'s `withBudgetLock`): serializes this file's read-modify-write so a pause and a recorded attempt can never race each other into losing one. */
const locks = new WeakMap<Workspace, Promise<void>>();
export function withSchedulerLock<T>(workspace: Workspace, fn: () => Promise<T>): Promise<T> {
  const tail = locks.get(workspace) ?? Promise.resolve();
  const result = tail.then(fn, fn);
  locks.set(
    workspace,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

/** Never throws: a missing or unreadable/invalid file both read as "no schedule has any state yet" — every schedule then reads as its `DEFAULT_SCHEDULE_STATE` (not paused). */
async function readStateFile(workspace: Workspace): Promise<ScheduleStateFile> {
  let raw: unknown;
  try {
    raw = await workspace.readJson(...STATE_SEGMENTS);
  } catch {
    return {};
  }
  if (raw === undefined) return {};
  const parsed = stateFileSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

async function writeStateFile(workspace: Workspace, file: ScheduleStateFile): Promise<void> {
  await workspace.writeJson(STATE_SEGMENTS, stateFileSchema.parse(file));
}

export async function getScheduleState(workspace: Workspace, id: string): Promise<ScheduleState> {
  const file = await readStateFile(workspace);
  return file[id] ?? DEFAULT_SCHEDULE_STATE;
}

export async function getAllScheduleStates(workspace: Workspace): Promise<ScheduleStateFile> {
  return readStateFile(workspace);
}

export async function pauseSchedule(workspace: Workspace, clock: Clock, id: string, reason: string): Promise<void> {
  await withSchedulerLock(workspace, async () => {
    const file = await readStateFile(workspace);
    file[id] = { ...(file[id] ?? DEFAULT_SCHEDULE_STATE), paused: true, pausedReason: reason, pausedSince: clock.now().toISOString() };
    await writeStateFile(workspace, file);
  });
}

export async function resumeSchedule(workspace: Workspace, id: string): Promise<void> {
  await withSchedulerLock(workspace, async () => {
    const file = await readStateFile(workspace);
    const current = file[id] ?? DEFAULT_SCHEDULE_STATE;
    file[id] = { ...current, paused: false, pausedReason: undefined, pausedSince: undefined };
    await writeStateFile(workspace, file);
  });
}

export interface RecordAttemptInput {
  readonly id: string;
  readonly slotId: string;
  /** ISO instant. */
  readonly at: string;
  readonly succeeded: boolean;
  readonly summary: string;
}

/** Records one dispatch attempt's outcome (`dispatch.ts`), inside the same lock as pause/resume so the two writes can't race and drop one another. */
export async function recordAttempt(workspace: Workspace, input: RecordAttemptInput): Promise<void> {
  await withSchedulerLock(workspace, async () => {
    const file = await readStateFile(workspace);
    const current = file[input.id] ?? DEFAULT_SCHEDULE_STATE;
    file[input.id] = {
      ...current,
      lastAttemptAt: input.at,
      lastSlotId: input.slotId,
      lastSummary: input.summary,
      ...(input.succeeded ? { lastSuccessfulRunAt: input.at } : {}),
    };
    await writeStateFile(workspace, file);
  });
}

/**
 * Atomically claims one schedule's fire for `slot` (mvp-spec F10:
 * "idempotency keys make double-fires harmless" — this is the schedule-level
 * half of that; each individual model turn is separately keyed too, by
 * `dispatch.ts` or, for a preparation, by P05's own key). Backed by
 * `Workspace#createJson`'s exclusive create (`store/atomic.ts`'s `link`-based
 * `createFileExclusive`), so two attempts at the same slot — the periodic
 * fallback trigger and a startup catch-up check, say, or two ticks either
 * side of a restart — can never both win: true for whichever call reaches
 * the filesystem first, false for every other.
 */
export async function claimSlot(workspace: Workspace, clock: Clock, id: string, slot: string): Promise<boolean> {
  return workspace.createJson(["scheduler", "claims", `${id}--${slot}.json`], { claimedAt: clock.now().toISOString() });
}
