import { randomUUID } from "node:crypto";
import { isCurrentTurnBoundaryEvent, isTurnFailureEvent, type ClientSession, type MessageStreamEvent, type TurnFailureStreamEvent } from "eve/client";
import type { RunKind, RunRecord, RunTokenUsage } from "@workflow-catalog/contracts";
import { getBudgetState, pauseBudget, withBudgetLock } from "../store/budget.ts";
import { finishRun, NO_MODEL, startRun, writePausedRun } from "../store/runs.ts";
import type { RunnerContext } from "./context.ts";

/**
 * Free functions that take `ctx` (never a class, never new context fields):
 * `withRun` is the budgeted, logged shell every scheduled or manual run goes
 * through; `runTurn` is one eve session turn for use inside a `withRun` body.
 * Nothing in part A calls these from a real route yet — P05 and P08-B do.
 *
 * Provider-limit detection (decision 1, extended by G5 in the round-1
 * revision): the primary signal is `details.semanticErrorId` from eve's
 * semantic-error catalog (`node_modules/eve/dist/src/harness/semantic-errors/
 * rules/gateway.js`). When eve attaches no `semanticErrorId` at all — true
 * for the chatgpt/openai/anthropic providers, which have no rate-limit
 * semantic rule (round-1 review nit) — `details.statusCode === 429` or
 * `details.upstreamStatusCode === 429` also counts, as does a `/429|rate.?
 * limit/i` regex against `code`/`message`; both are undocumented heuristics.
 *
 * `runTurn` (round-1 revision, G1; eve-runtime.md §8 item 15): reads the
 * response stream event by event with `for await`, rather than trusting
 * `response.result()` — eve@0.63.0's client can end an aborted turn quietly
 * as "completed" (no boundary event, no thrown error) when the abort lands
 * while the stream is opening or reconnecting. A turn is `ok` only when a
 * terminal boundary event (`session.completed`/`session.failed`/
 * `session.waiting`) was actually seen *and* the timeout signal never fired;
 * an abort — thrown or quiet — always gives `timeout`, keeping whatever
 * partial `step.completed` usage and `step.started` model id were read
 * before it happened. Cancellation goes through `ClientSession.cancel()`
 * (`created.session`), never `MessageResponse.cancel()`, which eve-runtime.md
 * documents as sending nothing before a turn has started or once it is
 * parked.
 */

const ZERO_TOKENS: RunTokenUsage = { input: 0, output: 0 };
const MAX_ERROR_LENGTH = 500;
const DEFAULT_TURN_TIMEOUT_MS = 90_000;
export const PROVIDER_LIMIT_REASON = "provider limit";
/** G2 (round-1 revision, decision 3 hardened): the record schema requires a non-empty `error` whenever `outcome` is "failure"; an empty thrown message or empty turn detail becomes this fixed sentence instead of failing validation. */
export const EMPTY_ERROR_FALLBACK = "The run failed without an error message.";
/** G2: the last-resort record written when the real one fails schema validation inside `finishRun`'s `finally`. */
export const MINIMAL_FINISH_ERROR = "The run failed and its details could not be recorded.";

function shorten(text: string, max = MAX_ERROR_LENGTH): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/** `undefined`/empty become the fixed sentence (G2); anything else passes through untouched. */
function nonEmptyOrFallback(text: string | undefined): string {
  return text !== undefined && text.length > 0 ? text : EMPTY_ERROR_FALLBACK;
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

/** G5 (round-1 revision): also consulted only when there is no `semanticErrorId` — a plain HTTP 429 from a provider with no semantic rule for it. */
function isStatus429(details: TurnFailureStreamEvent["data"]["details"]): boolean {
  return details?.statusCode === 429 || details?.upstreamStatusCode === 429;
}

/**
 * Decision 1, extended by G5. Precedence matters (tested): when eve attaches
 * *any* `semanticErrorId` — even one unrelated to rate limiting — that is
 * the whole answer; the statusCode/regex fallbacks are never consulted, so a
 * message that merely mentions "429" alongside an unrelated id is not a
 * provider limit.
 */
function isProviderLimitFailure(event: TurnFailureStreamEvent): boolean {
  const details = event.data.details;
  const semanticErrorId = details?.semanticErrorId;
  if (typeof semanticErrorId === "string") return RATE_LIMIT_SEMANTIC_IDS.has(semanticErrorId);
  if (isStatus429(details)) return true;
  return RATE_LIMIT_FALLBACK.test(event.data.code) || RATE_LIMIT_FALLBACK.test(event.data.message);
}

/**
 * One eve session turn, for use inside a `withRun` body. Never retries — a
 * detected provider limit pauses the budget itself (so `withRun` needs no
 * special case) and fails this turn; the caller is expected to stop, not
 * call `runTurn` again for the same run. Never rejects: every path below
 * resolves a `TurnResult`.
 */
export async function runTurn(ctx: RunnerContext, input: RunTurnInput): Promise<TurnResult> {
  const eve = ctx.eve;
  if (!eve) return { status: "failed", tokens: ZERO_TOKENS, detail: "eve is not running." };
  const timeoutMs = input.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);

  let session: ClientSession | undefined;
  let tokens = ZERO_TOKENS;
  let model: string | undefined;
  let boundary: MessageStreamEvent | undefined;
  let failure: TurnFailureStreamEvent | undefined;

  try {
    const created = await eve.client.sessions.create({ message: input.message, signal });
    session = created.session;
    // Read the stream event by event (G1): a quietly-ending abort during an
    // open or reconnect never throws here, so partial usage/model survive it
    // and the post-loop signal.aborted check below is what actually catches it.
    for await (const event of created.response) {
      if (event.type === "step.completed") {
        tokens = { input: tokens.input + (event.data.usage?.inputTokens ?? 0), output: tokens.output + (event.data.usage?.outputTokens ?? 0) };
      } else if (event.type === "step.started") {
        model = event.data.modelId;
      }
      if (!failure && isTurnFailureEvent(event)) failure = event;
      if (isCurrentTurnBoundaryEvent(event)) boundary = event;
    }
  } catch (caught) {
    if (!signal.aborted) {
      return { status: "failed", tokens, ...(model !== undefined ? { model } : {}), detail: shorten(errorMessage(caught)) };
    }
    // An abort while an open stream is being read does throw (eve-runtime.md §8 item 15); fall through to the
    // signal.aborted branch below with whatever partial usage/model was read before it.
  }

  if (signal.aborted) {
    // The reliable cancel (G1): ClientSession.cancel(), never MessageResponse.cancel().
    await session?.cancel().catch(() => undefined);
    return { status: "timeout", tokens, ...(model !== undefined ? { model } : {}), detail: `No answer within ${timeoutMs / 1000} s.` };
  }

  if (failure) {
    const providerLimit = isProviderLimitFailure(failure);
    if (providerLimit) await pauseBudget(ctx.workspace, ctx.clock, PROVIDER_LIMIT_REASON);
    const detail = providerLimit ? `${PROVIDER_LIMIT_REASON} (${shorten(failure.data.message)})` : `${failure.data.code}: ${shorten(failure.data.message)}`;
    return { status: "failed", tokens, ...(model !== undefined ? { model } : {}), detail, providerLimit };
  }

  if (!boundary) {
    // Not aborted, no failure event, yet the stream ended with no terminal boundary: never call this "ok" (G1).
    return { status: "failed", tokens, ...(model !== undefined ? { model } : {}), detail: "The turn ended without a result." };
  }

  if (boundary.type === "session.waiting") {
    await session?.cancel().catch(() => undefined);
    return { status: "parked", tokens, ...(model !== undefined ? { model } : {}), detail: "The model asked for input instead of finishing the run." };
  }

  return { status: "ok", tokens, ...(model !== undefined ? { model } : {}) };
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

type RunDecision =
  | { readonly refused: true; readonly record: RunRecord }
  | { readonly refused: false; readonly processedItemIds: readonly string[]; readonly runInputs: Record<string, unknown>; readonly startedAt: string };

/**
 * Runs one budgeted, logged run.
 *
 * Refuses before doing any work when paused or at the daily limit, writing a
 * one-shot `paused` record and never calling `body`. Otherwise writes the
 * crash-safe start placeholder, runs `body`, accumulates its turns' tokens
 * and model id, and always finalizes the record in a `finally` — so
 * `withRun` resolves with the record and never rejects (decision 3, hardened
 * by G2): a thrown body error, an empty error/turn-detail message, and even
 * a `finishRun` that fails its own schema validation all still resolve with
 * a record, never a rejected promise.
 *
 * G4 (round-1 revision): the paused/limit check and the resulting
 * `startRun`/`writePausedRun` write run inside `withBudgetLock`, so two
 * concurrent runs can never both read "one below the limit" and both
 * proceed — the second always sees the first's already-written placeholder.
 * The lock is released before `body` runs; only the decision itself is
 * serialized, not the run's full duration.
 */
export async function withRun(ctx: RunnerContext, input: WithRunInput, body: RunBody): Promise<RunRecord> {
  const runId = randomUUID();
  const baseInputs = input.inputs ?? {};

  const decision = await withBudgetLock(ctx.workspace, async (): Promise<RunDecision> => {
    const state = await getBudgetState(ctx.workspace, ctx.clock);
    if (state.paused) {
      const record = await writePausedRun(ctx.workspace, ctx.clock, {
        runId,
        kind: input.kind,
        isCatchUp: input.isCatchUp,
        idempotencyKey: input.idempotencyKey,
        inputs: baseInputs,
        reason: state.pausedReason ?? "paused",
      });
      return { refused: true, record };
    }
    if (state.runsUsedToday >= state.dailyRunLimit) {
      const record = await writePausedRun(ctx.workspace, ctx.clock, {
        runId,
        kind: input.kind,
        isCatchUp: input.isCatchUp,
        idempotencyKey: input.idempotencyKey,
        inputs: baseInputs,
        reason: `daily run limit reached (${state.dailyRunLimit})`,
      });
      return { refused: true, record };
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
    return { refused: false, processedItemIds, runInputs, startedAt };
  });

  if (decision.refused) return decision.record;
  const { processedItemIds, runInputs, startedAt } = decision;

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
        error = turn.detail;
      }
    }
  } catch (caught) {
    outcome = "failure";
    error = shorten(errorMessage(caught));
  } finally {
    const finishInput = {
      runId,
      kind: input.kind,
      isCatchUp: input.isCatchUp,
      idempotencyKey: input.idempotencyKey,
      inputs: runInputs,
      startedAt,
      outcome,
      model,
      tokens,
      ...(outcome === "failure" ? { error: nonEmptyOrFallback(error) } : {}),
    };
    try {
      finalRecord = await finishRun(ctx.workspace, ctx.clock, finishInput);
    } catch (validationError) {
      ctx.log.error(`withRun: finishRun failed validation for ${runId} (${errorMessage(validationError)}); writing a minimal failure record instead.`);
      try {
        finalRecord = await finishRun(ctx.workspace, ctx.clock, {
          runId,
          kind: input.kind,
          isCatchUp: input.isCatchUp,
          idempotencyKey: input.idempotencyKey,
          inputs: {},
          startedAt,
          outcome: "failure",
          model: NO_MODEL,
          tokens: ZERO_TOKENS,
          error: MINIMAL_FINISH_ERROR,
        });
      } catch (minimalError) {
        ctx.log.error(`withRun: the minimal failure record also failed to write for ${runId} (${errorMessage(minimalError)}); resolving with an in-memory record only.`);
        const now = ctx.clock.now().toISOString();
        finalRecord = {
          runId,
          kind: input.kind,
          isCatchUp: input.isCatchUp,
          inputs: {},
          idempotencyKey: input.idempotencyKey,
          outcome: "failure",
          model: NO_MODEL,
          tokens: ZERO_TOKENS,
          durationMs: 0,
          startedAt,
          finishedAt: now,
          error: MINIMAL_FINISH_ERROR,
        };
      }
    }
  }
  return finalRecord;
}
