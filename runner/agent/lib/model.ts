import { gateway, type LanguageModel } from "ai";
import { anthropic } from "eve/models/anthropic";
import { chatgpt, openai } from "eve/models/openai";

/**
 * The runner's model comes from settings, read when the module is evaluated:
 * once at `eve build` (compile) and again when `eve start` loads the built
 * server. It is never inlined into the build output. `npm run setup` writes
 * the settings into runner/.env.local, which `eve start` loads.
 *
 *   RUNNER_MODEL_PROVIDER  chatgpt | openai | anthropic | gateway
 *   RUNNER_MODEL           the model slug (chatgpt, openai, anthropic) or a
 *                          gateway model id such as "openai/gpt-5.6-terra"
 *
 * Every branch returns a live AI SDK LanguageModel, never a bare gateway
 * string. eve treats an agent config with a direct-provider model as a
 * runtime entry that the server evaluates again at start, while a static
 * gateway string would be compiled into the build (eve docs,
 * reference/typescript-api.md "Authored module lifecycle"). Checked on
 * 0.63.0: the model call uses the value read at start. The build still
 * records the build-time model id as metadata (`/eve/v1/info`,
 * .eve/agent-summary.json), so `npm run runner` rebuilds whenever the
 * provider or model differs from the last build (cli/runner.ts build stamp).
 *
 * ChatGPT has no default slug on purpose: eve's default, gpt-5.6-luna-fast,
 * is rejected for ChatGPT accounts (docs/spec/research/eve-spike.md). Setup
 * records an explicit slug and `npm run doctor` reports whether it was
 * verified.
 */
export const MODEL_PROVIDERS = ["chatgpt", "openai", "anthropic", "gateway"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export interface ModelSettings {
  readonly provider: ModelProvider;
  readonly model: string;
}

export class ModelSettingsError extends Error {
  override readonly name = "ModelSettingsError";
}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function isModelProvider(value: unknown): value is ModelProvider {
  return typeof value === "string" && (MODEL_PROVIDERS as readonly string[]).includes(value);
}

/** Reads and validates the model settings. Throws ModelSettingsError with the fix when they are missing or malformed. */
export function readModelSettings(env: Readonly<Record<string, string | undefined>>): ModelSettings {
  const provider = env.RUNNER_MODEL_PROVIDER?.trim();
  const model = env.RUNNER_MODEL?.trim();
  if (!provider || !model) {
    throw new ModelSettingsError(
      "No model is configured (RUNNER_MODEL_PROVIDER and RUNNER_MODEL are unset). Run `npm run setup` in runner/.",
    );
  }
  if (!isModelProvider(provider)) {
    throw new ModelSettingsError(
      `RUNNER_MODEL_PROVIDER must be one of ${MODEL_PROVIDERS.join(", ")}; got "${provider}". Run \`npm run setup\` in runner/.`,
    );
  }
  if (!SLUG.test(model)) {
    throw new ModelSettingsError(`RUNNER_MODEL "${model}" is not a model slug. Run \`npm run setup\` in runner/.`);
  }
  if (provider === "gateway" && !model.includes("/")) {
    throw new ModelSettingsError(
      `A gateway model id names its provider, for example "openai/gpt-5.6-terra"; got "${model}".`,
    );
  }
  return { provider, model };
}

export function languageModelFor(settings: ModelSettings): LanguageModel {
  switch (settings.provider) {
    case "chatgpt":
      return chatgpt(settings.model);
    case "openai":
      return openai(settings.model);
    case "anthropic":
      return anthropic(settings.model);
    case "gateway":
      return gateway(settings.model);
  }
}

/** The model for agent/agent.ts. */
export function resolveModel(env: Readonly<Record<string, string | undefined>> = process.env): LanguageModel {
  return languageModelFor(readModelSettings(env));
}
