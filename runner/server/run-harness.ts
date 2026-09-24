import { randomUUID } from "node:crypto";
import { isCurrentTurnBoundaryEvent, isTurnFailureEvent, type Client, type ClientSession, type MessageStreamEvent, type TurnFailureStreamEvent } from "eve/client";
import type { RunKind, RunRecord, RunTokenUsage } from "@workflow-catalog/contracts";
import { getBudgetState, pauseBudget, withBudgetLock } from "../store/budget.ts";
import { finishRun, NO_MODEL, startRun, UNKNOWN_MODEL, writePausedRun } from "../store/runs.ts";
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
 * `details.upstreamStatusCode === 429` also counts, as does a `/\b429\b|rate.?
 * limit/i` regex against `code`/`message`; both are undocumented heuristics.
 *
 * How `runTurn` classifies a turn (I1, following eve-runtime.md §8 item 15,
 * "Which boundary means what"). It reads the response stream event by event
 * with `for await` (G1), because eve@0.63.0's client can end an aborted turn
 * quietly as "completed" with no boundary and no thrown error; whatever
 * `step.completed` usage and `step.started` model id arrived before the end
 * are kept on every path. Checked in this order:
 *   - timeout: the timeout signal fired, whether the stream threw or ended
 *     quietly. Cancelled through the session.
 *   - failed: any failure event (`step.failed`, `turn.failed`,
 *     `session.failed`). Never retried; a provider limit pauses the budget.
 *   - cancelled: `turn.cancelled` (eve then always sends `session.waiting`).
 *     Someone else cancelled the turn, so there is nothing for us to cancel.
 *   - failed: the stream ended with no boundary event at all.
 *   - parked, "waiting on the person": only a non-empty `input.requested`
 *     list. Cancelled through the session.
 *   - ok: a `session.waiting` or `session.completed` boundary with none of
 *     the above. A normal conversation turn, which is what
 *     `client.sessions.create` starts, ends `turn.completed → session.waiting`
 *     ("parked and ready for the next message" in eve's words: idle between
 *     turns, not waiting on anyone); only task-mode sessions, such as a
 *     schedule firing, end `session.completed`. The P02 spike recorded both
 *     (docs/spec/research/eve-spike.md).
 *
 * Cancellation always goes through `ClientSession.cancel()`, never
 * `MessageResponse.cancel()`, which sends nothing before the turn has
 * started or once it is parked, and is bounded by `CANCEL_TIMEOUT_MS` so a
 * stalled eve can't hang the run (I3). For information (round-2 review nit
 * 9; eve docs, concepts/sessions-runs-and-streaming.md "Cancel the in-flight
 * turn"): a plain cancel on a session that is already parked is an accepted
 * no-op on eve's side, so for a parked turn the cancel is a formality. The
 * session simply stays parked, durable and idle.
 *
 * P03.2 (deliverable 1, "one turn classifier"): `classifyTurn` below is the
 * whole algorithm above, taking only a `Client` — no `RunnerContext` — so
 * `eve-gateway.ts`'s `checkModel` (which runs before a `RunnerContext`
 * exists: the gateway it builds becomes `ctx.eve`) can call the exact same
 * classifier instead of a second copy. `runTurn` is a thin wrapper: it adds
 * the one ctx-dependent side effect (pausing the budget on a detected
 * provider limit) and the `RunnerContext`-shaped early return when eve isn't
 * running. `onboarding.ts`'s extraction route and `eve-gateway.ts`'s
 * `checkModel` both read a tool's or the reply's own output off
 * `TurnResult.events` (`collectEvents: true`) rather than growing their own
 * classifier; `grep` for turn classification should find only this file.
 */

const ZERO_TOKENS: RunTokenUsage = { input: 0, output: 0 };
const MAX_ERROR_LENGTH = 500;
const DEFAULT_TURN_TIMEOUT_MS = 90_000;
/** I3 (round-2 nit 4): the bound on `session.cancel()`, passed to it as `AbortSignal.timeout`. */
export const CANCEL_TIMEOUT_MS = 5_000;
export const PROVIDER_LIMIT_REASON = "provider limit";
/** G2 (round-1 revision, decision 3 hardened): the record schema requires a non-empty `error` whenever `outcome` is "failure"; an empty, whitespace-only or missing thrown message or turn detail (including `throw undefined`) becomes this fixed sentence instead of failing validation. */
export const EMPTY_ERROR_FALLBACK = "The run failed without an error message.";
/** G2: the last-resort record written when the real one fails schema validation inside `finishRun`'s `finally`. */
export const MINIMAL_FINISH_ERROR = "The run failed and its details could not be recorded.";
/** I2: `withRun` refuses an empty (or whitespace-only) `idempotencyKey` before it touches anything. */
export const EMPTY_IDEMPOTENCY_KEY_ERROR = "The run did not start: it had no idempotency key.";
/** I2: any other error before the body, such as a run folder that can't be written. The details go to the log. */
export const RUN_NOT_STARTED_ERROR = "The run did not start: its run record could not be written.";

function shorten(text: string, max = MAX_ERROR_LENGTH): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The message of whatever was thrown, or "" when it carries none (`throw undefined`, `throw null`, a bare object). */
function errorMessage(caught: unknown): string {
  if (caught instanceof Error) return caught.message;
  if (typeof caught === "string") return caught;
  if (typeof caught === "number" || typeof caught === "boolean" || typeof caught === "bigint") return String(caught);
  if (caught !== null && typeof caught === "object" && typeof (caught as { message?: unknown }).message === "string") return (caught as { message: string }).message;
  return "";
}

/** `undefined`, empty and whitespace-only text become the fixed sentence (G2, I3); anything else passes through untouched. */
function nonEmptyOrFallback(text: string | undefined): string {
  return text !== undefined && text.trim().length > 0 ? text : EMPTY_ERROR_FALLBACK;
}

// --- runTurn -----------------------------------------------------------

/** See the classification order at the top of this file. `parked` means waiting on the person (a non-empty `input.requested` list), never eve's `session.waiting` on its own. */
export type TurnStatus = "ok" | "failed" | "cancelled" | "parked" | "timeout";

export interface TurnResult {
  readonly status: TurnStatus;
  readonly tokens: RunTokenUsage;
  /** The model id from the turn's last `step.started` event; `step.completed` carries no model id (eve fact, see report). Absent when no step ever started. */
  readonly model?: string;
  /** Present for every non-"ok" status. */
  readonly detail?: string;
  /**
   * True when `status: "failed"` was specifically a provider rate limit,
   * decided here in `classifyTurn`. Whether that actually pauses the budget
   * is entirely up to the caller: `runTurn` pauses (its own
   * `pauseBudgetOnProviderLimit` option, see `RunTurnInput`), but only for a
   * caller that goes through `runTurn` at all — `eve-gateway.ts`'s
   * `checkModel` calls `classifyTurn` directly and never pauses anything
   * (Q5, revision 1: this comment previously claimed the pause had already
   * happened "by the time this is set", which has it backwards — pausing,
   * when it happens, is `runTurn`'s later step, after this field is read).
   */
  readonly providerLimit?: boolean;
  /**
   * P04 (additive): the turn's raw stream events, in order, present only when
   * `RunTurnInput.collectEvents` was set. A caller reads a tool's own output
   * from these the way P03's onboarding route reads `action.result` off
   * `MessageResult.events` — `captures.ts`'s job-extraction turn was the
   * first caller. P03.2 (Q5, revision 1: this comment used to say "there are
   * two [classifiers] already; a runner follow-up will merge them" — true
   * when P04 wrote it, stale now that merge is this file itself) moved
   * `onboarding.ts`'s extraction route and `eve-gateway.ts`'s `checkModel`
   * onto this same classifier, reading a tool's or the reply's own output off
   * these events the same way. Every existing caller that omits
   * `collectEvents` gets exactly the `TurnResult` shape it always has: this
   * field is simply absent, not `undefined`-valued, on every return path
   * below.
   */
  readonly events?: readonly MessageStreamEvent[];
}

export interface RunTurnInput {
  readonly message: string;
  readonly timeoutMs?: number;
  /** P04: also collect the turn's events onto the result (see `TurnResult.events`). Defaults to false, so every existing call site is unaffected. */
  readonly collectEvents?: boolean;
  /**
   * P03.2 (deliverable 1): whether a detected provider limit pauses the
   * budget. Defaults to `true` (every existing caller keeps pausing).
   * Onboarding's interactive claim extraction (`routes/onboarding.ts`) is
   * the one caller that passes `false`: a single, manual, foreground action
   * that never goes through `withRun` and writes no `RunRecord`.
   *
   * Q5 (revision 1, reviewer 4: this comment previously said a model check
   * "passes `false`" too, which doesn't describe the code — there is no
   * option to pass): `eve-gateway.ts`'s `checkModel` doesn't pause on a
   * provider limit either, but not because of this option — it calls
   * `classifyTurn` directly (never `runTurn`), so no pause ever runs for it,
   * regardless of this flag's default. Recorded here as the real decision:
   * neither a model check nor an interactive extraction pauses the budget
   * today. Left unrevisited by this packet (P08-B's carried item is where
   * that gets decided on purpose, not as a side effect of plumbing); P04's
   * job-capture extraction queue is unattended and potentially many turns in
   * a row, so it keeps the default `true`.
   */
  readonly pauseBudgetOnProviderLimit?: boolean;
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

/** The reliable cancel (G1), bounded (I3). eve documents "accepted" and "no_active_turn" as success, so the result is not needed, and a failed or timed-out cancel must never fail the run on its own. */
async function cancelSession(session: ClientSession | undefined): Promise<void> {
  if (!session) return;
  await session.cancel({ signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS) }).catch(() => undefined);
}

/**
 * P03.2 (deliverable 1): the one turn classifier, independent of
 * `RunnerContext` — it needs only a `Client` to start the turn against, so a
 * caller that runs before a `RunnerContext` exists (`eve-gateway.ts`'s
 * `checkModel` builds the gateway that *becomes* `ctx.eve`) can drive it
 * directly instead of growing a second copy. `runTurn` below is `ctx`-aware
 * sugar over this: the `eve`-not-running early return, and the one
 * ctx-dependent side effect (pausing the budget). Never rejects: every path
 * resolves a `TurnResult`. Detects a provider limit (`TurnResult.providerLimit`)
 * but never pauses the budget itself — that stays `runTurn`'s call, since
 * pausing needs a workspace and a clock this function is never given.
 */
export async function classifyTurn(client: Client, input: RunTurnInput): Promise<TurnResult> {
  const collectEvents = input.collectEvents ?? false;
  const events: MessageStreamEvent[] = [];
  /** Appends `events` (P04, additive) only for a caller that asked for them; every existing call site's result shape is unchanged. */
  const withEvents = (result: TurnResult): TurnResult => (collectEvents ? { ...result, events } : result);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);

  let session: ClientSession | undefined;
  let tokens = ZERO_TOKENS;
  let model: string | undefined;
  let boundary: MessageStreamEvent | undefined;
  let failure: TurnFailureStreamEvent | undefined;
  let cancelled = false;
  let inputRequests = 0;

  try {
    const created = await client.sessions.create({ message: input.message, signal });
    session = created.session;
    // Event by event (G1): a quietly-ending abort during an open or reconnect never throws here, so the partial
    // usage and model survive it and the signal.aborted check below is what actually catches it.
    for await (const event of created.response) {
      // Round-1 review L11 (nit): only accumulate when the caller actually asked for the events back — otherwise
      // this array grows for the whole turn's duration for nothing, since withEvents never surfaces it either way.
      if (collectEvents) events.push(event);
      switch (event.type) {
        case "step.started":
          model = event.data.modelId;
          break;
        case "step.completed":
          tokens = { input: tokens.input + (event.data.usage?.inputTokens ?? 0), output: tokens.output + (event.data.usage?.outputTokens ?? 0) };
          break;
        case "input.requested":
          inputRequests += event.data.requests.length;
          break;
        case "turn.cancelled":
          cancelled = true;
          break;
        default:
          break;
      }
      if (!failure && isTurnFailureEvent(event)) failure = event;
      if (isCurrentTurnBoundaryEvent(event)) boundary = event;
    }
  } catch (caught) {
    if (!signal.aborted) {
      // Q2 (revision 1, reviewer 2): a session was possibly created before the stream itself threw (a mid-read
      // drop, say); as P03's own route did before this packet, cancel through it here too, not only on the
      // abort path below. cancelSession is a no-op when sessions.create() itself is what threw (session still
      // undefined) — bounded the same way every other cancel in this file is (I3).
      await cancelSession(session);
      return withEvents({ status: "failed", tokens, ...(model !== undefined ? { model } : {}), detail: nonEmptyOrFallback(shorten(errorMessage(caught))) });
    }
    // An abort while an open stream is being read does throw (eve-runtime.md §8 item 15); fall through to the
    // signal.aborted branch below with whatever partial usage/model was read before it.
  }

  const partial = { tokens, ...(model !== undefined ? { model } : {}) };

  if (signal.aborted) {
    await cancelSession(session);
    return withEvents({ status: "timeout", ...partial, detail: `No answer within ${timeoutMs / 1000} s.` });
  }

  if (failure) {
    const providerLimit = isProviderLimitFailure(failure);
    const detail = providerLimit ? `${PROVIDER_LIMIT_REASON} (${shorten(failure.data.message)})` : `${failure.data.code}: ${shorten(failure.data.message)}`;
    return withEvents({ status: "failed", ...partial, detail, providerLimit });
  }

  if (cancelled) return withEvents({ status: "cancelled", ...partial, detail: "The turn was cancelled before it finished." });

  if (!boundary) {
    // Not aborted, no failure event, yet the stream ended with no boundary event: never call this "ok" (G1).
    // Q2 (revision 1, reviewer 2): cancel through the session here too, as P03's route did — a quiet, boundary-
    // less end is exactly the failure mode a stalled eve produces, so leaving nothing to cancel would be
    // trusting the very quiet-end behaviour G1 exists not to trust.
    await cancelSession(session);
    return withEvents({ status: "failed", ...partial, detail: "The turn ended without a result." });
  }

  if (inputRequests > 0) {
    await cancelSession(session);
    return withEvents({ status: "parked", ...partial, detail: "The model asked for input instead of finishing the run." });
  }

  // A session.waiting (conversation) or session.completed (task) boundary with no failure, no cancellation, no
  // input request and no abort: the turn finished.
  return withEvents({ status: "ok", ...partial });
}

/**
 * One eve session turn, for use inside a `withRun` body. Never retries — a
 * detected provider limit pauses the budget itself by default (so `withRun`
 * needs no special case) and fails this turn; the caller is expected to
 * stop, not call `runTurn` again for the same run. Set
 * `pauseBudgetOnProviderLimit: false` to skip that (see `RunTurnInput`).
 * Never rejects: every path resolves a `TurnResult`.
 */
export async function runTurn(ctx: RunnerContext, input: RunTurnInput): Promise<TurnResult> {
  const eve = ctx.eve;
  if (!eve) {
    const notRunning: TurnResult = { status: "failed", tokens: ZERO_TOKENS, detail: "eve is not running." };
    return (input.collectEvents ?? false) ? { ...notRunning, events: [] } : notRunning;
  }
  const result = await classifyTurn(eve.client, input);
  if (result.providerLimit && (input.pauseBudgetOnProviderLimit ?? true)) {
    await pauseBudget(ctx.workspace, ctx.clock, PROVIDER_LIMIT_REASON);
  }
  return result;
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
 * I2: the in-memory failure record `withRun` resolves with when the run never started. It is never written: either
 * nothing can be written (the run folder is unwritable) or the input can't make a valid record (an empty key).
 */
function notStartedRecord(ctx: RunnerContext, runId: string, input: WithRunInput, inputs: Record<string, unknown>, error: string): RunRecord {
  const now = ctx.clock.now().toISOString();
  return {
    runId,
    kind: input.kind,
    isCatchUp: input.isCatchUp,
    inputs,
    idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey : "",
    outcome: "failure",
    model: NO_MODEL,
    tokens: ZERO_TOKENS,
    durationMs: 0,
    startedAt: now,
    finishedAt: now,
    error,
  };
}

/**
 * Inside the budget lock (G4): reads the budget, then either writes the one-shot `paused` refusal record or the
 * crash-safe start placeholder. Any rejection here (the record can't be written) is `withRun`'s to catch.
 */
async function decideAndRecordStart(ctx: RunnerContext, runId: string, input: WithRunInput, baseInputs: Record<string, unknown>): Promise<RunDecision> {
  const state = await getBudgetState(ctx.workspace, ctx.clock); // never throws (I2)
  const refusal = state.paused ? (state.pausedReason ?? "paused") : state.runsUsedToday >= state.dailyRunLimit ? `daily run limit reached (${state.dailyRunLimit})` : undefined;
  if (refusal !== undefined) {
    const record = await writePausedRun(ctx.workspace, ctx.clock, {
      runId,
      kind: input.kind,
      isCatchUp: input.isCatchUp,
      idempotencyKey: input.idempotencyKey,
      inputs: baseInputs,
      reason: refusal,
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
}

/**
 * Runs one budgeted, logged run. Resolves with the run's record and never
 * rejects (decision 3), on every path:
 *
 * - An empty or whitespace-only `idempotencyKey` is refused first, before
 *   anything is read or written: logged, `body` never called, resolved with
 *   an in-memory `failure` record carrying `EMPTY_IDEMPOTENCY_KEY_ERROR` (I2).
 * - Paused (any `pauseKind`, including the synthetic corrupt-file and
 *   unreadable-run-log pauses) or at the daily limit: a one-shot `paused`
 *   record with the reason, and `body` is never called.
 * - Any error before the body — the refusal record or the start placeholder
 *   can't be written, say — is caught and logged, and `withRun` resolves with
 *   an in-memory `failure` record carrying `RUN_NOT_STARTED_ERROR` (I2).
 * - Otherwise: the crash-safe start placeholder, then `body`, accumulating
 *   its turns' tokens and model id, then the final record in a `finally`. A
 *   thrown body error, an empty error text, and a `finishRun` that fails
 *   its own schema validation all still resolve with a record (G2).
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

  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length === 0) {
    ctx.log.error(`withRun: refused a ${input.kind} run with an empty idempotencyKey (${runId}); the body was not called.`);
    return notStartedRecord(ctx, runId, input, baseInputs, EMPTY_IDEMPOTENCY_KEY_ERROR);
  }

  let decision: RunDecision;
  try {
    decision = await withBudgetLock(ctx.workspace, () => decideAndRecordStart(ctx, runId, input, baseInputs));
  } catch (caught) {
    ctx.log.error(`withRun: the ${input.kind} run ${runId} did not start (${errorMessage(caught) || "no error message"}); resolving with an in-memory failure record.`);
    return notStartedRecord(ctx, runId, input, baseInputs, RUN_NOT_STARTED_ERROR);
  }

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
    // At least one turn went to eve, but no step ever named the model (a turn that timed out before its first
    // step, say): "unknown", not "n/a", so the Runs page still shows the run's duration and tokens (I3, nit 8).
    if (model === NO_MODEL && turns.length > 0) model = UNKNOWN_MODEL;
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
      ...(outcome === "failure" ? { error: nonEmptyOrFallback(error === undefined ? undefined : shorten(error)) } : {}),
    };
    try {
      finalRecord = await finishRun(ctx.workspace, ctx.clock, finishInput);
    } catch (validationError) {
      ctx.log.error(`withRun: finishRun failed for ${runId} (${errorMessage(validationError) || "no error message"}); writing a minimal failure record instead.`);
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
        ctx.log.error(`withRun: the minimal failure record also failed to write for ${runId} (${errorMessage(minimalError) || "no error message"}); resolving with an in-memory record only.`);
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
          durationMs: Math.max(0, Date.parse(now) - Date.parse(startedAt)),
          startedAt,
          finishedAt: now,
          error: MINIMAL_FINISH_ERROR,
        };
      }
    }
  }
  return finalRecord;
}
