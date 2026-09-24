import { Client, type MessageStreamEvent } from "eve/client";
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
 * pattern applies here exactly as it does to a run's own turns). It calls
 * `classifyTurn` directly, rather than the ctx-aware `runTurn`, because this
 * gateway is built *before* a `RunnerContext` exists — this object becomes
 * `ctx.eve` — so there is no workspace/clock to pause a budget with here.
 * That is also the chosen behaviour, not just a plumbing accident: a model
 * check is a single, manual, foreground action that never goes through
 * `withRun`, so a provider limit hit during one never pauses the budget
 * (see the packet report for the full reasoning).
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

/**
 * P03.2 (deliverable 1): a thin adapter over `classifyTurn`'s `TurnResult` —
 * it does no turn classification of its own (that guarantee is `runTurn`'s
 * alone; see run-harness.ts). A good check is an "ok" turn whose reply
 * includes "ok"; any other status (a real failure, a provider limit, a
 * cancel, a timeout, or an unexpected park) is reported with `runTurn`'s own
 * detail, which already reads well standing alone here.
 */
export function interpretModelCheck(result: Pick<TurnResult, "status" | "detail" | "events">): { ok: boolean; detail?: string } {
  if (result.status !== "ok") return { ok: false, detail: shorten(result.detail ?? `The check did not complete ("${result.status}").`) };
  const reply = lastReplyText(result.events ?? []);
  if (!reply.trim().toLowerCase().includes("ok")) return { ok: false, detail: "The model answered, but not with the expected reply." };
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
    async checkModel(timeoutMs = 90_000) {
      // eve-runtime.md §8 item 15, via the shared classifier: reads the stream event by event rather than trusting
      // response.result() (which resolves "completed" for a turn that quietly never finished), and cancels through
      // the session on a timeout or an unexpected park, never MessageResponse.cancel().
      const result = await classifyTurn(client, { message: MODEL_CHECK_PROMPT, timeoutMs, collectEvents: true });
      return { ...interpretModelCheck(result), modelId: await modelId() };
    },
  };
}
