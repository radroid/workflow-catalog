import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { writeFileAtomic } from "../store/atomic.ts";

/**
 * runner/.env.local: read with node:util.parseEnv, the parser eve itself uses
 * for its env files (eve/dist/src/cli/dev/environment.js), so the runner and
 * `eve start` always agree on every value.
 *
 * Written atomically with mode 0600: it holds the eve route password and the
 * local-UI token. It never holds a provider API key (those live in the OS
 * keychain, lib/secret-store.ts).
 */

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BARE_VALUE = /^[A-Za-z0-9_./:@+,=-]*$/;
// Anything a double-quoted dotenv value could reinterpret: quotes, escapes, line breaks, control characters.
// eslint-disable-next-line no-control-regex
const UNSAFE_VALUE = /["\\`\u0000-\u001f\u007f]/;

export class EnvFileError extends Error {
  override readonly name = "EnvFileError";
}

export function parseEnvText(text: string): Record<string, string> {
  const parsed = parseEnv(text);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") out[key] = value;
  return out;
}

/** The file's values, or {} when it does not exist. */
export async function readEnvFile(file: string): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  return parseEnvText(text);
}

export function formatEnvValue(key: string, value: string): string {
  if (!KEY.test(key)) throw new EnvFileError(`Not a valid environment variable name: ${key}`);
  if (UNSAFE_VALUE.test(value)) {
    throw new EnvFileError(`${key} contains a quote, backslash, backtick or control character, which .env.local cannot hold safely.`);
  }
  return BARE_VALUE.test(value) ? `${key}=${value}` : `${key}="${value}"`;
}

/**
 * Serialises `values` with a header. Keys listed in `order` come first, in that
 * order; any other keys (for example one the person added by hand) follow,
 * sorted, so a rewrite never drops them.
 */
export function serializeEnv(values: Record<string, string>, options: { header?: readonly string[]; order?: readonly string[] } = {}): string {
  const order = options.order ?? [];
  const keys = [...order.filter((key) => key in values), ...Object.keys(values).filter((key) => !order.includes(key)).sort()];
  const lines = [...(options.header ?? []).map((line) => (line === "" ? "#" : `# ${line}`)), ...keys.map((key) => formatEnvValue(key, values[key] ?? ""))];
  const text = `${lines.join("\n")}\n`;
  // Belt and braces: what we write must read back identically.
  const reread = parseEnvText(text);
  for (const key of keys) {
    if (reread[key] !== values[key]) throw new EnvFileError(`${key} would not read back unchanged from .env.local.`);
  }
  return text;
}

/** Merges `updates` into the file (undefined deletes a key) and writes it atomically, mode 0600. */
export async function updateEnvFile(
  file: string,
  updates: Record<string, string | undefined>,
  options: { header?: readonly string[]; order?: readonly string[] } = {},
): Promise<Record<string, string>> {
  const next = await readEnvFile(file);
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  await writeFileAtomic(file, serializeEnv(next, options), { mode: 0o600 });
  return next;
}
