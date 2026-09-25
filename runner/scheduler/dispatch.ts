import type { RunRecord } from "@workflow-catalog/contracts";
import { runTurn, withRun } from "../server/run-harness.ts";
import type { RunnerContext } from "../server/context.ts";
import { startPreparation, waitForPreparationQueue } from "../server/routes/applications.ts";
import { ApplicationsStore } from "../store/applications.ts";
import { getBudgetState } from "../store/budget.ts";
import { hasSucceededWithIdempotencyKey } from "../store/runs.ts";
import { readPromptFile, SCHEDULES, type ScheduleDefinition } from "./config.ts";
import { claimSlot, getScheduleState, recordAttempt } from "./store.ts";
import { mostRecentFireAt, slotId } from "./time.ts";

/**
 * The dispatcher: what actually fires a schedule (packet design note). Not
 * eve's own cron — eve documents no catch-up and no signal a fire happened
 * (docs/spec/research/eve-runtime.md §4; eve-spike.md's own risk note), and
 * `withRun`/`runTurn`/the budget and run stores all live in the bridge
 * process, not inside eve's. `runDueSchedules` below is called both once, on
 * bridge start (catch-up), and on a recurring interval (the "fallback
 * trigger", `index.ts`) — the same function either way, so there is exactly
 * one trigger mechanism to reason about, not two that could race.
 *
 * Why no fire can run twice: `claimSlot` (store.ts) atomically creates a
 * one-shot marker file per (schedule, slot) before any work starts. A slot
 * is the calendar day (daily) or Monday-anchored week (weekly) a fire
 * belongs to, in the schedule's own time zone (`time.ts`); `mostRecentFireAt`
 * always resolves to the single latest slot at/before now, so a runner that
 * stayed down across several fires claims and runs exactly one catch-up
 * (the older, still-unclaimed slots are simply never looked at again).
 */

/** A fire counts as a catch-up once it's more than this late — matches CONTEXT.md's own definition ("executed late because the local runner was not available at its scheduled time") without hair-splitting a fallback tick's own few minutes of slack. */
export const CATCHUP_GRACE_MS = 5 * 60_000;

const TERMINAL_STAGES = new Set(["offer", "rejected", "withdrawn"]);

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

async function savedJobIds(ctx: RunnerContext): Promise<readonly string[]> {
  const store = new ApplicationsStore(ctx.workspace, ctx.clock);
  const { applications } = await store.list();
  return applications.filter((application) => application.stage === "saved").map((application) => application.jobId);
}

export interface DailyPrepareOutcomes {
  readonly started: number;
  readonly alreadyPrepared: number;
  readonly alreadyRunning: number;
  readonly reexported: number;
  readonly refused: number;
}

export interface DailyPrepareResult {
  readonly attempted: number;
  /** How many eligible jobs stayed Saved because the per-run item cap was reached (Acceptance: "Cap exceeded: run stops at the cap, remaining items stay Saved, reason logged"). */
  readonly cappedRemaining: number;
  readonly itemCap: number;
  readonly outcomes: DailyPrepareOutcomes;
}

/**
 * F10 "prepare newly saved jobs": every Saved-stage application, oldest
 * first, up to the budget's `itemCap` — the item cap applies here, at the
 * schedule's own batching, rather than through `withRun`'s `items` option,
 * because each job's actual model turn already goes through its own
 * `withRun` call inside `startPreparation` (P05's pipeline; "no second
 * preparation path"). Nesting a second `withRun` around the whole batch
 * would double-count every prepared job against the daily run limit.
 */
export async function runDailyPrepare(ctx: RunnerContext, options: { readonly isCatchUp: boolean }): Promise<DailyPrepareResult> {
  const budget = await getBudgetState(ctx.workspace, ctx.clock);
  const eligible = await savedJobIds(ctx);
  const capped = eligible.slice(0, budget.itemCap);
  const cappedRemaining = eligible.length - capped.length;
  const outcomes: { -readonly [K in keyof DailyPrepareOutcomes]: number } = { started: 0, alreadyPrepared: 0, alreadyRunning: 0, reexported: 0, refused: 0 };
  for (const jobId of capped) {
    const result = await startPreparation(ctx, { jobId, coverLetter: false, kind: "prepare_newly_saved_jobs", isCatchUp: options.isCatchUp });
    switch (result.outcome) {
      case "started":
        outcomes.started += 1;
        break;
      case "already_prepared":
        outcomes.alreadyPrepared += 1;
        break;
      case "already_running":
        outcomes.alreadyRunning += 1;
        break;
      case "reexported":
        outcomes.reexported += 1;
        break;
      case "refused":
        // A parked preparation (gap questions still open) refuses here too (P05's own dedup, "needs_answers"):
        // that is not a failure for this schedule (carried item) — no retry, no failure count, no backoff, it
        // is simply left for the person to answer on the Applications page.
        outcomes.refused += 1;
        break;
    }
  }
  await waitForPreparationQueue(ctx.workspace.root);
  if (cappedRemaining > 0) {
    ctx.log.info(`daily-prepare: stopped at the per-run cap (${budget.itemCap}); ${cappedRemaining} job${cappedRemaining === 1 ? "" : "s"} stay Saved.`);
  }
  return { attempted: capped.length, cappedRemaining, itemCap: budget.itemCap, outcomes };
}

/**
 * F10 "review open applications": one turn, through `withRun`/`runTurn`
 * directly (there is no existing pipeline to delegate to, unlike
 * preparation). The prompt file is data-free; the open applications' stage
 * and ids are appended as the turn's own user-turn data, the same pattern
 * P05's `buildPreparationPrompt` uses for confirmed claims and posting
 * fields.
 */
export async function runWeeklyReview(ctx: RunnerContext, options: { readonly isCatchUp: boolean; readonly idempotencyKey: string }): Promise<RunRecord> {
  const schedule = SCHEDULES.find((candidate) => candidate.kind === "review_open_applications");
  if (!schedule) throw new Error("weekly-review: no schedule definition for review_open_applications.");
  const store = new ApplicationsStore(ctx.workspace, ctx.clock);
  const { applications } = await store.list();
  const open = applications.filter((application) => !TERMINAL_STAGES.has(application.stage));
  const prompt = await readPromptFile(schedule);
  const lines = open.map((application) => `- stage: ${application.stage}; application: ${application.taskId}; job: ${application.jobId}`);
  const message = `${prompt.trim()}\n\n## Open applications (${open.length})\n${lines.length > 0 ? lines.join("\n") : "(none)"}`;
  return withRun(ctx, { kind: "review_open_applications", idempotencyKey: options.idempotencyKey, isCatchUp: options.isCatchUp, inputs: { openApplicationCount: open.length } }, async (turnCtx) => {
    const turn = await runTurn(turnCtx, { message });
    return { turns: [turn] };
  });
}

export interface DispatchOutcome {
  readonly id: string;
  readonly ran: boolean;
  readonly isCatchUp: boolean;
  /** Present when `ran` is false: why nothing happened this check. */
  readonly reason?: string;
}

async function dispatchOne(ctx: RunnerContext, schedule: ScheduleDefinition, now: Date): Promise<DispatchOutcome> {
  const state = await getScheduleState(ctx.workspace, schedule.id);
  if (state.paused) return { id: schedule.id, ran: false, isCatchUp: false, reason: state.pausedReason ?? "paused" };

  // Decisions already made: "A provider limit pauses the budget. Schedules then stop until the person resumes."
  // — this schedule's own pause (above) is independent of the budget's; both are checked, neither implies the
  // other.
  const budget = await getBudgetState(ctx.workspace, ctx.clock);
  if (budget.paused) return { id: schedule.id, ran: false, isCatchUp: false, reason: budget.pausedReason ?? "budget paused" };

  const target = mostRecentFireAt(schedule.cadence, now);
  const slot = slotId(schedule.cadence, target);
  const isCatchUp = now.getTime() - target.getTime() > CATCHUP_GRACE_MS;

  const claimed = await claimSlot(ctx.workspace, ctx.clock, schedule.id, slot);
  if (!claimed) return { id: schedule.id, ran: false, isCatchUp, reason: "already run for this slot" };

  // `now` throughout, not a fresh `ctx.clock.now()` read here: in production the two are the same instant
  // (runDueSchedules defaults `now` to ctx.clock.now() itself), but keeping one value end to end means a test
  // driving `now` explicitly sees a consistent, single "now" everywhere this dispatch records.
  const startedAt = now.toISOString();
  try {
    if (schedule.kind === "prepare_newly_saved_jobs") {
      const result = await runDailyPrepare(ctx, { isCatchUp });
      const summary = `attempted ${result.attempted} of ${result.attempted + result.cappedRemaining}: started ${result.outcomes.started}, already prepared ${result.outcomes.alreadyPrepared}, already running ${result.outcomes.alreadyRunning}, re-exported ${result.outcomes.reexported}, refused ${result.outcomes.refused}.${result.cappedRemaining > 0 ? ` Stopped at the per-run cap (${result.itemCap}); ${result.cappedRemaining} job${result.cappedRemaining === 1 ? "" : "s"} stay Saved.` : ""}`;
      // The fire itself always "succeeded" here once it completed without throwing — an individual job that
      // parked or was refused is not a failure for the schedule (carried item): no retry, no failure count, no
      // backoff, tracked in the summary above instead.
      await recordAttempt(ctx.workspace, { id: schedule.id, slotId: slot, at: startedAt, succeeded: true, summary });
    } else {
      const idempotencyKey = `${schedule.id}:${slot}`;
      let alreadyDone: boolean;
      try {
        alreadyDone = await hasSucceededWithIdempotencyKey(ctx.workspace, ctx.clock, idempotencyKey);
      } catch (caught) {
        // Fail closed (carried nit 3): a rejection means "unknown", never "not done" — this run does not start.
        await recordAttempt(ctx.workspace, { id: schedule.id, slotId: slot, at: startedAt, succeeded: false, summary: `Skipped: could not confirm this hadn't already run (${errorMessage(caught)}).` });
        return { id: schedule.id, ran: false, isCatchUp, reason: "could not check whether this already ran" };
      }
      if (alreadyDone) {
        await recordAttempt(ctx.workspace, { id: schedule.id, slotId: slot, at: startedAt, succeeded: true, summary: "Already ran for this week." });
      } else {
        const record = await runWeeklyReview(ctx, { isCatchUp, idempotencyKey });
        const succeeded = record.outcome === "success";
        const summary = succeeded ? "The weekly review ran." : `The weekly review did not finish (${record.error ?? record.outcome}).`;
        await recordAttempt(ctx.workspace, { id: schedule.id, slotId: slot, at: startedAt, succeeded, summary });
      }
    }
    return { id: schedule.id, ran: true, isCatchUp };
  } catch (caught) {
    const message = errorMessage(caught);
    ctx.log.error(`scheduler: ${schedule.id} failed (${message}).`);
    await recordAttempt(ctx.workspace, { id: schedule.id, slotId: slot, at: startedAt, succeeded: false, summary: `Failed: ${message}` }).catch(() => undefined);
    return { id: schedule.id, ran: false, isCatchUp, reason: "error" };
  }
}

/** Checks every schedule and dispatches whichever is due and unclaimed for its current slot. Called both once, immediately, on bridge start (catch-up) and on the recurring fallback-trigger tick (`index.ts`). */
export async function runDueSchedules(ctx: RunnerContext, now?: Date): Promise<readonly DispatchOutcome[]> {
  const at = now ?? ctx.clock.now();
  const outcomes: DispatchOutcome[] = [];
  for (const schedule of SCHEDULES) outcomes.push(await dispatchOne(ctx, schedule, at));
  return outcomes;
}
