import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import type { Client, ClientSession, MessageResponse, MessageStreamEvent } from "eve/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ManualClock } from "../lib/clock.ts";
import { createRunnerContext, silentLogger } from "../server/context.ts";
import type { EveGateway } from "../server/eve-gateway.ts";
import { PROVIDER_LIMIT_REASON } from "../server/run-harness.ts";
import type { PrepareRequest, PrepareStart } from "../server/routes/applications.ts";
import { runDailyPrepare, runDueSchedules, runWeeklyReview } from "../scheduler/dispatch.ts";
import { claimSlot, getScheduleState, pauseSchedule } from "../scheduler/store.ts";
import { ApplicationsStore } from "../store/applications.ts";
import { getBudgetState, pauseBudget, setBudgetLimits } from "../store/budget.ts";
import { hasSucceededWithIdempotencyKey, localDateString, writePausedRun } from "../store/runs.ts";
import { newWorkspace } from "./helpers.ts";

/**
 * Daily-prepare delegates every job's actual preparation to P05's own
 * `startPreparation`/`waitForPreparationQueue` (`server/routes/applications.ts`,
 * never edited here — see dispatch.ts's header). Mocking that boundary here
 * is deliberate: P05's own suite already proves a real preparation's
 * document-creation and idempotency; these tests are scoped to *this*
 * packet's dispatch logic (the per-run cap, the outcome tally, "no second
 * preparation path", catch-up/claim semantics). `vi.hoisted` is required
 * because `vi.mock`'s factory (also hoisted, above every import) closes over
 * these two spies.
 */
const { startPreparation, waitForPreparationQueue } = vi.hoisted(() => ({
  startPreparation: vi.fn<(ctx: unknown, request: unknown) => Promise<unknown>>(),
  waitForPreparationQueue: vi.fn(async () => undefined),
}));
vi.mock("../server/routes/applications.ts", () => ({ startPreparation, waitForPreparationQueue }));

const typedStartPreparation = startPreparation as unknown as ReturnType<typeof vi.fn<(ctx: unknown, request: PrepareRequest) => Promise<PrepareStart>>>;

const META = { at: "2026-09-22T09:00:00.000Z", id: "evt-0" };

function started(modelId: string): MessageStreamEvent {
  return { type: "step.started", data: { modelId, sequence: 0, stepIndex: 0, turnId: "t1" }, meta: META };
}
function completed(usage: { inputTokens?: number; outputTokens?: number }): MessageStreamEvent {
  return { type: "step.completed", data: { finishReason: "stop", sequence: 1, stepIndex: 0, turnId: "t1", usage }, meta: META };
}
function turnCompleted(): MessageStreamEvent {
  return { type: "turn.completed", data: { sequence: 2, turnId: "t1" }, meta: META };
}
function sessionCompleted(): MessageStreamEvent {
  return { type: "session.completed", meta: META } as MessageStreamEvent;
}
function turnFailed(code: string, message: string, details?: Record<string, string>): MessageStreamEvent {
  return { type: "turn.failed", data: { code, message, ...(details ? { details } : {}), sequence: 9, turnId: "t1" }, meta: META };
}

interface FakeCall {
  readonly message: string;
}

/** A minimal fake EveGateway — the same shape and streaming convention as run-harness.test.ts's own `fakeEve`, duplicated locally rather than shared across files (that one also tracks a cancel count, not needed here). */
function fakeEve(script: (call: FakeCall) => Promise<readonly MessageStreamEvent[]>): { eve: EveGateway; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const create = async (input: { message: string; signal?: AbortSignal }) => {
    calls.push({ message: input.message });
    const events = await script({ message: input.message });
    const response = {
      [Symbol.asyncIterator]: () =>
        (async function* () {
          for (const event of events) yield event;
        })(),
    } as unknown as MessageResponse;
    const session = { cancel: async () => ({ status: "accepted" as const, sessionId: "s1" }) } as unknown as ClientSession;
    return { response, session };
  };
  const eve: EveGateway = {
    url: "http://127.0.0.1:3210",
    client: { sessions: { create } } as unknown as Client,
    health: async () => ({ ok: true }),
    modelId: async () => undefined,
    checkModel: async () => ({ ok: true }),
  };
  return { eve, calls };
}

async function contextWith(eve?: EveGateway) {
  const clock = new ManualClock();
  const workspace = await newWorkspace(clock);
  const ctx = createRunnerContext({ workspace, clock, packageVersion: "0.1.0", eve, log: silentLogger });
  return { ctx, workspace, clock };
}

async function savedApplication(ctx: Awaited<ReturnType<typeof contextWith>>["ctx"]): Promise<string> {
  const store = new ApplicationsStore(ctx.workspace, ctx.clock);
  const jobId = randomUUID();
  await store.ensureForJob(jobId);
  return jobId;
}

beforeEach(() => {
  typedStartPreparation.mockReset();
  waitForPreparationQueue.mockClear();
  typedStartPreparation.mockImplementation(async () => ({ outcome: "started", taskId: randomUUID() }));
});

const DAILY_ID = "daily-prepare";
const WEEKLY_ID = "weekly-review";

describe("scheduler/dispatch.ts: runDailyPrepare", () => {
  it("Acceptance: cap exceeded — stops at the per-run cap, remaining jobs stay Saved, and it's logged", async () => {
    const { ctx } = await contextWith();
    await setBudgetLimits(ctx.workspace, { dailyRunLimit: 10, itemCap: 2 });
    await savedApplication(ctx);
    await savedApplication(ctx);
    await savedApplication(ctx);

    const result = await runDailyPrepare(ctx, { isCatchUp: false });
    expect(result.attempted).toBe(2);
    expect(result.cappedRemaining).toBe(1);
    expect(typedStartPreparation).toHaveBeenCalledTimes(2);
  });

  it("delegates every job's own idempotency to startPreparation — no second preparation path", async () => {
    const { ctx } = await contextWith();
    const jobId = await savedApplication(ctx);
    typedStartPreparation.mockResolvedValueOnce({ outcome: "started", taskId: "t1" });
    await runDailyPrepare(ctx, { isCatchUp: false });
    expect(typedStartPreparation).toHaveBeenCalledWith(ctx, { jobId, coverLetter: false, kind: "prepare_newly_saved_jobs", isCatchUp: false });

    // Acceptance: two consecutive runs over the same (unchanged) inputs create zero *new* documents — the
    // schedule always re-asks P05, and trusts its answer; here that answer is "already prepared".
    typedStartPreparation.mockResolvedValueOnce({ outcome: "already_prepared", taskId: "t1", version: 1 });
    const second = await runDailyPrepare(ctx, { isCatchUp: false });
    expect(second.outcomes.alreadyPrepared).toBe(1);
    expect(second.outcomes.started).toBe(0);
  });

  it("carried item: a parked preparation (refused, gap questions open) is not a failure — no retry within the run, no throw", async () => {
    const { ctx } = await contextWith();
    await savedApplication(ctx);
    await savedApplication(ctx);
    typedStartPreparation.mockImplementation(async () => ({ outcome: "refused", status: 409, code: "needs_answers", message: "Answer the open questions first." }));
    const result = await runDailyPrepare(ctx, { isCatchUp: false });
    expect(result.outcomes.refused).toBe(2);
    expect(typedStartPreparation).toHaveBeenCalledTimes(2); // exactly once per job, not retried
  });

  it("waits for the preparation queue before returning (so the caller's own recordAttempt reflects settled work)", async () => {
    const { ctx } = await contextWith();
    await savedApplication(ctx);
    await runDailyPrepare(ctx, { isCatchUp: false });
    expect(waitForPreparationQueue).toHaveBeenCalledWith(ctx.workspace.root);
  });
});

describe("scheduler/dispatch.ts: runWeeklyReview", () => {
  it("runs one turn through withRun/runTurn, records isCatchUp, and includes only stage + ids (no job content) in the message", async () => {
    let sentMessage = "";
    const { eve } = fakeEve(async (call) => {
      sentMessage = call.message;
      return [started("gpt-5.6-luna"), completed({ inputTokens: 5, outputTokens: 2 }), turnCompleted(), sessionCompleted()];
    });
    const { ctx } = await contextWith(eve);
    const store = new ApplicationsStore(ctx.workspace, ctx.clock);
    await store.ensureForJob(randomUUID());
    const record = await runWeeklyReview(ctx, { isCatchUp: true, idempotencyKey: "weekly-review:week-of-2026-09-21" });
    expect(record.outcome).toBe("success");
    expect(record.isCatchUp).toBe(true);
    expect(record.kind).toBe("review_open_applications");
    expect(sentMessage).toContain("Open applications (1)");
    expect(sentMessage).not.toMatch(/Northwind|Fernwood|Harbor|Ledgerkit/); // no fictional company/job content, only stage + ids
  });

  it("Acceptance: simulated 429 storm — pauses the budget, records the reason, and never retries (assert call count)", async () => {
    const { eve, calls } = fakeEve(async () => [turnFailed("MODEL_CALL_FAILED", "rate limited", { semanticErrorId: "gateway-rate-limited" })]);
    const { ctx, workspace, clock } = await contextWith(eve);
    const record = await runWeeklyReview(ctx, { isCatchUp: false, idempotencyKey: "weekly-review:week-of-2026-09-21" });
    expect(record.outcome).toBe("failure");
    expect(record.error).toContain(PROVIDER_LIMIT_REASON);
    expect(calls.length).toBe(1);

    const state = await getBudgetState(workspace, clock);
    expect(state.paused).toBe(true);
    expect(state.pausedReason).toBe(PROVIDER_LIMIT_REASON);
  });

  const canDenyAccess = process.platform !== "win32" && process.getuid?.() !== 0;

  it.skipIf(!canDenyAccess)("carried nit 3: a hasSucceededWithIdempotencyKey rejection is 'unknown', not 'not done' — dispatchOne must not run", async () => {
    const { eve, calls } = fakeEve(async () => [started("m"), completed({ inputTokens: 1, outputTokens: 1 }), turnCompleted(), sessionCompleted()]);
    const { ctx, clock } = await contextWith(eve);
    await expect(hasSucceededWithIdempotencyKey(ctx.workspace, ctx.clock, "unused-key")).resolves.toBe(false); // sanity: normally resolves

    // A date directory that exists but can't be listed makes the lookup reject (store/runs.ts's documented
    // behaviour, carried nit 3). Seed and deny an *older* day within the idempotency-check's 14-day window —
    // never today's directory, which store/budget.ts's own "run log unreadable" synthetic pause also watches;
    // denying today's would pause the budget first and mask the exact case this test targets.
    const today = localDateString(clock.now());
    clock.advance(-24 * 60 * 60_000);
    const yesterday = localDateString(clock.now());
    expect(yesterday).not.toBe(today);
    await writePausedRun(ctx.workspace, ctx.clock, { runId: randomUUID(), kind: "manual", isCatchUp: false, idempotencyKey: "seed", inputs: {}, reason: "r" });
    clock.advance(24 * 60 * 60_000); // back to "now" for the dispatch itself
    const dir = ctx.workspace.resolve("runs", yesterday);
    await chmod(dir, 0o000);
    try {
      await runDueSchedules(ctx); // uses ctx.clock.now(): the default ManualClock start, well past both schedules' first fire
      expect(calls.length).toBe(0); // the weekly-review turn never ran — fail closed
      const state = await getScheduleState(ctx.workspace, WEEKLY_ID);
      expect(state.lastSummary).toContain("could not confirm");
    } finally {
      await chmod(dir, 0o700);
    }
  });
});

describe("scheduler/dispatch.ts: runDueSchedules — catch-up and no-double-fire", () => {
  it("Acceptance: the runner missing several scheduled fires still runs exactly one catch-up", async () => {
    const { ctx } = await contextWith();
    // Well past several missed daily fires (09:00 UTC).
    const now = new Date("2026-09-25T12:00:00.000Z");
    await runDueSchedules(ctx, now);
    expect(typedStartPreparation).not.toHaveBeenCalled(); // no eligible jobs, but the fire itself is still claimed/attempted once
    const state = await getScheduleState(ctx.workspace, DAILY_ID);
    expect(state.lastSlotId).toBe("2026-09-25");
    expect(state.lastAttemptAt).toBe(now.toISOString());

    // A second check moments later (the fallback trigger's next tick) must not fire it again.
    typedStartPreparation.mockClear();
    await runDueSchedules(ctx, new Date(now.getTime() + 60_000));
    const stateAfter = await getScheduleState(ctx.workspace, DAILY_ID);
    expect(stateAfter.lastAttemptAt).toBe(now.toISOString()); // unchanged: no second attempt was recorded
  });

  it("marks a late fire isCatchUp and an on-time one not", async () => {
    const { ctx } = await contextWith();
    const outcomes = await runDueSchedules(ctx, new Date("2026-09-25T09:00:30.000Z")); // 30s after the fire: on time
    const dailyOutcome = outcomes.find((o) => o.id === DAILY_ID)!;
    expect(dailyOutcome.isCatchUp).toBe(false);

    const { ctx: lateCtx } = await contextWith();
    const lateOutcomes = await runDueSchedules(lateCtx, new Date("2026-09-25T09:20:00.000Z")); // 20 minutes late
    const lateDailyOutcome = lateOutcomes.find((o) => o.id === DAILY_ID)!;
    expect(lateDailyOutcome.isCatchUp).toBe(true);
  });

  it("mutation-proof shape: claiming the same slot twice runs it only once (the atomic claim, not luck)", async () => {
    const { ctx } = await contextWith();
    const now = new Date("2026-09-25T09:00:00.000Z");
    const first = await claimSlot(ctx.workspace, ctx.clock, DAILY_ID, "2026-09-25");
    expect(first).toBe(true);
    await runDueSchedules(ctx, now); // dispatchOne's own claim for this slot must now fail; the fire records nothing new
    const state = await getScheduleState(ctx.workspace, DAILY_ID);
    expect(state.lastAttemptAt).toBeUndefined(); // never reached recordAttempt: claimSlot said "already run"
  });

  it("a schedule's own pause stops it independent of the budget", async () => {
    const { ctx } = await contextWith();
    await pauseSchedule(ctx.workspace, ctx.clock, DAILY_ID, "paused from Settings");
    const outcomes = await runDueSchedules(ctx, new Date("2026-09-25T09:00:00.000Z"));
    const dailyOutcome = outcomes.find((o) => o.id === DAILY_ID)!;
    expect(dailyOutcome.ran).toBe(false);
    expect(dailyOutcome.reason).toBe("paused from Settings");
    expect(typedStartPreparation).not.toHaveBeenCalled();
  });

  it("a paused budget stops every schedule, not just the run itself", async () => {
    const { ctx, workspace, clock } = await contextWith();
    await pauseBudget(workspace, clock, PROVIDER_LIMIT_REASON);
    const outcomes = await runDueSchedules(ctx, new Date("2026-09-25T09:00:00.000Z"));
    for (const outcome of outcomes) expect(outcome.ran).toBe(false);
    expect(typedStartPreparation).not.toHaveBeenCalled();
  });
});
