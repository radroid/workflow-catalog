import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isModelProvider, MODEL_PROVIDERS, readModelSettings, ModelSettingsError, type ModelProvider, type ModelSettings } from "../agent/lib/model.ts";
import { PairingCodes } from "../store/pairing.ts";
import { Workspace } from "../store/workspace.ts";
import type { Clock } from "./clock.ts";
import type { CodexLoginStatus } from "./codex.ts";
import { randomSecret } from "./crypto.ts";
import { MIN_NODE_MAJOR } from "./doctor.ts";
import { readEnvFile, updateEnvFile } from "./env-file.ts";
import type { Prompter } from "./prompt.ts";
import { API_KEY_ENV, API_KEY_SECRET_NAME, RUNNER_SECRET_SERVICE, type SecretStore } from "./secret-store.ts";
import { ENV, ENV_HEADER, ENV_ORDER, PRIVACY_ENV, SECRET_PATTERN } from "./settings.ts";

/**
 * `npm run setup`: checks Node, chooses the workspace, connects the model
 * provider, writes runner/.env.local and prints a pairing code. Safe to run
 * again: it keeps the workspace, the stored API key and both secrets unless
 * told otherwise.
 */
export const SUGGESTED_CHATGPT_MODEL = "gpt-5.6-luna";
export const DEFAULT_WORKSPACE_NAME = "JobAssistant";

export class SetupError extends Error {
  override readonly name = "SetupError";
}

export interface SetupOptions {
  readonly workspace?: string;
  readonly provider?: string;
  readonly model?: string;
  /** Non-interactive API key: the name of an environment variable holding it. */
  readonly apiKeyEnv?: string;
  /** Never ask; fail when a required value is missing. */
  readonly yes: boolean;
}

export interface SetupDeps {
  readonly envFile: string;
  readonly repoRoot: string;
  readonly homeDir?: string;
  readonly clock: Clock;
  readonly secrets: SecretStore;
  readonly prompter: Prompter;
  readonly out: (line: string) => void;
  readonly findCodex: () => Promise<string | undefined>;
  readonly codexStatus: (codexPath: string) => Promise<CodexLoginStatus>;
  readonly packageVersion: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly nodeVersion?: string;
}

export interface SetupResult {
  readonly workspace: Workspace;
  readonly createdWorkspace: boolean;
  readonly model: ModelSettings;
  readonly providerConnected: boolean;
  readonly pairing: { readonly code: string; readonly expiresAt: Date };
}

// eslint-disable-next-line no-control-regex
const UNSAFE_PATH = /["'`\\$\u0000-\u001f\u007f]/;

function isInsideOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The real path of `target`, following symlinks on the part that exists (/tmp → /private/tmp on macOS). */
export async function realpathNearest(target: string): Promise<string> {
  const rest: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(await realpath(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/** Expands `~`, resolves symlinks, and refuses folders that must never be a workspace. */
export async function checkWorkspacePath(input: string, context: { readonly homeDir: string; readonly repoRoot: string }): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed) throw new SetupError("The workspace folder cannot be empty.");
  const expanded = trimmed === "~" ? context.homeDir : trimmed.startsWith("~/") ? path.join(context.homeDir, trimmed.slice(2)) : trimmed;
  const resolved = await realpathNearest(expanded);
  if (UNSAFE_PATH.test(resolved)) throw new SetupError("Choose a workspace path without quotes, backslashes, `$` or control characters.");
  if (resolved === path.parse(resolved).root) throw new SetupError("The workspace cannot be the root of the disk.");
  if (resolved === (await realpathNearest(context.homeDir))) {
    throw new SetupError("The workspace cannot be your home folder itself; use a folder inside it, such as ~/JobAssistant.");
  }
  if (isInsideOrEqual(await realpathNearest(context.repoRoot), resolved)) {
    throw new SetupError("The workspace cannot be inside the workflow-catalog repository: your data must never sit next to code you might commit.");
  }
  return resolved;
}

function nodeMajor(version: string): number {
  return Number(version.replace(/^v/, "").split(".")[0]);
}

async function chooseProvider(options: SetupOptions, existing: Record<string, string>, prompter: Prompter): Promise<ModelProvider> {
  const current = existing[ENV.provider];
  const candidate = options.provider ?? (options.yes ? (current ?? "chatgpt") : await prompter.ask(`Model provider (${MODEL_PROVIDERS.join(", ")})?`, current ?? "chatgpt"));
  if (!isModelProvider(candidate)) throw new SetupError(`Unknown provider "${candidate}". Choose one of ${MODEL_PROVIDERS.join(", ")}.`);
  return candidate;
}

async function chooseModel(provider: ModelProvider, options: SetupOptions, existing: Record<string, string>, prompter: Prompter): Promise<ModelSettings> {
  const kept = existing[ENV.provider] === provider ? existing[ENV.model] : undefined;
  let model = options.model ?? kept;
  if (!model) {
    if (options.yes) {
      throw new SetupError(
        provider === "chatgpt"
          ? `Pass --model: ChatGPT accounts need an explicit model slug (for example --model ${SUGGESTED_CHATGPT_MODEL}); eve's default is rejected for them.`
          : "Pass --model with the model slug your provider uses.",
      );
    }
    model =
      provider === "chatgpt"
        ? await prompter.ask("ChatGPT model slug? (eve's default does not work with ChatGPT accounts)", SUGGESTED_CHATGPT_MODEL)
        : provider === "gateway"
          ? await prompter.ask("AI Gateway model id (provider/model)?")
          : await prompter.ask(`${provider === "openai" ? "OpenAI" : "Anthropic"} model slug?`);
  }
  try {
    return readModelSettings({ [ENV.provider]: provider, [ENV.model]: model });
  } catch (error) {
    if (error instanceof ModelSettingsError) throw new SetupError(error.message);
    throw error;
  }
}

async function connectChatgpt(deps: SetupDeps): Promise<{ connected: boolean; codexDir?: string }> {
  const codex = await deps.findCodex();
  if (!codex) {
    deps.out("ChatGPT: the Codex CLI was not found on PATH. The runner signs in to ChatGPT through it.");
    deps.out("  Install it (`npm install -g @openai/codex` or `brew install codex`), run `codex login`, then run setup again.");
    deps.out("  (eve's own /login inside `eve dev` also works for development, but `npm run runner` needs codex on PATH.)");
    return { connected: false };
  }
  const codexDir = path.dirname(codex);
  const status = await deps.codexStatus(codex);
  if (status.loggedIn) {
    deps.out(`ChatGPT: signed in through Codex${status.method ? ` (${status.method})` : ""}. Codex keeps that sign-in; the runner stores no ChatGPT credential.`);
    return { connected: true, codexDir };
  }
  deps.out(`ChatGPT: Codex is installed at ${codex} but not signed in (${status.detail}).`);
  deps.out("  Run `codex login` and sign in with your ChatGPT account, then `npm run doctor`.");
  return { connected: false, codexDir };
}

async function connectApiKey(provider: Exclude<ModelProvider, "chatgpt">, options: SetupOptions, deps: SetupDeps): Promise<boolean> {
  const envName = API_KEY_ENV[provider];
  const secretName = API_KEY_SECRET_NAME[provider];
  const env = deps.env ?? process.env;
  const store = deps.secrets;
  let key: string | undefined;
  if (options.apiKeyEnv) {
    key = env[options.apiKeyEnv]?.trim();
    if (!key) throw new SetupError(`--api-key-env ${options.apiKeyEnv}: that environment variable is empty.`);
  }
  if (!key && store.available && (await store.has(RUNNER_SECRET_SERVICE, secretName))) {
    deps.out(`${provider}: an API key is already stored in the ${store.kind === "macos-keychain" ? "macOS keychain" : "OS credential store"}; keeping it.`);
    return true;
  }
  if (!key && !options.yes && store.available) {
    key = (await deps.prompter.askSecret(`Paste your ${provider} API key (input hidden, stored in the OS keychain): `)).trim();
  }
  if (!key) {
    if (env[envName]) {
      deps.out(`${provider}: using ${envName} from the environment each time the runner starts; nothing stored.`);
      return true;
    }
    deps.out(`${provider}: no API key stored. Run setup again in a terminal to enter one, or set ${envName} where you start the runner.`);
    return false;
  }
  if (/\s/.test(key)) throw new SetupError("That API key contains whitespace; paste it again.");
  if (!store.available) {
    throw new SetupError(`No OS credential store is available here, so the key cannot be stored. Set ${envName} in the environment that runs \`npm run runner\` instead.`);
  }
  await store.set(RUNNER_SECRET_SERVICE, secretName, key);
  deps.out(`${provider}: API key stored in the ${store.kind === "macos-keychain" ? "macOS keychain" : "OS credential store"} (never in a file).`);
  return true;
}

export async function runSetup(options: SetupOptions, deps: SetupDeps): Promise<SetupResult> {
  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  if (!(nodeMajor(nodeVersion) >= MIN_NODE_MAJOR)) {
    throw new SetupError(`Node ${nodeVersion} is running; the runner needs Node ${MIN_NODE_MAJOR} or newer (https://nodejs.org).`);
  }
  deps.out(`Node ${nodeVersion}: ok.`);

  const existing = await readEnvFile(deps.envFile);
  const homeDir = deps.homeDir ?? os.homedir();

  // Workspace.
  const suggested = existing[ENV.workspace] ?? path.join(homeDir, DEFAULT_WORKSPACE_NAME);
  const answer = options.workspace ?? (options.yes ? existing[ENV.workspace] : await deps.prompter.ask("Workspace folder (your data lives here)?", suggested));
  if (!answer) throw new SetupError("Pass --workspace <folder>: where the runner keeps your data.");
  const dir = await checkWorkspacePath(answer, { homeDir, repoRoot: deps.repoRoot });
  const { workspace, created } = await Workspace.openOrCreate(dir, { packageVersion: deps.packageVersion, clock: deps.clock });
  deps.out(`Workspace: ${workspace.root} (${created ? "created" : "existing, kept"}).`);

  // Model and provider.
  const provider = await chooseProvider(options, existing, deps.prompter);
  const model = await chooseModel(provider, options, existing, deps.prompter);
  deps.out(`Model: ${model.provider} ${model.model}.`);
  let connected: boolean;
  let codexDir: string | undefined;
  if (provider === "chatgpt") {
    ({ connected, codexDir } = await connectChatgpt(deps));
  } else {
    connected = await connectApiKey(provider, options, deps);
  }

  // Secrets for this install: kept when valid, generated otherwise.
  const keepOrNew = (key: string) => {
    const value = existing[key];
    return value !== undefined && SECRET_PATTERN.test(value) ? value : randomSecret(32);
  };
  await updateEnvFile(
    deps.envFile,
    {
      ...PRIVACY_ENV,
      [ENV.provider]: model.provider,
      [ENV.model]: model.model,
      [ENV.codexDir]: provider === "chatgpt" ? codexDir : undefined,
      [ENV.workspace]: workspace.root,
      [ENV.routePassword]: keepOrNew(ENV.routePassword),
      [ENV.uiToken]: keepOrNew(ENV.uiToken),
    },
    { header: ENV_HEADER, order: ENV_ORDER },
  );
  deps.out(`Settings: written to ${deps.envFile} (private to you; eve telemetry and trace content are off).`);

  const pairing = await new PairingCodes(workspace, deps.clock).issue();
  deps.out("");
  deps.out(`Pairing code: ${pairing.code}`);
  deps.out(`  Enter it on the extension's options page before ${pairing.expiresAt.toLocaleTimeString()} (10 minutes, works once).`);
  deps.out("  Need another later? Run `npm run pair`.");
  deps.out("");
  deps.out("Next: `npm run runner` to start, then `npm run doctor` to check everything.");
  return { workspace, createdWorkspace: created, model, providerConnected: connected, pairing };
}
