import { Client, isTurnFailureEvent, type MessageStreamEvent } from "eve/client";
import { classifyTurn, type TurnResult } from "./run-harness.ts";

/**
 * The bridge's only way to eve: `eve/client` against `eve start` on
 * 127.0.0.1:3210, with the per-install Basic credential from runner/.env.local.
 * The extension never reaches eve; everything goes through the bridge.
 *
 * `redirect: "manual"` keeps the Authorization header from following a
 * redirect anywhere else (eve docs, guides/client/overview.mdx).
 *
 * P03.2 (deliverable 1): `checkModel` runs `run-harness.ts`'s shared
 * `classifyTurn`, not its own copy (eve-runtime.md §8 item 15's quiet-abort
 * pattern applies here exactly as it does to a run's own turns).
 *
 * Why `classifyTurn` rather than the ctx-aware `runTurn` (S3, revision 2,
 * correcting revision 1's reason): this gateway object is built before the
 * `RunnerContext` (`cli/runner.ts` builds it, then hands it in as
 * `ctx.eve`), so its methods hold no ctx. `checkModel` itself, though, only
 * ever runs inside `routes/model.ts`'s `POST /api/model/check`, which has a
 * ctx; nothing forced the split. `classifyTurn` gives the gateway a ctx-free
 * entry point over the `Client` it already owns, so `EveGateway.checkModel`
 * keeps its signature. Not pausing the budget is a separate decision (Q5):
 * neither a model check nor an interactive extraction pauses it, since each
 * is a single, manual, foreground action that never goes through `withRun`;
 * P08-B's carried item revisits that.
 */
export const EVE_HOST = "127.0.0.1";
export const EVE_PORT = 3210;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

export interface EveHealth {
  readonly ok: boolean;
  readonly detail?: string;
}

export interface ModelCheckResult {
  readonly ok: boolean;
  /** The model id eve reports for the running build. */
  readonly modelId?: string;
  /** Why it failed, trimmed. Never contains prompt text: the check prompt is fixed. */
  readonly detail?: string;
}

export interface EveGateway {
  readonly url: string;
  /** The eve client, for later packets that start sessions (onboarding, preparation). */
  readonly client: Client;
  health(): Promise<EveHealth>;
  modelId(): Promise<string | undefined>;
  /** One trivial turn ("Reply with exactly: ok") through eve. Uses the model once. */
  checkModel(timeoutMs?: number): Promise<ModelCheckResult>;
}

export const MODEL_CHECK_PROMPT = "Reply with exactly: ok";

function shorten(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The assistant's own reply text, read off the last `message.completed` event (`classifyTurn`'s `TurnResult` carries no `message` field of its own — only a caller that asked for `collectEvents` gets the raw stream to read one from, the way `onboarding.ts`'s extraction route reads a tool's output). */
function lastReplyText(events: readonly MessageStreamEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "message.completed") return event.data.message ?? "";
  }
  return "";
}

/** The deadline for one model check, when the caller names none. */
export const MODEL_CHECK_TIMEOUT_MS = 90_000;

function seconds(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

/**
 * Q3 (revision 1, critic 3): `classifyTurn`'s own "failed" detail can be a
 * raw eve code and message (`${code}: ${message}`) or an arbitrary thrown
 * error's text — accurate for a log, wrong for a person to read. `events` is
 * already being collected (`checkModel` always passes `collectEvents: true`)
 * for `lastReplyText` below, so re-reading it here to tell "the model itself
 * answered with a failure" (a real `TurnFailureStreamEvent` came back) from
 * "eve or the network never answered at all" (the stream threw, or ended
 * with no boundary, before any such event) is not a second classifier — the
 * ok/failed/cancelled/parked/timeout decision itself stays entirely
 * `classifyTurn`'s; this only chooses which already-honest plain sentence to
 * show for an already-decided "failed".
 *
 * S5 (revision 2, round-2 UI critic issue 1): no sentence here says the
 * check failed. Every place that shows a check's detail already says so
 * first — the Status page as "The check failed: <detail>"
 * (`ui/assets/status.js`) and doctor as "…; the last model check failed:
 * <detail>" (`lib/doctor.ts`) — so revision 1's own "The model check failed: "
 * prefix read twice. Each detail is a clause that follows that colon, so it
 * starts in lower case (S8's rule for a message reused after a colon).
 */
function modelCheckFailureDetail(result: Pick<TurnResult, "detail" | "providerLimit" | "events">): string {
  if (result.providerLimit) return "the model's provider is rate-limited right now. Try again later.";
  if ((result.events ?? []).some(isTurnFailureEvent)) return "the model had a problem answering.";
  return "eve or the network didn't answer.";
}

/**
 * P03.2 (deliverable 1): a thin adapter over `classifyTurn`'s `TurnResult` —
 * it does no turn classification of its own (that guarantee is
 * `classifyTurn`'s alone; see run-harness.ts). A good check is an "ok" turn
 * whose reply includes "ok".
 *
 * Every other outcome is phrased here for a person (Q3: the model's error,
 * the provider's limit, eve or the network not answering, timed out,
 * cancelled, waiting on an input, and no usable result), never with a code,
 * a status or an HTTP number. S8 (revision 2): revision 1 passed
 * `classifyTurn`'s own detail through for "cancelled", "parked" and
 * "timeout", and those say eve's words "turn" and "run" ("The turn was
 * cancelled before it finished.", "…instead of finishing the run.") — they
 * stay as they are there, for run records, and are phrased here instead.
 * Like the "failed" sentences above, each is a lower-case clause that
 * follows "The check failed: " or "the last model check failed: ". The
 * timeout names the deadline this check was given, as the extraction's
 * does (`routes/onboarding.ts`).
 */
export function interpretModelCheck(
  result: Pick<TurnResult, "status" | "detail" | "events" | "providerLimit">,
  timeoutMs: number = MODEL_CHECK_TIMEOUT_MS,
): { ok: boolean; detail?: string } {
  if (result.status === "failed") return { ok: false, detail: modelCheckFailureDetail(result) };
  if (result.status === "cancelled") return { ok: false, detail: "it was cancelled before the model answered." };
  if (result.status === "parked") return { ok: false, detail: "the model asked a question instead of replying." };
  if (result.status === "timeout") return { ok: false, detail: `no answer from the model within ${seconds(timeoutMs)}.` };
  const reply = lastReplyText(result.events ?? []);
  if (!reply.trim().toLowerCase().includes("ok")) return { ok: false, detail: "the model answered, but not with the expected reply." };
  return { ok: true };
}

export function createEveGateway(options: { readonly password: string; readonly host?: string; readonly port?: number }): EveGateway {
  const url = `http://${options.host ?? EVE_HOST}:${options.port ?? EVE_PORT}`;
  const client = new Client({
    host: url,
    auth: { basic: { username: "runner", password: options.password } },
    redirect: "manual",
  });

  async function modelId(): Promise<string | undefined> {
    try {
      const info = await client.info({ signal: AbortSignal.timeout(5_000) });
      return info.agent.model.id;
    } catch {
      return undefined;
    }
  }

  return {
    url,
    client,
    async health() {
      // client.health() takes no abort signal (eve 0.63.0 client.d.ts), so
      // bound the wait here: a hung check must not stall the launcher's
      // startup timeout.
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<EveHealth>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, detail: `No answer within ${HEALTH_CHECK_TIMEOUT_MS / 1000} s.` }), HEALTH_CHECK_TIMEOUT_MS);
      });
      const checked = client.health().then(
        (result): EveHealth => ({ ok: result.ok === true && result.status === "ready" }),
        (error: Error): EveHealth => ({ ok: false, detail: shorten(error.message) }),
      );
      try {
        return await Promise.race([checked, timedOut]);
      } finally {
        clearTimeout(timer);
      }
    },
    modelId,
    async checkModel(timeoutMs = MODEL_CHECK_TIMEOUT_MS) {
      // eve-runtime.md §8 item 15, via the shared classifier: reads the stream event by event rather than trusting
      // response.result() (which resolves "completed" for a turn that quietly never finished), and cancels through
      // the session on a timeout or an unexpected park, never MessageResponse.cancel().
      const result = await classifyTurn(client, { message: MODEL_CHECK_PROMPT, timeoutMs, collectEvents: true });
      return { ...interpretModelCheck(result, timeoutMs), modelId: await modelId() };
    },
  };
}
