import { evePathEnv } from "./codex.ts";
import { PRIVACY_ENV } from "./settings.ts";

export interface BuildEveEnvOptions {
  readonly processEnv: NodeJS.ProcessEnv;
  /** settings.values (lib/settings.ts): the resolved workspace, per loadSettings's precedence, is in here. */
  readonly settingsValues: Readonly<Record<string, string>>;
  readonly codexDir?: string;
}

/**
 * eve's child environment (revision 1, W4): `processEnv` first,
 * `settingsValues` on top, so the resolved workspace — and every other
 * setting — wins even though an ambient `RUNNER_WORKSPACE` may still be in
 * `processEnv`. eve's tools and the bridge always agree, on the resolved
 * folder, never an ambient one. The privacy switches go on top of that, and
 * `PATH` puts codex first. `PORT`/`HOST` are stripped: eve is given its own
 * port on the command line (cli/runner.ts), and would otherwise inherit a
 * stray one from the shell that started `npm run runner`.
 */
export function buildEveEnv(options: BuildEveEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...options.processEnv, ...options.settingsValues, ...PRIVACY_ENV, PATH: evePathEnv(options.codexDir) };
  delete env.PORT;
  delete env.HOST;
  return env;
}
