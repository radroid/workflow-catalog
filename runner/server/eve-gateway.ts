import { Client } from "eve/client";

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
      try {
        const result = await client.health();
        return { ok: result.ok === true && result.status === "ready" };
      } catch (error) {
        return { ok: false, detail: shorten((error as Error).message) };
      }
    },
    modelId,
    async checkModel(timeoutMs = 90_000) {
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const { response } = await client.sessions.create({ message: MODEL_CHECK_PROMPT, signal });
        const result = await response.result();
        const id = await modelId();
        if (result.status !== "completed") {
          // step.failed / turn.failed / session.failed carry { code, message }.
          const failure = result.events.find(
            (event) => event.type === "step.failed" || event.type === "turn.failed" || event.type === "session.failed",
          );
          const reason = failure && "data" in failure ? (failure.data as { code?: string; message?: string }) : undefined;
          const detail = reason?.message ? `${reason.code ? `${reason.code}: ` : ""}${reason.message}` : `The turn ended as "${result.status}".`;
          return { ok: false, modelId: id, detail: shorten(detail) };
        }
        const text = (result.message ?? "").trim().toLowerCase();
        if (!text.includes("ok")) return { ok: false, modelId: id, detail: "The model answered, but not with the expected reply." };
        return { ok: true, modelId: id };
      } catch (error) {
        return { ok: false, detail: shorten(signal.aborted ? `No answer within ${timeoutMs / 1000} s.` : (error as Error).message) };
      }
    },
  };
}
