import { ModelSettingsError, readModelSettings, type ModelSettings } from "../agent/lib/model.ts";
import { readEnvFile } from "./env-file.ts";
import { ENV_FILE } from "./paths.ts";

/**
 * The install's settings, all in runner/.env.local (written by `npm run
 * setup`). `eve start` loads the same file, and a variable already set in the
 * environment wins over the file, as it does in eve.
 */
export const ENV = {
  provider: "RUNNER_MODEL_PROVIDER",
  model: "RUNNER_MODEL",
  routePassword: "ROUTE_AUTH_BASIC_PASSWORD",
  uiToken: "RUNNER_UI_TOKEN",
  workspace: "RUNNER_WORKSPACE",
  codexDir: "RUNNER_CODEX_DIR",
  telemetryDisabled: "EVE_TELEMETRY_DISABLED",
  tracesContent: "EVE_TRACES_CONTENT",
} as const;

/** eve's CLI telemetry is on by default and its local traces keep prompt and reply text by default (mvp-spec §8). */
export const PRIVACY_ENV = { EVE_TELEMETRY_DISABLED: "1", EVE_TRACES_CONTENT: "off" } as const;

export const ENV_ORDER: readonly string[] = [
  ENV.telemetryDisabled,
  ENV.tracesContent,
  ENV.provider,
  ENV.model,
  ENV.codexDir,
  ENV.workspace,
  ENV.routePassword,
  ENV.uiToken,
];

export const ENV_HEADER: readonly string[] = [
  "Written by `npm run setup` for this computer only. It holds secrets (the eve",
  "route password and the local-UI token): never share or commit it (it is",
  "gitignored). Provider API keys are not here; they are in the OS keychain.",
  "Remove everything the runner stored with `npm run setup -- --forget`.",
];

/** Route password and UI token: 32 random bytes, base64url. */
export const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface RunnerSettings {
  /** The merged values: .env.local, then the process environment on top. */
  readonly values: Readonly<Record<string, string>>;
  /** Whether runner/.env.local exists. */
  readonly envFileFound: boolean;
  readonly model?: ModelSettings;
  readonly modelError?: string;
  readonly routePassword?: string;
  readonly uiToken?: string;
  readonly workspace?: string;
  readonly codexDir?: string;
  readonly privacy: { readonly telemetryDisabled: boolean; readonly tracesOff: boolean };
}

export interface LoadSettingsOptions {
  readonly envFile?: string;
  /** Defaults to process.env. Tests pass {}. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export function settingsFromValues(values: Readonly<Record<string, string>>, envFileFound: boolean): RunnerSettings {
  let model: ModelSettings | undefined;
  let modelError: string | undefined;
  try {
    model = readModelSettings(values);
  } catch (error) {
    if (!(error instanceof ModelSettingsError)) throw error;
    modelError = error.message;
  }
  const secret = (key: string) => {
    const value = values[key];
    return value !== undefined && SECRET_PATTERN.test(value) ? value : undefined;
  };
  const text = (key: string) => {
    const value = values[key]?.trim();
    return value ? value : undefined;
  };
  return {
    values,
    envFileFound,
    model,
    modelError,
    routePassword: secret(ENV.routePassword),
    uiToken: secret(ENV.uiToken),
    workspace: text(ENV.workspace),
    codexDir: text(ENV.codexDir),
    privacy: {
      telemetryDisabled: values[ENV.telemetryDisabled] === PRIVACY_ENV.EVE_TELEMETRY_DISABLED,
      tracesOff: values[ENV.tracesContent] === PRIVACY_ENV.EVE_TRACES_CONTENT,
    },
  };
}

export async function loadSettings(options: LoadSettingsOptions = {}): Promise<RunnerSettings> {
  const file = await readEnvFile(options.envFile ?? ENV_FILE);
  const envFileFound = Object.keys(file).length > 0;
  const merged: Record<string, string> = { ...file };
  const env = options.env ?? process.env;
  for (const key of Object.keys(file).concat(Object.values(ENV))) {
    const value = env[key];
    if (value !== undefined) merged[key] = value;
  }
  return settingsFromValues(merged, envFileFound);
}
