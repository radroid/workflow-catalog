import path from "node:path";
import { readFile } from "node:fs/promises";
import type { ScheduleKind } from "@workflow-catalog/contracts";
import { RUNNER_DIR } from "../lib/paths.ts";
import type { Cadence } from "./time.ts";

/** `runner/agent/schedules/` (F10/§8's layout convention) — this schedule's own prompt file. */
export const SCHEDULES_PROMPT_DIR = path.join(RUNNER_DIR, "agent", "schedules");

export interface ScheduleDefinition {
  readonly id: string;
  readonly kind: ScheduleKind;
  readonly cadence: Cadence;
  /** Plain words for Settings, e.g. "Daily at 09:00 UTC". Fixed here, not read from the prompt file, so it never depends on a filesystem read succeeding. */
  readonly description: string;
  /** File name under `SCHEDULES_PROMPT_DIR`. `weekly-review`'s is read and sent as the turn's message (readReviewPrompt, dispatch.ts); `daily-prepare`'s documents the schedule for a person reading the repo and is never sent to a model (P05's own prompt already covers each preparation turn). */
  readonly promptFile: string;
}

const DEFAULT_TIME_ZONE = "UTC";

/**
 * F10: "Daily 'prepare newly saved jobs' and weekly 'review open
 * applications'." Fixed at these two for the MVP (no schedule CRUD); the
 * design note (packet report) explains the UTC default and why nothing here
 * depends on eve's own (undocumented, for a self-hosted runner) cron time
 * zone.
 */
export const SCHEDULES: readonly ScheduleDefinition[] = [
  {
    id: "daily-prepare",
    kind: "prepare_newly_saved_jobs",
    cadence: { kind: "daily", hour: 9, minute: 0, timeZone: DEFAULT_TIME_ZONE },
    description: "Daily at 09:00 UTC — prepare newly saved jobs, up to the run budget's per-run item cap.",
    promptFile: "daily-prepare.md",
  },
  {
    id: "weekly-review",
    kind: "review_open_applications",
    cadence: { kind: "weekly", weekday: 1, hour: 9, minute: 0, timeZone: DEFAULT_TIME_ZONE }, // Monday
    description: "Weekly, Monday at 09:00 UTC — review open applications.",
    promptFile: "weekly-review.md",
  },
];

export function scheduleById(id: string): ScheduleDefinition | undefined {
  return SCHEDULES.find((schedule) => schedule.id === id);
}

/** Reads a schedule's prompt file as plain text (currently only `weekly-review` sends its contents to a turn; see `dispatch.ts`). */
export async function readPromptFile(schedule: ScheduleDefinition): Promise<string> {
  return readFile(path.join(SCHEDULES_PROMPT_DIR, schedule.promptFile), "utf8");
}
