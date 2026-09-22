import { randomUUID } from "node:crypto";
import { isTurnFailureEvent, type MessageResponse, type MessageResult, type MessageStreamEvent, type TurnFailureStreamEvent } from "eve/client";
import type { RunKind, RunRecord, RunTokenUsage } from "@workflow-catalog/contracts";
import { getBudgetState, pauseBudget } from "../store/budget.ts";
import { finishRun, NO_MODEL, startRun, writePausedRun } from "../store/runs.ts";
import type { RunnerContext } from "./context.ts";

/**
 * Free functions that take `ctx` (never a class, never new context fields):
 * `withRun` is the budgeted, logged shell every scheduled or manual run goes
 * through; `runTurn` is one eve session turn for use inside a `withRun` body.
 * Nothing in part A calls these from a real route yet — P05 and P08-B do.
 *
 * Provider-limit detection (decision 1): the primary signal is
 * `details.semanticErrorId` from eve's semantic-error catalog
 * (`node_modules/eve/dist/src/harness/semantic-errors/rules/gateway.js`,
 * confirmed by reading the compiled rule table — see the packet report for
 * the exact grep). The fallback regex is a heuristic, not eve-documented:
 * it only applies when eve attaches no `semanticErrorId` at all.
 */

const ZERO_TOKENS: RunTokenUsage = { input: 0, output: 0 };
const MAX_ERROR_LENGTH = 500;
const DEFAULT_TURN_TIMEOUT_MS = 90_000;
export const PROVIDER_LIMIT_REASON = "provider limit";

function shorten(text: string, max = MAX_ERROR_LENGTH): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

// --- runTurn -----------------------------------------------------------

export type TurnStatus = "ok" | "failed" | "parked" | "timeout";

export interface TurnResult {
  readonly status: TurnStatus;
  readonly tokens: RunTokenUsage;
  /** The model id from the turn's last `step.started` event; `step.completed` carries no model id (eve fact, see report). Absent when no step ever started. */
  readonly model?: string;
  /** Present for every non-"ok" status. */
  readonly detail?: string;
  /** True when `status: "failed"` was specifically a provider rate limit. `runTurn` has already paused the budget by the time this is set. */
  readonly providerLimit?: boolean;
}

export interface RunTurnInput {
  readonly message: string;
  readonly timeoutMs?: number;
}

/** Semantic-error-catalog rule ids that mean "the provider (or the AI Gateway in front of it) rate-limited this request" — decision 1's primary signal. */
const RATE_LIMIT_SEMANTIC_IDS = new Set(["gateway-rate-limited", "gateway-free-tier-rate-limited"]);

/** Decision 1's fallback: only consulted when eve attached no `semanticErrorId`. A heuristic, not documented by eve. */
const RATE_LIMIT_FALLBACK = /\b429\b|rate.?limit/i;

function isProviderLimitFailure(event: TurnFailureStreamEvent): boolean {
  const semanticErrorId = event.data.details?.semanticErrorId;
  if (typeof semanticErrorId === "string") return RATE_LIMIT_SEMANTIC_IDS.has(semanticErrorId);
  return RATE_LIMIT_FALLBACK.test(event.data.code) || RATE_LIMIT_FALLBACK.test(event.data.message);
}

function sumUsage(events: readonly MessageStreamEvent[]): RunTokenUsage {
  let input = 0;
  let output = 0;
  for (const event of events) {
    if (event.type === "step.completed") {
      input += event.data.usage?.inputTokens ?? 0;
      output += event.data.usage?.outputTokens ?? 0;
    }
  }
  return { input, output };
}

function lastModelId(events: readonly MessageStreamEvent[]): string | undefined {
  let model: string | undefined;
  for (const event of events) {
    if (event.type === "step.started") model = event.data.modelId;
  }
  return model;
}

async function interpretTurn(ctx: RunnerContext, result: MessageResult, response: MessageResponse): Promise<TurnResult> {
  const tokens = sumUsage(result.events);
  const model = lastModelId(result.events);
  const failure = result.events.find(isTurnFailureEvent);
  if (failure || result.status === "failed") {
    const providerLimit = failure !== undefined && isProviderLimitFailure(failure);
    if (providerLimit) await pauseBudget(ctx.workspace, ctx.clock, PROVIDER_LIMIT_REASON);
    const detail = failure
      ? providerLimit
        ? `${PROVIDER_LIMIT_REASON} (${shorten(failure.data.message)})`
        : `${failure.data.code}: ${shorten(failure.data.message)}`
      : `The turn ended as "failed".`;
    return { status: "failed", tokens, ...(model !== undefined ? { model } : {}), detail, providerLimit };
  }
  if (result.inputRequests.length > 0) {
    await response.cancel().catch(() => undefined);
    return { status: "parked", tokens, ...(model !== undefined ? { model } : {}), detail: "The model asked for input instead of finishing the run." };
  }
  return { status: "ok", tokens, ...(model !== undefined ? { model } : {}) };
}

/**
 * One eve session turn, for use inside a `withRun` body. Never retries — a
 * detected provider limit pauses the budget itself (so `withRun` needs no
 * special case) and fails this turn; the caller is expected to stop, not
 * call `runTurn` again for the same run.
 */
export async function runTurn(ctx: RunnerContext, input: RunTurnInput): Promise<TurnResult> {
  const eve = ctx.eve;
  if (!eve) return { status: "failed", tokens: ZERO_TOKENS, detail: "eve is not running." };
  const timeoutMs = input.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  let response: MessageResponse | undefined;
  try {
    const created = await eve.client.sessions.create({ message: input.message, signal });
    response = created.response;
    const result = await response.result();
    return await interpretTurn(ctx, result, response);
  } catch (caught) {
    if (signal.aborted) {
      await response?.cancel().catch(() => undefined);
      return { status: "timeout", tokens: ZERO_TOKENS, detail: `No answer within ${timeoutMs / 1000} s.` };
    }
    return { status: "failed", tokens: ZERO_TOKENS, detail: shorten(errorMessage(caught)) };
  }
}

// --- withRun -------------------------------------------------------------

export interface WithRunInput {
  readonly kind: RunKind;
  /** Extra fields merged into the record's `inputs` (e.g. job ids for a preparation run). */
  readonly inputs?: Record<string, unknown>;
  readonly idempotencyKey: string;
  readonly isCatchUp: boolean;
  /** Ids the body will process, capped at the budget's `itemCap`. Omit for a run with no per-item list. */
  readonly items?: readonly string[];
}

export interface RunBodyResult {
  readonly turns: readonly TurnResult[];
}

/** `items` is already capped at `itemCap` by `withRun`; the body never sees more than that. */
export type RunBody = (ctx: RunnerContext, items: readonly string[]) => Promise<RunBodyResult>;

/**
 * Runs one budgeted, logged run.
 *
 * Refuses before doing any work when paused or at the daily limit, writing a
 * one-shot `paused` record and never calling `body`. Otherwise writes the
 * crash-safe start placeholder, runs `body`, accumulates its turns' tokens
 * and model id, and always finalizes the record in a `finally` — so
 * `withRun` resolves with the record and never rethrows (decision 3): a
 * thrown body error becomes `outcome: "failure"` with a truncated message,
 * not a rejected promise.
 */
export async function withRun(ctx: RunnerContext, input: WithRunInput, body: RunBody): Promise<RunRecord> {
  const runId = randomUUID();
  const baseInputs = input.inputs ?? {};
  const state = await getBudgetState(ctx.workspace, ctx.clock);

  if (state.paused) {
    return writePausedRun(ctx.workspace, ctx.clock, {
      runId,
      kind: input.kind,
      isCatchUp: input.isCatchUp,
      idempotencyKey: input.idempotencyKey,
      inputs: baseInputs,
      reason: state.pausedReason ?? "paused",
    });
  }
  if (state.runsUsedToday >= state.dailyRunLimit) {
    return writePausedRun(ctx.workspace, ctx.clock, {
      runId,
      kind: input.kind,
      isCatchUp: input.isCatchUp,
      idempotencyKey: input.idempotencyKey,
      inputs: baseInputs,
      reason: `daily run limit reached (${state.dailyRunLimit})`,
    });
  }

  let processedItemIds: readonly string[] = [];
  let runInputs = baseInputs;
  if (input.items) {
    processedItemIds = input.items.slice(0, state.itemCap);
    const remainingItemIds = input.items.slice(state.itemCap);
    // So the Runs page can render "stopped at the per-run cap (N); M jobs stay Saved" straight from the record.
    runInputs = { ...baseInputs, itemCap: state.itemCap, processedItemIds, remainingItemIds };
  }

  const { startedAt } = await startRun(ctx.workspace, ctx.clock, {
    runId,
    kind: input.kind,
    isCatchUp: input.isCatchUp,
    idempotencyKey: input.idempotencyKey,
    inputs: runInputs,
  });

  let outcome: "success" | "failure" = "success";
  let error: string | undefined;
  let model = NO_MODEL;
  let tokens: RunTokenUsage = ZERO_TOKENS;
  let finalRecord!: RunRecord;
  try {
    const { turns } = await body(ctx, processedItemIds);
    for (const turn of turns) {
      tokens = { input: tokens.input + turn.tokens.input, output: tokens.output + turn.tokens.output };
      if (turn.model) model = turn.model;
      if (turn.status !== "ok" && outcome === "success") {
        outcome = "failure";
        error = turn.detail ?? `turn ${turn.status}`;
      }
    }
  } catch (caught) {
    outcome = "failure";
    error = shorten(errorMessage(caught));
  } finally {
    finalRecord = await finishRun(ctx.workspace, ctx.clock, {
      runId,
      kind: input.kind,
      isCatchUp: input.isCatchUp,
      idempotencyKey: input.idempotencyKey,
      inputs: runInputs,
      startedAt,
      outcome,
      model,
      tokens,
      ...(error !== undefined ? { error } : {}),
    });
  }
  return finalRecord;
}
