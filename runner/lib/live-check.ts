import { streamText } from "ai";
import { languageModelFor, type ModelSettings } from "../agent/lib/model.ts";
import { evePathEnv } from "./codex.ts";
import { API_KEY_ENV } from "./secret-store.ts";

/**
 * `npm run doctor -- --live`: one short model call, made directly with the
 * same model factory the agent uses (agent/lib/model.ts), so it needs no
 * running eve. The prompt is fixed and carries no personal data; nothing of
 * the reply is kept except whether it worked.
 */
export const LIVE_CHECK_PROMPT = "Reply with exactly: ok";
export const LIVE_CHECK_INSTRUCTIONS = "You are checking that a model connection works. Follow the request exactly.";

export interface LiveCheckResult {
  readonly ok: boolean;
  readonly detail?: string;
}

export interface LiveCheckOptions {
  /** The provider's API key (openai, anthropic, gateway), from the keychain. Set on this process only. */
  readonly apiKey?: string;
  /** RUNNER_CODEX_DIR, for chatgpt. */
  readonly codexDir?: string;
  readonly timeoutMs?: number;
}

function shorten(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Carried into part B (P10 packet, "the doctor --live failure line", from
 * P03.2's round-3 reviews): a one-line failure reads as one fixed prefix
 * plus a lower-case plain clause everywhere the runner shows one — this is
 * what `server/eve-gateway.ts`'s own detail strings ("the model answered,
 * but not with the expected reply.", "the model asked a question instead of
 * replying.", ...) already do for the Status page's "Check the model"
 * button. `cli/doctor.ts -- --live` used a capitalized "The model
 * answered, ..." and its own "The model check failed: " prefix, which read
 * as two sentences glued together and disagreed with the Status page for
 * what is otherwise the same failure. `formatCheckFailure` is the one
 * prefix both now share.
 */
export function formatCheckFailure(detail: string | undefined): string {
  return `The check failed: ${detail ?? "no detail"}`;
}

export async function liveModelCheck(model: ModelSettings, options: LiveCheckOptions = {}): Promise<LiveCheckResult> {
  if (model.provider !== "chatgpt" && options.apiKey) process.env[API_KEY_ENV[model.provider]] = options.apiKey;
  if (model.provider === "chatgpt") process.env.PATH = evePathEnv(options.codexDir);
  // eve unref()s the `codex app-server` child it spawns for chatgpt(), so a
  // short script must hold its event loop open until the call settles
  // (eve-spike.md "Short scripts must stay alive").
  const keepAlive = setInterval(() => undefined, 1_000);
  const timeoutMs = options.timeoutMs ?? 90_000;
  try {
    // Called the way eve's harness calls a model: streamed, with
    // instructions. ChatGPT's Codex endpoint answers a plain non-streamed
    // call without instructions with "Bad Request" (seen on 0.63.0).
    const result = streamText({
      model: languageModelFor(model),
      instructions: LIVE_CHECK_INSTRUCTIONS,
      prompt: LIVE_CHECK_PROMPT,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    const text = (await result.text).trim().toLowerCase();
    return text.includes("ok") ? { ok: true } : { ok: false, detail: "the model answered, but not with the expected reply." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: shorten(message.includes("aborted") ? `No answer within ${timeoutMs / 1000} s.` : message) };
  } finally {
    clearInterval(keepAlive);
  }
}
