import { chmod, mkdir, writeFile } from "node:fs/promises";
import type { Client, ClientSession, InputRequest, MessageResponse, MessageStreamEvent } from "eve/client";
import { runRecordSchema } from "@workflow-catalog/contracts";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../lib/clock.ts";
import { createRunnerContext, silentLogger, type RunnerLogger } from "../server/context.ts";
import type { EveGateway } from "../server/eve-gateway.ts";
import {
  EMPTY_ERROR_FALLBACK,
  EMPTY_IDEMPOTENCY_KEY_ERROR,
  MINIMAL_FINISH_ERROR,
  PROVIDER_LIMIT_REASON,
  RUN_NOT_STARTED_ERROR,
  runTurn,
  withRun,
  type RunBodyResult,
  type TurnResult,
} from "../server/run-harness.ts";
import { getBudgetState, pauseBudget, resumeBudget, runLogUnreadableReason, setBudgetLimits } from "../store/budget.ts";
import { getRun, hasSucceededWithIdempotencyKey, localDateString, NO_MODEL, UNKNOWN_MODEL } from "../store/runs.ts";
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

function turnCompleted(): MessageStreamEvent {
  return { type: "turn.completed", data: { sequence: 8, turnId: "t1" }, meta: META };
}

function turnCancelled(): MessageStreamEvent {
  return { type: "turn.cancelled", data: { sequence: 8, turnId: "t1" }, meta: META };
}

/** A realistic `ask_question` request (eve's InputRequest shape). Fictional content only. */
const QUESTION: InputRequest = {
  action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "ask_question" },
  kind: "question",
  prompt: "Which saved Northwind Labs job should I prepare first?",
  requestId: "req-1",
};

function inputRequested(requests: readonly InputRequest[] = [QUESTION]): MessageStreamEvent {
  return { type: "input.requested", data: { requests, sequence: 7, stepIndex: 0, turnId: "t1" }, meta: META };
}

/**
 * The boundary every conversation turn ends with (eve-runtime.md §8 item 15): `turn.completed → session.waiting`
 * is a normal, finished turn. eve's docs call it "parked and ready for the next message" — idle, not waiting on
 * the person.
 */
function sessionWaiting(): MessageStreamEvent {
  return { type: "session.waiting", data: { continuationToken: "s1", wait: "next-user-message" }, meta: META };
}

/** The boundary a task-mode session (a schedule firing, say) ends with. */
function sessionCompleted(): MessageStreamEvent {
  return { type: "session.completed", meta: META } as MessageStreamEvent;
}

function sessionFailed(code: string, message: string): MessageStreamEvent {
  return { type: "session.failed", data: { code, message, sessionId: "s1" }, meta: META };
}

interface FakeCall {
  readonly message: string;
}

/**
 * A fake EveGateway whose client.sessions.create is scripted per call, event
 * by event — matching how the real eve client streams (G1: `runTurn` no
 * longer trusts a single aggregated `result()`). Only `session.cancel()` is
 * counted (G1: "fakes count only real cancel requests"); `runTurn` never
 * calls `response.cancel()`, and this fake's response has no `cancel` at all.
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

/** Collects error lines, so a test can assert that `withRun` logged what it caught (I2: "logs it"). */
function capturingLogger(): { log: RunnerLogger; errors: string[] } {
  const errors: string[] = [];
  return { log: { ...silentLogger, error: (message) => errors.push(message) }, errors };
}

async function contextWith(eve?: EveGateway, clock = new ManualClock(), log: RunnerLogger = silentLogger) {
  const workspace = await newWorkspace(clock);
  const ctx = createRunnerContext({ workspace, clock, packageVersion: "0.1.0", eve, log });
  return { ctx, workspace, clock };
}

/** chmod can only deny access to a non-root user on a POSIX filesystem; CI (ubuntu, non-root) and macOS qualify. */
const canDenyAccess = process.platform !== "win32" && process.getuid?.() !== 0;

describe("run-harness.ts: runTurn — turn classification (I1, eve-runtime.md §8 item 15)", () => {
  it("a normal conversation turn (turn.completed → session.waiting) is ok, sums tokens, takes the last step.started model, and sends no cancel", async () => {
    const { eve, cancelCount } = fakeEve(async () => [started("gpt-5.6-luna"), completed({ inputTokens: 100, outputTokens: 20 }), turnCompleted(), sessionWaiting()]);
    const { ctx } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result).toEqual({ status: "ok", tokens: { input: 100, output: 20 }, model: "gpt-5.6-luna" });
    expect(cancelCount()).toBe(0);
  });

  it("a task-mode turn (turn.completed → session.completed) is ok too", async () => {
    const { eve, cancelCount } = fakeEve(async () => [started("gpt-5.6-luna"), completed({ inputTokens: 9, outputTokens: 3 }), turnCompleted(), sessionCompleted()]);
    const { ctx } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result).toEqual({ status: "ok", tokens: { input: 9, output: 3 }, model: "gpt-5.6-luna" });
    expect(cancelCount()).toBe(0);
  });

  it("sums usage across more than one step", async () => {
    const { eve } = fakeEve(async () => [started("m1", 0), completed({ inputTokens: 10, outputTokens: 2 }, 0), started("m2", 1), completed({ inputTokens: 5, outputTokens: 1 }, 1), turnCompleted(), sessionWaiting()]);
    const { ctx } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.status).toBe("ok");
    expect(result.tokens).toEqual({ input: 15, output: 3 });
    expect(result.model).toBe("m2");
  });

  it("waiting on the person: a non-empty input.requested list, then session.waiting, parks and cancels once through session.cancel()", async () => {
    const { eve, cancelCount } = fakeEve(async () => [started("m1"), completed({ inputTokens: 4, outputTokens: 2 }), inputRequested(), sessionWaiting()]);
    const { ctx } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result).toMatchObject({ status: "parked", tokens: { input: 4, output: 2 }, model: "m1" });
    expect(result.detail).toContain("asked for input");
    expect(cancelCount()).toBe(1);
  });

  it("an input.requested event with an empty list is not a park", async () => {
    const { eve, cancelCount } = fakeEve(async () => [started("m1"), inputRequested([]), turnCompleted(), sessionWaiting()]);
    const { ctx } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.status).toBe("ok");
    expect(cancelCount()).toBe(0);
  });

  it("turn.cancelled (then session.waiting) is not ok: 'cancelled', with no cancel of our own", async () => {
    const { eve, cancelCount } = fakeEve(async () => [started("m1"), completed({ inputTokens: 2, outputTokens: 1 }), turnCancelled(), sessionWaiting()]);
    const { ctx } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result).toMatchObject({ status: "cancelled", tokens: { input: 2, output: 1 }, model: "m1" });
    expect(result.detail).toContain("cancelled");
    expect(cancelCount()).toBe(0);
  });

  it("a session.failed boundary is not ok", async () => {
    const { eve } = fakeEve(async () => [started("m1"), sessionFailed("SESSION_FAILED", "The session failed.")]);
    const { ctx } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.status).toBe("failed");
    expect(result.providerLimit).toBeFalsy();
  });

  it("no boundary event at all (never aborted, no failure): never called 'ok' (mutation target)", async () => {
    const { eve } = fakeEve(async () => [started("m1"), completed({ inputTokens: 1, outputTokens: 1 })]);
    const { ctx } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.status).toBe("failed");
    expect(result.tokens).toEqual({ input: 1, output: 1 }); // partial usage still kept
  });

  it("create() itself hangs until the deadline: the turn times out", async () => {
    const { eve } = fakeEve(() => "hang");
    const { ctx } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go", timeoutMs: 20 });
    expect(result.status).toBe("timeout");
    expect(result.detail).toContain("No answer within");
  });

  it("a stream error that carries no message fails the turn with the fixed sentence (G2, I3)", async () => {
    const { eve } = fakeEve(async () => {
      throw new Error("   ");
    });
    const { ctx } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result).toMatchObject({ status: "failed", detail: EMPTY_ERROR_FALLBACK });
  });

  it("without eve running, a turn fails immediately", async () => {
    const { ctx } = await contextWith(undefined);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("eve is not running");
  });
});

describe("run-harness.ts: runTurn — collectEvents (P04, round-1 review L11 nit)", () => {
  it("collectEvents: true returns the turn's own stream events, in order", async () => {
    const script = [started("gpt-5.6-luna"), completed({ inputTokens: 1, outputTokens: 1 }), turnCompleted(), sessionWaiting()];
    const { eve } = fakeEve(async () => script);
    const { ctx } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go", collectEvents: true });
    expect(result.status).toBe("ok");
    expect(result.events).toEqual(script);
  });

  it("omitting collectEvents (the default) leaves events absent from the result, not an empty array", async () => {
    const { eve } = fakeEve(async () => [started("gpt-5.6-luna"), completed({ inputTokens: 1, outputTokens: 1 }), turnCompleted(), sessionWaiting()]);
    const { ctx } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result).toEqual({ status: "ok", tokens: { input: 1, output: 1 }, model: "gpt-5.6-luna" });
    expect("events" in result).toBe(false);
  });
});

describe("run-harness.ts: runTurn — provider limit (decision 1, G5)", () => {
  it("an ordinary failure (step.failed → turn.failed → session.waiting, as eve ends a failed conversation turn) fails the turn without pausing the budget", async () => {
    const { eve } = fakeEve(async () => [started("m1"), turnFailed("MODEL_CALL_FAILED", "The model declined to answer."), sessionWaiting()]);
    const { ctx, workspace, clock } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.status).toBe("failed");
    expect(result.providerLimit).toBeFalsy();
    expect((await getBudgetState(workspace, clock)).paused).toBe(false);
  });

  it("primary signal: details.semanticErrorId gateway-rate-limited pauses the budget with reason 'provider limit'", async () => {
    const { eve } = fakeEve(async () => [turnFailed("MODEL_CALL_FAILED", "AI Gateway rate-limited the request.", { semanticErrorId: "gateway-rate-limited" }), sessionWaiting()]);
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
    const { eve } = fakeEve(async () => [turnFailed("MODEL_CALL_FAILED", "Free tier requests on this model are rate-limited.", { semanticErrorId: "gateway-free-tier-rate-limited" }), sessionWaiting()]);
    const { ctx, workspace, clock } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.providerLimit).toBe(true);
    expect((await getBudgetState(workspace, clock)).paused).toBe(true);
  });

  it("a semanticErrorId for an unrelated gateway rule does not count as a provider limit", async () => {
    const { eve } = fakeEve(async () => [turnFailed("MODEL_CALL_FAILED", "The requested model is not available.", { semanticErrorId: "model-not-found" }), sessionWaiting()]);
    const { ctx, workspace, clock } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.providerLimit).toBeFalsy();
    expect((await getBudgetState(workspace, clock)).paused).toBe(false);
  });

  it("fallback signal (no semanticErrorId): a bare 429 in the message pauses the budget", async () => {
    const { eve } = fakeEve(async () => [turnFailed("UPSTREAM_ERROR", "HTTP 429 Too Many Requests from the provider."), sessionWaiting()]);
    const { ctx, workspace, clock } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.providerLimit).toBe(true);
    expect((await getBudgetState(workspace, clock)).paused).toBe(true);
  });

  it("fallback signal (no semanticErrorId): 'rate limit' wording in the code pauses the budget", async () => {
    const { eve } = fakeEve(async () => [turnFailed("rate_limited", "Too many requests right now."), sessionWaiting()]);
    const { ctx, workspace, clock } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.providerLimit).toBe(true);
    expect((await getBudgetState(workspace, clock)).paused).toBe(true);
  });

  it("negative case: no semanticErrorId and no 429/rate-limit wording never pauses", async () => {
    const { eve } = fakeEve(async () => [turnFailed("VALIDATION_ERROR", "Invalid request: missing field 'foo'."), sessionWaiting()]);
    const { ctx, workspace, clock } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.providerLimit).toBeFalsy();
    expect(result.status).toBe("failed");
    expect((await getBudgetState(workspace, clock)).paused).toBe(false);
  });

  it("G5: details.statusCode 429 with no semanticErrorId pauses the budget", async () => {
    const { eve } = fakeEve(async () => [turnFailed("UPSTREAM_ERROR", "Too many requests.", { statusCode: 429 }), sessionWaiting()]);
    const { ctx, workspace, clock } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.providerLimit).toBe(true);
    expect((await getBudgetState(workspace, clock)).paused).toBe(true);
  });

  it("G5: details.upstreamStatusCode 429 with no semanticErrorId pauses the budget", async () => {
    const { eve } = fakeEve(async () => [turnFailed("UPSTREAM_ERROR", "Too many requests.", { upstreamStatusCode: 429 }), sessionWaiting()]);
    const { ctx, workspace, clock } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.providerLimit).toBe(true);
    expect((await getBudgetState(workspace, clock)).paused).toBe(true);
  });

  it("G5 precedence: an unrelated semanticErrorId plus a 429 statusCode and rate-limit wording is NOT a provider limit", async () => {
    const { eve } = fakeEve(async () => [turnFailed("MODEL_CALL_FAILED", "429 rate limited (but really just not-found)", { semanticErrorId: "model-not-found", statusCode: 429 }), sessionWaiting()]);
    const { ctx, workspace, clock } = await contextWith(eve);
    const result = await runTurn(ctx, { message: "go" });
    expect(result.providerLimit).toBeFalsy();
    expect((await getBudgetState(workspace, clock)).paused).toBe(false);
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

describe("run-harness.ts: withRun — nothing before the body can reject (I2)", () => {
  it("an empty idempotencyKey resolves with an in-memory failure record with a fixed message: logged, body never called, nothing written", async () => {
    const { log, errors } = capturingLogger();
    const { ctx, workspace, clock } = await contextWith(undefined, new ManualClock(), log);
    let called = 0;
    const record = await withRun(ctx, { kind: "prepare_newly_saved_jobs", idempotencyKey: "", isCatchUp: false }, async () => {
      called += 1;
      return { turns: [] };
    });
    expect(record).toMatchObject({ outcome: "failure", error: EMPTY_IDEMPOTENCY_KEY_ERROR, model: NO_MODEL, tokens: { input: 0, output: 0 }, durationMs: 0 });
    expect(called).toBe(0);
    expect(errors.some((line) => line.includes("empty idempotencyKey"))).toBe(true);
    expect(await getRun(workspace, record.runId)).toBeUndefined();
    expect(await workspace.list("runs", localDateString(clock.now()))).toEqual([]);
  });

  it("a whitespace-only idempotencyKey is refused the same way", async () => {
    const { ctx } = await contextWith(undefined);
    let called = 0;
    const record = await withRun(ctx, { kind: "manual", idempotencyKey: "   ", isCatchUp: false }, async () => {
      called += 1;
      return { turns: [] };
    });
    expect(record).toMatchObject({ outcome: "failure", error: EMPTY_IDEMPOTENCY_KEY_ERROR });
    expect(called).toBe(0);
  });

  it.skipIf(!canDenyAccess)("today's run folder unreadable and unwritable (chmod 000): resolves with an in-memory failure record, logged, body never called", async () => {
    const { log, errors } = capturingLogger();
    const { ctx, workspace, clock } = await contextWith(undefined, new ManualClock(), log);
    const date = localDateString(clock.now());
    const today = workspace.resolve("runs", date);
    await mkdir(today, { recursive: true });
    await chmod(today, 0o000);
    let called = 0;
    try {
      // The store layer reports the synthetic pause instead of throwing...
      const state = await getBudgetState(workspace, clock);
      expect(state).toMatchObject({ paused: true, pausedReason: runLogUnreadableReason(date), pauseKind: "run_log_unreadable", runLogUnreadable: true });
      // ...and withRun, which can't write the refusal record into that folder, resolves anyway.
      const record = await withRun(ctx, { kind: "prepare_newly_saved_jobs", idempotencyKey: "catch-up-ada-quill", isCatchUp: true }, async () => {
        called += 1;
        return { turns: [] };
      });
      expect(record).toMatchObject({ outcome: "failure", error: RUN_NOT_STARTED_ERROR, idempotencyKey: "catch-up-ada-quill", isCatchUp: true });
      expect(runRecordSchema.safeParse(record).success).toBe(true);
    } finally {
      await chmod(today, 0o700);
    }
    expect(called).toBe(0);
    expect(errors.some((line) => line.includes("did not start"))).toBe(true);
  });

  it.skipIf(!canDenyAccess)("today's run folder unlistable but writable (chmod 300): refused with a paused record naming the folder, written to disk", async () => {
    const { ctx, workspace, clock } = await contextWith(undefined);
    const date = localDateString(clock.now());
    const today = workspace.resolve("runs", date);
    await mkdir(today, { recursive: true });
    await chmod(today, 0o300);
    let called = 0;
    const record = await withRun(ctx, { kind: "prepare_newly_saved_jobs", idempotencyKey: "northwind-labs", isCatchUp: false }, async () => {
      called += 1;
      return { turns: [] };
    }).finally(() => chmod(today, 0o700));
    expect(record).toMatchObject({ outcome: "paused", error: runLogUnreadableReason(date) });
    expect(called).toBe(0);
    const onDisk = await getRun(workspace, record.runId);
    expect(onDisk).toMatchObject({ outcome: "paused", error: `run log unreadable (runs/${date}/)` });
  });

  it.skipIf(!canDenyAccess)("an unwritable runs/ (chmod 500): the start placeholder can't be written, so withRun resolves with an in-memory failure record", async () => {
    const { log, errors } = capturingLogger();
    const { ctx, workspace } = await contextWith(undefined, new ManualClock(), log);
    const runs = workspace.resolve("runs");
    await chmod(runs, 0o500);
    let called = 0;
    try {
      const record = await withRun(ctx, { kind: "manual", idempotencyKey: "ada-quill-manual", isCatchUp: false }, async () => {
        called += 1;
        return { turns: [] };
      });
      expect(record).toMatchObject({ outcome: "failure", error: RUN_NOT_STARTED_ERROR });
      expect(runRecordSchema.safeParse(record).success).toBe(true);
    } finally {
      await chmod(runs, 0o700);
    }
    expect(called).toBe(0);
    expect(errors.some((line) => line.includes("did not start"))).toBe(true);
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

  it("G2/I3: `throw undefined` gets the fixed sentence, not the text 'undefined'", async () => {
    const { ctx, workspace } = await contextWith(undefined);
    const record = await withRun(ctx, { kind: "manual", idempotencyKey: "throw-undefined", isCatchUp: false }, async () => {
      throw undefined;
    });
    expect(record.error).toBe(EMPTY_ERROR_FALLBACK);
    expect((await getRun(workspace, record.runId))?.error).toBe(EMPTY_ERROR_FALLBACK);
  });

  it("G2: a failed turn whose detail is an empty string resolves with the fixed fallback sentence, never rejects", async () => {
    const { ctx } = await contextWith(undefined);
    const record = await withRun(ctx, { kind: "manual", idempotencyKey: "empty-detail", isCatchUp: false }, async () => ({
      turns: [{ status: "failed" as const, tokens: { input: 1, output: 1 }, detail: "" }],
    }));
    expect(record.outcome).toBe("failure");
    expect(record.error).toBe(EMPTY_ERROR_FALLBACK);
  });

  it("G2/I3: a whitespace-only turn detail gets the fixed sentence, not the blanks", async () => {
    const { ctx, workspace } = await contextWith(undefined);
    const record = await withRun(ctx, { kind: "manual", idempotencyKey: "blank-detail", isCatchUp: false }, async () => ({
      turns: [{ status: "failed" as const, tokens: { input: 1, output: 1 }, detail: " \n\t " }],
    }));
    expect(record.error).toBe(EMPTY_ERROR_FALLBACK);
    expect((await getRun(workspace, record.runId))?.error).toBe(EMPTY_ERROR_FALLBACK);
  });

  it("G2 fallback 1: when the full record fails validation, a minimal fixed-text failure record is written instead, and logged", async () => {
    const { log, errors } = capturingLogger();
    const { ctx, workspace } = await contextWith(undefined, new ManualClock(), log);
    const record = await withRun(ctx, { kind: "manual", idempotencyKey: "bad-tokens", isCatchUp: false }, async () => ({
      turns: [{ status: "ok" as const, tokens: { input: 1.5, output: -1 }, model: "m" }],
    }));
    expect(record).toMatchObject({ outcome: "failure", error: MINIMAL_FINISH_ERROR, model: NO_MODEL, tokens: { input: 0, output: 0 } });
    const onDisk = await getRun(workspace, record.runId);
    expect(onDisk).toMatchObject({ outcome: "failure", error: MINIMAL_FINISH_ERROR });
    expect(onDisk?.finishedAt).toBeDefined();
    expect(errors.some((line) => line.includes("writing a minimal failure record"))).toBe(true);
  });

  it.skipIf(!canDenyAccess)("G2 fallback 2: when neither record can be written, withRun resolves with an in-memory record and leaves the honest placeholder on disk", async () => {
    const { log, errors } = capturingLogger();
    const { ctx, workspace, clock } = await contextWith(undefined, new ManualClock(), log);
    const today = workspace.resolve("runs", localDateString(clock.now()));
    const record = await withRun(ctx, { kind: "manual", idempotencyKey: "read-only-folder", isCatchUp: false }, async () => {
      await chmod(today, 0o500); // the start placeholder is written; now neither finishing write can land
      clock.advance(2_000);
      return { turns: [{ status: "ok" as const, tokens: { input: 3, output: 1 }, model: "m" }] };
    }).finally(() => chmod(today, 0o700));
    expect(record).toMatchObject({ outcome: "failure", error: MINIMAL_FINISH_ERROR, durationMs: 2_000 });
    expect(record.finishedAt).toBeDefined();
    expect(runRecordSchema.safeParse(record).success).toBe(true);
    const onDisk = await getRun(workspace, record.runId);
    expect(onDisk).toMatchObject({ outcome: "failure", error: "interrupted: the runner stopped before this run finished" });
    expect(onDisk?.finishedAt).toBeUndefined();
    expect(errors.some((line) => line.includes("resolving with an in-memory record only"))).toBe(true);
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

  it("nit 8: a turn that timed out before any step keeps its tokens and duration, with model 'unknown' (not 'n/a')", async () => {
    const { ctx, clock } = await contextWith(undefined);
    const record = await withRun(ctx, { kind: "prepare_newly_saved_jobs", idempotencyKey: "timeout-early", isCatchUp: false }, async () => {
      clock.advance(90_000);
      return { turns: [{ status: "timeout" as const, tokens: { input: 0, output: 0 }, detail: "No answer within 90 s." }] };
    });
    expect(record).toMatchObject({ outcome: "failure", model: UNKNOWN_MODEL, durationMs: 90_000, error: "No answer within 90 s." });
  });

  it("nit 8 / G8: a body that never ran a turn keeps model 'n/a'", async () => {
    const { ctx } = await contextWith(undefined);
    const record = await withRun(ctx, { kind: "manual", idempotencyKey: "no-turns", isCatchUp: false }, async () => {
      throw new Error("Could not read the saved jobs.");
    });
    expect(record.model).toBe(NO_MODEL);
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

describe("run-harness.ts: I1 end to end with the fakes", () => {
  it("a normal conversation turn through withRun records success, and the idempotency lookup then says done", async () => {
    const { eve, cancelCount } = fakeEve(async () => [started("gpt-5.6-luna"), completed({ inputTokens: 11, outputTokens: 2 }), turnCompleted(), sessionWaiting()]);
    const { ctx, workspace, clock } = await contextWith(eve);
    const record = await withRun(ctx, { kind: "prepare_newly_saved_jobs", idempotencyKey: "prepare:ada-quill:northwind", isCatchUp: false }, async (c) => ({ turns: [await runTurn(c, { message: "prepare" })] }));
    expect(record).toMatchObject({ outcome: "success", model: "gpt-5.6-luna", tokens: { input: 11, output: 2 } });
    expect(await hasSucceededWithIdempotencyKey(workspace, clock, "prepare:ada-quill:northwind")).toBe(true);
    expect(cancelCount()).toBe(0);
  });

  it("a cancelled turn through withRun records a failure, so the idempotency lookup says not done", async () => {
    const { eve } = fakeEve(async () => [started("gpt-5.6-luna"), turnCancelled(), sessionWaiting()]);
    const { ctx, workspace, clock } = await contextWith(eve);
    const record = await withRun(ctx, { kind: "prepare_newly_saved_jobs", idempotencyKey: "prepare:cancelled", isCatchUp: false }, async (c) => ({ turns: [await runTurn(c, { message: "prepare" })] }));
    expect(record.outcome).toBe("failure");
    expect(await hasSucceededWithIdempotencyKey(workspace, clock, "prepare:cancelled")).toBe(false);
  });
});

describe("run-harness.ts: simulated 429 storm end to end", () => {
  it("pauses on the first provider-limit failure, records it, never retries, and refuses later runs until Resume", async () => {
    const { eve, calls } = fakeEve(async () => [turnFailed("MODEL_CALL_FAILED", "rate limited", { semanticErrorId: "gateway-rate-limited" }), sessionWaiting()]);
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
