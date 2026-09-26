import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

/**
 * Flag parsing for the runner's scripts. Flags go after `--`
 * (`npm run doctor -- --json`), and pnpm passes them straight through
 * (`pnpm --filter @workflow-catalog/runner doctor --json`).
 *
 * `npm run doctor --json` (no `--`) does not pass the flag at all: npm keeps
 * it as its own setting and exposes it as npm_config_json=true. The boolean
 * flags listed in `npmFallback` are read from there too, so both spellings
 * work. Value flags (--workspace, --model, ...) must come after `--`, because
 * npm has settings of those names.
 */
export function parseFlags<T extends ParseArgsOptionsConfig>(
  argv: readonly string[],
  options: T,
  npmFallback: readonly string[] = [],
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | boolean | undefined> {
  const { values } = parseArgs({ args: [...argv], options, strict: true, allowPositionals: false });
  const out: Record<string, string | boolean | undefined> = { ...(values as Record<string, string | boolean | undefined>) };
  for (const flag of npmFallback) {
    if (out[flag] !== undefined) continue;
    const fromNpm = env[`npm_config_${flag.replaceAll("-", "_")}`];
    if (fromNpm === "true") out[flag] = true;
  }
  return out;
}

/** Prints an error without a stack trace and exits 1. */
export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
