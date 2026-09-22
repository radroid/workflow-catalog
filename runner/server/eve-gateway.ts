import { Client, type MessageResult } from "eve/client";

/**
 * The bridge's only way to eve: `eve/client` against `eve start` on
 * 127.0.0.1:3210, with the per-install Basic credential from runner/.env.local.
 * The extension never reaches eve; everything goes through the bridge.
 *
 * `redirect: "manual"` keeps the Authorization header from following a
 * redirect anywhere else (eve docs, guides/client/overview.mdx).
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

type TurnOutcome = Pick<MessageResult, "status" | "events" | "message" | "inputRequests">;

/**
 * Whether a check turn worked. A good turn ends with the session parked for
 * the next message (status "waiting"). A failed model call shows up as
 * step.failed or turn.failed (then "waiting"), or as session.failed
 * (status "failed"); each carries { code, message }.
 */
export function interpretModelCheck(result: TurnOutcome): { ok: boolean; detail?: string } {
  const failure = result.events.find((event) => event.type === "step.failed" || event.type === "turn.failed" || event.type === "session.failed");
  if (failure || result.status === "failed") {
    const reason = failure && "data" in failure ? (failure.data as { code?: string; message?: string }) : undefined;
    const detail = reason?.message ? `${reason.code ? `${reason.code}: ` : ""}${reason.message}` : `The turn ended as "${result.status}".`;
    return { ok: false, detail: shorten(detail) };
  }
  if (result.inputRequests.length > 0) return { ok: false, detail: "The model asked for input instead of answering." };
  if (!(result.message ?? "").trim().toLowerCase().includes("ok")) return { ok: false, detail: "The model answered, but not with the expected reply." };
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
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const { response } = await client.sessions.create({ message: MODEL_CHECK_PROMPT, signal });
        const result = await response.result();
        return { ...interpretModelCheck(result), modelId: await modelId() };
      } catch (error) {
        return { ok: false, detail: shorten(signal.aborted ? `No answer within ${timeoutMs / 1000} s.` : (error as Error).message) };
      }
    },
  };
}
