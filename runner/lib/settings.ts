import { ModelSettingsError, readModelSettings, type ModelSettings } from "../agent/lib/model.ts";
import { readEnvFile } from "./env-file.ts";
import { ENV_FILE } from "./paths.ts";

/**
 * The install's settings, all in runner/.env.local (written by `npm run
 * setup`). `eve start` loads the same file, and a variable already set in the
 * environment wins over the file, as it does in eve — with one exception:
 * the workspace (`RUNNER_WORKSPACE`, ENV.workspace). GitHub Actions sets
 * that variable in every job, and a leftover shell export could set another,
 * so once `npm run setup` has written a workspace to .env.local, the file
 * always wins for that one key: an ambient value can never silently
 * redirect a set-up runner to a different workspace (P02.2). Before setup
 * has written one — a first run, or a test that points at an empty
 * envFile — the environment still supplies it, same as every other key.
 * `loadSettings` implements the exception; `doctor` warns when the two
 * disagree (lib/doctor.ts).
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
  /**
   * The merged values: .env.local, then the process environment on top —
   * except the workspace key, where .env.local wins once it has one (see
   * the header comment and loadSettings).
   */
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
  /**
   * Set by `loadSettings` when an ambient `RUNNER_WORKSPACE` names a
   * different workspace than .env.local's and was overridden by it.
   * Undefined when they agree, when there is no ambient value, or when
   * .env.local has no workspace yet (then the environment supplies
   * `workspace` rather than being overridden — not a mismatch). `doctor`'s
   * one warning (lib/doctor.ts) reads this.
   */
  readonly workspaceEnvOverride?: string;
}

export interface LoadSettingsOptions {
  readonly envFile?: string;
  /** Defaults to process.env. Tests pass {}. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** `undefined` for a missing or blank value; trimmed otherwise. */
export function trimmedText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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
  return {
    values,
    envFileFound,
    model,
    modelError,
    routePassword: secret(ENV.routePassword),
    uiToken: secret(ENV.uiToken),
    workspace: trimmedText(values[ENV.workspace]),
    codexDir: trimmedText(values[ENV.codexDir]),
    privacy: {
      telemetryDisabled: values[ENV.telemetryDisabled] === PRIVACY_ENV.EVE_TELEMETRY_DISABLED,
      tracesOff: values[ENV.tracesContent] === PRIVACY_ENV.EVE_TRACES_CONTENT,
    },
  };
}

export async function loadSettings(options: LoadSettingsOptions = {}): Promise<RunnerSettings> {
  const file = await readEnvFile(options.envFile ?? ENV_FILE);
  const envFileFound = Object.keys(file).length > 0;
  const env = options.env ?? process.env;
  const merged: Record<string, string> = { ...file };
  for (const key of Object.keys(file).concat(Object.values(ENV))) {
    // The workspace is the one exception (see the header comment): resolved
    // below, file-first, instead of letting the environment win here.
    if (key === ENV.workspace) continue;
    const value = env[key];
    if (value !== undefined) merged[key] = value;
  }

  const fileWorkspace = trimmedText(file[ENV.workspace]);
  const envWorkspace = trimmedText(env[ENV.workspace]);
  let workspaceEnvOverride: string | undefined;
  if (fileWorkspace !== undefined) {
    // Setup has already written a workspace: it wins, always. Only note the
    // ambient value for doctor's warning; never let it through.
    merged[ENV.workspace] = fileWorkspace;
    if (envWorkspace !== undefined && envWorkspace !== fileWorkspace) workspaceEnvOverride = envWorkspace;
  } else if (envWorkspace !== undefined) {
    // No workspace on file yet (a first run, or a test): the environment
    // supplies it, same as every other key.
    merged[ENV.workspace] = envWorkspace;
  }

  return { ...settingsFromValues(merged, envFileFound), workspaceEnvOverride };
}
