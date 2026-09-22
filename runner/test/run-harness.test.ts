import { writeFile } from "node:fs/promises";
import type { Client, ClientSession, MessageResponse, MessageStreamEvent } from "eve/client";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../lib/clock.ts";
import { createRunnerContext } from "../server/context.ts";
import type { EveGateway } from "../server/eve-gateway.ts";
import { EMPTY_ERROR_FALLBACK, PROVIDER_LIMIT_REASON, runTurn, withRun, type RunBodyResult, type TurnResult } from "../server/run-harness.ts";
import { getBudgetState, pauseBudget, resumeBudget, setBudgetLimits } from "../store/budget.ts";
import { getRun } from "../store/runs.ts";
import { newWorkspace } from "./helpers.ts";

const META = { at: "2026-09-22T09:00:00.000Z", id: "evt-0" };

function started(modelId: string, stepIndex = 0): MessageStreamEvent {
  return { type: "step.started", data: { modelId, sequence: stepIndex * 2, stepIndex, turnId: "t1" }, meta: META };
}

function completed(usage: { inputTokens?: number; outputTokens?: number }, stepIndex = 0): MessageStreamEvent {
  return { type: "step.completed", data: { finishReason: "stop", sequence: stepIndex * 2 + 1, stepIndex, turnId: "t1", usage }, meta: META };
}

function turnFailed(code: string, message: string, details?: Record<string, string | number>): MessageStreamEvent {
  return { type: "turn.failed", data: { code, message, ...(details ? { details } : {}), sequence: 9, turnId: "t1" }, meta: META };
}

/** A terminal boundary event (`isCurrentTurnBoundaryEvent`): without one, `runTurn` never calls a turn "ok" (G1). */
function sessionCompleted(): MessageStreamEvent {
  return { type: "session.completed", meta: META } as MessageStreamEvent;
}

/** The other boundary that matters here: a parked turn (G1's "parked" detection is keyed off this event's type). */
function sessionWaiting(): MessageStreamEvent {
  return { type: "session.waiting", data: { continuationToken: "s1", wait: "next-user-message" }, meta: META };
}

interface FakeCall {
  readonly message: string;
}

/**
 * A fake EveGateway whose client.sessions.create is scripted per call, event
 * by event — matching how the real eve client streams (G1: `runTurn` no
 * longer trusts a single aggregated `result()`). `session.cancel()` (not
 * `response.cancel()`, which round-1's `runTurn` no longer calls) is counted
 * so "parked"/"timeout" cancellation can be asserted.
 */
function fakeEve(script: (call: FakeCall, signal: AbortSignal) => Promise<readonly MessageStreamEvent[]> | "hang"): { eve: EveGateway; calls: FakeCall[]; cancelCount: () => number } {
  const calls: FakeCall[] = [];
  let cancelCount = 0;
  const create = async (input: { message: string; signal?: AbortSignal }) => {
    calls.push({ message: input.message });
    const signal = input.signal ?? new AbortController().signal;
    const outcome = script({ message: input.message }, signal);
    if (outcome === "hang") {
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    const events = await outcome;
    const response = {
      [Symbol.asyncIterator]: () =>
        (async function* () {
          for (const event of events) yield event;
        })(),
    } as unknown as MessageResponse;
    const session = {
      cancel: async () => {
        cancelCount += 1;
        return { status: "accepted" as const, sessionId: "s1" };
      },
    } as unknown as ClientSession;
    return { response, session };
  };
  const eve: EveGateway = {
    url: "http://127.0.0.1:3210",
    client: { sessions: { create } } as unknown as Client,
    health: async () => ({ ok: true }),
    modelId: async () => undefined,
    checkModel: async () => ({ ok: true }),
  };
  return { eve, calls, cancelCount: () => cancelCount };
}

async function contextWith(eve?: EveGateway, clock = new ManualClock()) {
  const workspace = await newWorkspace(clock);
  const ctx = createRunnerContext({ workspace, clock, packageVersion: "0.1.0", eve });
  return { ctx, workspace, clock };
}

describe("run-harness.ts: runTurn", () => {
  it("an ok turn sums tokens and takes the model id from the last step.started", async () => {
    const { eve } = fakeEve(async () => [started("gpt-5.6-luna"), completed({ inputTokens: 100, outputTokens: 20 }), sessionCompleted()]);
    const { ctx } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result).toMatchObject({ status: "ok", tokens: { input: 100, output: 20 }, model: "gpt-5.6-luna" });
  });

  it("sums usage across more than one step", async () => {
    const { eve } = fakeEve(async () => [started("m1", 0), completed({ inputTokens: 10, outputTokens: 2 }, 0), started("m2", 1), completed({ inputTokens: 5, outputTokens: 1 }, 1), sessionCompleted()]);
    const { ctx } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.tokens).toEqual({ input: 15, output: 3 });
    expect(result.model).toBe("m2");
  });

  it("no boundary event at all (never aborted, no failure): never called 'ok' (mutation target)", async () => {
    const { eve } = fakeEve(async () => [started("m1"), completed({ inputTokens: 1, outputTokens: 1 })]);
    const { ctx } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.status).toBe("failed");
    expect(result.tokens).toEqual({ input: 1, output: 1 }); // partial usage still kept
  });

  it("an ordinary failure fails the turn without pausing the budget (negative case)", async () => {
    const { eve } = fakeEve(async () => [turnFailed("MODEL_CALL_FAILED", "The model declined to answer.")]);
    const { ctx, workspace, clock } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.status).toBe("failed");
    expect(result.providerLimit).toBeFalsy();
    expect((await getBudgetState(workspace, clock)).paused).toBe(false);
  });

  it("primary signal: details.semanticErrorId gateway-rate-limited pauses the budget with reason 'provider limit'", async () => {
    const { eve } = fakeEve(async () => [turnFailed("MODEL_CALL_FAILED", "AI Gateway rate-limited the request.", { semanticErrorId: "gateway-rate-limited" })]);
    const { ctx, workspace, clock } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.status).toBe("failed");
    expect(result.providerLimit).toBe(true);
    expect(result.detail).toContain(PROVIDER_LIMIT_REASON);
    const state = await getBudgetState(workspace, clock);
    expect(state.paused).toBe(true);
    expect(state.pausedReason).toBe(PROVIDER_LIMIT_REASON);
  });

  it("primary signal: details.semanticErrorId gateway-free-tier-rate-limited also pauses", async () => {
    const { eve } = fakeEve(async () => [turnFailed("MODEL_CALL_FAILED", "Free tier requests on this model are rate-limited.", { semanticErrorId: "gateway-free-tier-rate-limited" })]);
    const { ctx, workspace, clock } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.providerLimit).toBe(true);
    expect((await getBudgetState(workspace, clock)).paused).toBe(true);
  });

  it("a semanticErrorId for an unrelated gateway rule does not count as a provider limit", async () => {
    const { eve } = fakeEve(async () => [turnFailed("MODEL_CALL_FAILED", "The requested model is not available.", { semanticErrorId: "model-not-found" })]);
    const { ctx, workspace, clock } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.providerLimit).toBeFalsy();
    expect((await getBudgetState(workspace, clock)).paused).toBe(false);
  });

  it("fallback signal (no semanticErrorId): a bare 429 in the message pauses the budget", async () => {
    const { eve } = fakeEve(async () => [turnFailed("UPSTREAM_ERROR", "HTTP 429 Too Many Requests from the provider.")]);
    const { ctx, workspace, clock } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.providerLimit).toBe(true);
    expect((await getBudgetState(workspace, clock)).paused).toBe(true);
  });

  it("fallback signal (no semanticErrorId): 'rate limit' wording in the code pauses the budget", async () => {
    const { eve } = fakeEve(async () => [turnFailed("rate_limited", "Too many requests right now.")]);
    const { ctx, workspace, clock } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.providerLimit).toBe(true);
    expect((await getBudgetState(workspace, clock)).paused).toBe(true);
  });

  it("negative case: no semanticErrorId and no 429/rate-limit wording never pauses", async () => {
    const { eve } = fakeEve(async () => [turnFailed("VALIDATION_ERROR", "Invalid request: missing field 'foo'.")]);
    const { ctx, workspace, clock } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.providerLimit).toBeFalsy();
    expect(result.status).toBe("failed");
    expect((await getBudgetState(workspace, clock)).paused).toBe(false);
  });

  it("G5: details.statusCode 429 with no semanticErrorId pauses the budget", async () => {
    const { eve } = fakeEve(async () => [turnFailed("UPSTREAM_ERROR", "Too many requests.", { statusCode: 429 })]);
    const { ctx, workspace, clock } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.providerLimit).toBe(true);
    expect((await getBudgetState(workspace, clock)).paused).toBe(true);
  });

  it("G5: details.upstreamStatusCode 429 with no semanticErrorId pauses the budget", async () => {
    const { eve } = fakeEve(async () => [turnFailed("UPSTREAM_ERROR", "Too many requests.", { upstreamStatusCode: 429 })]);
    const { ctx, workspace, clock } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.providerLimit).toBe(true);
    expect((await getBudgetState(workspace, clock)).paused).toBe(true);
  });

  it("G5 precedence: an unrelated semanticErrorId plus a 429 statusCode and rate-limit wording is NOT a provider limit", async () => {
    const { eve } = fakeEve(async () => [turnFailed("MODEL_CALL_FAILED", "429 rate limited (but really just not-found)", { semanticErrorId: "model-not-found", statusCode: 429 })]);
    const { ctx, workspace, clock } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.providerLimit).toBeFalsy();
    expect((await getBudgetState(workspace, clock)).paused).toBe(false);
  });

  it("a turn with a session.waiting boundary parks and cancels through session.cancel()", async () => {
    const { eve, cancelCount } = fakeEve(async () => [started("m1"), sessionWaiting()]);
    const { ctx } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.status).toBe("parked");
    expect(cancelCount()).toBe(1);
  });

  it("create() itself hangs until the deadline: the turn times out", async () => {
    const { eve } = fakeEve(() => "hang");
    const { ctx } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go", timeoutMs: 20 });
    expect(result.status).toBe("timeout");
    expect(result.detail).toContain("No answer within");
  });

  it("without eve running, a turn fails immediately", async () => {
    const { ctx } = await contextWith(undefined);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("eve is not running");
  });
});

describe("run-harness.ts: withRun — refusal", () => {
  it("refuses while paused, writes a one-shot paused record, and never calls body", async () => {
    const { ctx, workspace, clock } = await contextWith(undefined);
    await pauseBudget(workspace, clock, PROVIDER_LIMIT_REASON);
    let calls = 0;
    const record = await withRun(ctx, { kind: "manual", idempotencyKey: "k1", isCatchUp: false }, async () => {
      calls += 1;
      return { turns: [] };
    });
    expect(calls).toBe(0);
    expect(record.outcome).toBe("paused");
    expect(record.error).toBe(PROVIDER_LIMIT_REASON);
    const onDisk = await getRun(workspace, record.runId);
    expect(onDisk?.outcome).toBe("paused");
  });

  it("refuses at the daily limit, then allows a run again on the next local day", async () => {
    const { ctx, workspace, clock } = await contextWith(undefined);
    await setBudgetLimits(workspace, { dailyRunLimit: 1, itemCap: 5 });
    let calls = 0;
    const body = async (): Promise<RunBodyResult> => {
      calls += 1;
      return { turns: [{ status: "ok", tokens: { input: 1, output: 1 } }] };
    };
    const first = await withRun(ctx, { kind: "manual", idempotencyKey: "a", isCatchUp: false }, body);
    expect(first.outcome).toBe("success");
    expect(calls).toBe(1);

    const second = await withRun(ctx, { kind: "manual", idempotencyKey: "b", isCatchUp: false }, body);
    expect(second.outcome).toBe("paused");
    expect(second.error).toBe("daily run limit reached (1)");
    expect(calls).toBe(1); // body was not called again

    clock.advance(24 * 60 * 60_000);
    const third = await withRun(ctx, { kind: "manual", idempotencyKey: "c", isCatchUp: false }, body);
    expect(third.outcome).toBe("success");
    expect(calls).toBe(2);
  });

  it("a corrupt runs/budget.json refuses withRun with a paused record naming the file, body never called (budget.test.ts proves the store layer)", async () => {
    const { ctx, workspace } = await contextWith(undefined);
    await writeFile(workspace.resolve("runs", "budget.json"), "{ corrupt", "utf8");
    let called = 0;
    const record = await withRun(ctx, { kind: "manual", idempotencyKey: "corrupt-e2e", isCatchUp: false }, async () => {
      called += 1;
      return { turns: [] };
    });
    expect(record.outcome).toBe("paused");
    expect(record.error).toContain("runs/budget.json");
    expect(called).toBe(0);
  });
});

describe("run-harness.ts: withRun — item cap", () => {
  it("caps items at itemCap and records processed/remaining ids in inputs", async () => {
    const { ctx, workspace } = await contextWith(undefined);
    await setBudgetLimits(workspace, { dailyRunLimit: 10, itemCap: 5 });
    let seen: readonly string[] = [];
    const items = ["a", "b", "c", "d", "e", "f", "g"];
    const record = await withRun(ctx, { kind: "prepare_newly_saved_jobs", idempotencyKey: "cap", isCatchUp: false, items }, async (_c, processed) => {
      seen = processed;
      return { turns: [{ status: "ok", tokens: { input: 0, output: 0 } }] };
    });
    expect(seen).toEqual(["a", "b", "c", "d", "e"]);
    expect(record.inputs).toMatchObject({ itemCap: 5, processedItemIds: ["a", "b", "c", "d", "e"], remainingItemIds: ["f", "g"] });
  });
});

describe("run-harness.ts: withRun — crash safety and outcome (decision 3, hardened by G2)", () => {
  it("a body that throws resolves with outcome failure and a truncated message, never rejects (mutation target: drop the finally)", async () => {
    const { ctx, workspace } = await contextWith(undefined);
    const record = await withRun(ctx, { kind: "manual", idempotencyKey: "throws", isCatchUp: false }, async () => {
      throw new Error("boom: the body blew up");
    });
    expect(record.outcome).toBe("failure");
    expect(record.error).toContain("boom: the body blew up");
    const onDisk = await getRun(workspace, record.runId);
    expect(onDisk?.outcome).toBe("failure");
    expect(onDisk?.error).toContain("boom: the body blew up");
    // Specifically not the startRun placeholder text, which is what a version
    // that skips finalizing on the error path would leave behind.
    expect(onDisk?.error).not.toContain("interrupted");
  });

  it("truncates a very long thrown message", async () => {
    const { ctx } = await contextWith(undefined);
    const long = "x".repeat(1000);
    const record = await withRun(ctx, { kind: "manual", idempotencyKey: "long", isCatchUp: false }, async () => {
      throw new Error(long);
    });
    expect(record.error!.length).toBeLessThan(600);
  });

  it("G2: a body that throws an empty Error() resolves with the fixed fallback sentence, never rejects", async () => {
    const { ctx, workspace } = await contextWith(undefined);
    const record = await withRun(ctx, { kind: "manual", idempotencyKey: "empty-msg", isCatchUp: false }, async () => {
      throw new Error();
    });
    expect(record.outcome).toBe("failure");
    expect(record.error).toBe(EMPTY_ERROR_FALLBACK);
    const onDisk = await getRun(workspace, record.runId);
    expect(onDisk?.error).toBe(EMPTY_ERROR_FALLBACK);
  });

  it("G2: a failed turn whose detail is an empty string resolves with the fixed fallback sentence, never rejects", async () => {
    const { ctx } = await contextWith(undefined);
    const record = await withRun(ctx, { kind: "manual", idempotencyKey: "empty-detail", isCatchUp: false }, async () => ({
      turns: [{ status: "failed" as const, tokens: { input: 1, output: 1 }, detail: "" }],
    }));
    expect(record.outcome).toBe("failure");
    expect(record.error).toBe(EMPTY_ERROR_FALLBACK);
  });

  it("a mix of ok and failed turns: tokens sum across all, outcome fails on the first non-ok turn", async () => {
    const { ctx } = await contextWith(undefined);
    const turns: TurnResult[] = [
      { status: "ok", tokens: { input: 10, output: 2 }, model: "m1" },
      { status: "failed", tokens: { input: 5, output: 1 }, model: "m2", detail: "turn 2 failed" },
    ];
    const record = await withRun(ctx, { kind: "manual", idempotencyKey: "mix", isCatchUp: false }, async () => ({ turns }));
    expect(record.outcome).toBe("failure");
    expect(record.error).toBe("turn 2 failed");
    expect(record.tokens).toEqual({ input: 15, output: 3 });
    expect(record.model).toBe("m2");
  });

  it("all-ok turns succeed with no error field", async () => {
    const { ctx } = await contextWith(undefined);
    const record = await withRun(ctx, { kind: "manual", idempotencyKey: "ok", isCatchUp: false }, async () => ({
      turns: [{ status: "ok", tokens: { input: 3, output: 1 }, model: "m" }],
    }));
    expect(record.outcome).toBe("success");
    expect(record.error).toBeUndefined();
  });
});

describe("run-harness.ts: withRun — G4 concurrency (budget lock held across the check and startRun)", () => {
  it("two concurrent runs at one below the limit let exactly one run", async () => {
    const { ctx, workspace, clock } = await contextWith(undefined);
    await setBudgetLimits(workspace, { dailyRunLimit: 3, itemCap: 5 });
    // Seed 2 of the 3 slots already used today, so exactly one more may proceed.
    await withRun(ctx, { kind: "manual", idempotencyKey: "seed-1", isCatchUp: false }, async () => ({ turns: [{ status: "ok", tokens: { input: 0, output: 0 } }] }));
    await withRun(ctx, { kind: "manual", idempotencyKey: "seed-2", isCatchUp: false }, async () => ({ turns: [{ status: "ok", tokens: { input: 0, output: 0 } }] }));
    expect((await getBudgetState(workspace, clock)).runsUsedToday).toBe(2);

    const body = async (): Promise<RunBodyResult> => ({ turns: [{ status: "ok" as const, tokens: { input: 0, output: 0 } }] });
    const [a, b] = await Promise.all([
      withRun(ctx, { kind: "manual", idempotencyKey: "race-a", isCatchUp: false }, body),
      withRun(ctx, { kind: "manual", idempotencyKey: "race-b", isCatchUp: false }, body),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["paused", "success"]);
    expect((await getBudgetState(workspace, clock)).runsUsedToday).toBe(3);
  });
});

describe("run-harness.ts: simulated 429 storm end to end", () => {
  it("pauses on the first provider-limit failure, records it, never retries, and refuses later runs until Resume", async () => {
    const { eve, calls } = fakeEve(async () => [turnFailed("MODEL_CALL_FAILED", "rate limited", { semanticErrorId: "gateway-rate-limited" })]);
    const { ctx, workspace, clock } = await contextWith(eve);

    const body = async (c: typeof ctx): Promise<RunBodyResult> => ({ turns: [await runTurn(c, { message: "prepare" })] });

    const first = await withRun(ctx, { kind: "prepare_newly_saved_jobs", idempotencyKey: "storm-1", isCatchUp: false }, body);
    expect(first.outcome).toBe("failure");
    expect(first.error).toContain(PROVIDER_LIMIT_REASON);
    expect(calls.length).toBe(1); // exactly one call to eve's client — no retry loop on our side

    const state = await getBudgetState(workspace, clock);
    expect(state.paused).toBe(true);
    expect(state.pausedReason).toBe(PROVIDER_LIMIT_REASON);

    const second = await withRun(ctx, { kind: "prepare_newly_saved_jobs", idempotencyKey: "storm-2", isCatchUp: false }, body);
    expect(second.outcome).toBe("paused");
    expect(calls.length).toBe(1); // still 1: the second run was refused before calling body at all

    await resumeBudget(workspace);
    const third = await withRun(ctx, { kind: "prepare_newly_saved_jobs", idempotencyKey: "storm-3", isCatchUp: false }, body);
    expect(third.outcome).toBe("failure"); // the fake still rate-limits every call
    expect(calls.length).toBe(2); // Resume let the harness try again, exactly once
  });
});
