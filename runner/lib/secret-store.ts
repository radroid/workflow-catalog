import { spawn } from "node:child_process";

/**
 * Provider API keys live in the OS credential store, never in the workspace,
 * the repo or runner/.env.local (mvp-spec §7.4).
 *
 * Why not eve's own keychain entries: under `eve start` (mode A) eve reads a
 * provider key only from the server environment; its keychain entries
 * (service "eve") are read only inside `eve dev`
 * (eve/dist/src/internal/model-auth/api-key.js). So the runner keeps the key
 * under its own service name and `npm run runner` hands it to the eve process
 * as OPENAI_API_KEY / ANTHROPIC_API_KEY / AI_GATEWAY_API_KEY, in memory only.
 *
 * Entries use the same encoding as the store eve bundles (just-secrets,
 * eve/dist/src/compiled/just-secrets): service and account are
 * "secrets:v1:" + base64(utf8), and so is the value. That lets `setup --forget`
 * find and remove eve's entries too, and keeps both tools readable by each
 * other's conventions.
 *
 *   macOS  /usr/bin/security, login keychain
 *   Linux  /usr/bin/secret-tool (Secret Service), attributes
 *          application=secrets service=<enc> name=<enc>
 *   other  unavailable: set the key in the environment instead
 */
export const RUNNER_SECRET_SERVICE = "workflow-catalog-runner";
export const EVE_SECRET_SERVICE = "eve";
/** Every name eve 0.63.0 stores under service "eve" (model-auth/store.js, openai/chatgpt/credential-store.js). */
export const EVE_SECRET_NAMES = ["chatgpt", "openai-key", "anthropic-key", "ai-gateway-key", "vercel"] as const;

export type ApiKeyProvider = "openai" | "anthropic" | "gateway";
export const API_KEY_SECRET_NAME: Readonly<Record<ApiKeyProvider, string>> = {
  openai: "openai-key",
  anthropic: "anthropic-key",
  gateway: "ai-gateway-key",
};
/** The variables eve reads under `eve start` (model-auth/api-key.js KEY_ENV). */
export const API_KEY_ENV: Readonly<Record<ApiKeyProvider, string>> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gateway: "AI_GATEWAY_API_KEY",
};

export const MAX_SECRET_BYTES = 2560;

export class SecretStoreError extends Error {
  override readonly name = "SecretStoreError";
}

export interface SecretStore {
  /** "macos-keychain", "secret-service", "memory" or "unavailable". */
  readonly kind: string;
  readonly available: boolean;
  get(service: string, name: string): Promise<string | null>;
  /** Presence only; never reads the value where the platform allows that. */
  has(service: string, name: string): Promise<boolean>;
  set(service: string, name: string, value: string): Promise<void>;
  /** True when an entry was removed. */
  delete(service: string, name: string): Promise<boolean>;
}

const PREFIX = "secrets:v1:";

export function encodeSecretField(value: string): string {
  return PREFIX + Buffer.from(value, "utf8").toString("base64");
}

export function decodeSecretField(encoded: string): string {
  if (!encoded.startsWith(PREFIX)) throw new SecretStoreError("The stored secret is not in the expected format.");
  const body = encoded.slice(PREFIX.length);
  const bytes = Buffer.from(body, "base64");
  if (bytes.length > MAX_SECRET_BYTES || bytes.toString("base64") !== body) {
    throw new SecretStoreError("The stored secret is not in the expected format.");
  }
  return bytes.toString("utf8");
}

function checkField(label: string, value: string, max: number): void {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()) throw new SecretStoreError(`${label} must be non-empty text.`);
  if (Buffer.byteLength(value, "utf8") > max) throw new SecretStoreError(`${label} is longer than ${max} bytes.`);
}

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (command: string, args: readonly string[], input?: string) => Promise<RunResult>;

/** Runs a credential tool without a shell. Output stays in memory and is never logged. */
export const runCommand: CommandRunner = (command, args, input = "") =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new SecretStoreError("The OS credential tool timed out. Unlock your keychain and retry."));
    }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new SecretStoreError(`Could not start ${command}: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
    child.stdin.end(input);
  });

const MACOS_SECURITY = "/usr/bin/security";
const MACOS_KEYCHAIN = "login.keychain-db";
/** errSecItemNotFound, as the security CLI's exit status. */
const MACOS_NOT_FOUND = 44;

function quoteForSecurityInteractive(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function createMacosKeychainStore(run: CommandRunner = runCommand): SecretStore {
  const selector = (service: string, name: string) => ["-s", encodeSecretField(service), "-a", encodeSecretField(name)];
  const fail = (result: RunResult): never => {
    throw new SecretStoreError(
      result.code === 36 || result.code === 128
        ? "The login keychain is locked or access was denied. Unlock it and retry."
        : "The macOS keychain operation failed. Unlock your login keychain and retry.",
    );
  };
  return {
    kind: "macos-keychain",
    available: true,
    async get(service, name) {
      checkField("service", service, 256);
      checkField("name", name, 256);
      const result = await run(MACOS_SECURITY, ["-q", "find-generic-password", ...selector(service, name), "-w", MACOS_KEYCHAIN]);
      if (result.code === MACOS_NOT_FOUND) return null;
      if (result.code !== 0) return fail(result);
      return decodeSecretField(result.stdout.replace(/\n$/u, ""));
    },
    async has(service, name) {
      checkField("service", service, 256);
      checkField("name", name, 256);
      // Without -w the tool prints attributes only, so the value is never read.
      const result = await run(MACOS_SECURITY, ["-q", "find-generic-password", ...selector(service, name), MACOS_KEYCHAIN]);
      if (result.code === MACOS_NOT_FOUND) return false;
      if (result.code !== 0) return fail(result);
      return true;
    },
    async set(service, name, value) {
      checkField("service", service, 256);
      checkField("name", name, 256);
      checkField("value", value, MAX_SECRET_BYTES);
      // Through `security -i` on stdin, so the value never appears in a process argument list.
      const command = ["add-generic-password", "-U", ...selector(service, name), "-w", encodeSecretField(value), MACOS_KEYCHAIN]
        .map(quoteForSecurityInteractive)
        .join(" ");
      const result = await run(MACOS_SECURITY, ["-q", "-i"], `${command}\n`);
      if (result.code !== 0 || result.stderr !== "") fail(result);
    },
    async delete(service, name) {
      checkField("service", service, 256);
      checkField("name", name, 256);
      const result = await run(MACOS_SECURITY, ["-q", "delete-generic-password", ...selector(service, name), MACOS_KEYCHAIN]);
      if (result.code === MACOS_NOT_FOUND) return false;
      if (result.code !== 0) return fail(result);
      return true;
    },
  };
}

const LINUX_SECRET_TOOL = "/usr/bin/secret-tool";

export function createLinuxSecretServiceStore(run: CommandRunner = runCommand): SecretStore {
  const attributes = (service: string, name: string) => ["application", "secrets", "service", encodeSecretField(service), "name", encodeSecretField(name)];
  const fail = (): never => {
    throw new SecretStoreError("The Secret Service operation failed. Make sure secret-tool is installed and your keyring is unlocked.");
  };
  const lookup = async (service: string, name: string): Promise<string | null> => {
    const result = await run(LINUX_SECRET_TOOL, ["lookup", "--", ...attributes(service, name)]);
    // secret-tool exits 1 with no output at all when nothing matches.
    if (result.code === 1 && result.stdout === "" && result.stderr === "") return null;
    if (result.code !== 0) return fail();
    return decodeSecretField(result.stdout);
  };
  return {
    kind: "secret-service",
    available: true,
    async get(service, name) {
      checkField("service", service, 256);
      checkField("name", name, 256);
      return lookup(service, name);
    },
    async has(service, name) {
      checkField("service", service, 256);
      checkField("name", name, 256);
      return (await lookup(service, name)) !== null;
    },
    async set(service, name, value) {
      checkField("service", service, 256);
      checkField("name", name, 256);
      checkField("value", value, MAX_SECRET_BYTES);
      const result = await run(LINUX_SECRET_TOOL, ["store", "--label=secrets", "--", ...attributes(service, name)], encodeSecretField(value));
      if (result.code !== 0) fail();
    },
    async delete(service, name) {
      checkField("service", service, 256);
      checkField("name", name, 256);
      if ((await lookup(service, name)) === null) return false;
      const result = await run(LINUX_SECRET_TOOL, ["clear", "--", ...attributes(service, name)]);
      if (result.code !== 0) fail();
      return true;
    },
  };
}

export function createUnavailableStore(reason: string): SecretStore {
  const refuse = async (): Promise<never> => {
    throw new SecretStoreError(reason);
  };
  return { kind: "unavailable", available: false, get: refuse, has: async () => false, set: refuse, delete: async () => false };
}

/** The OS store for this platform. */
export function createOsSecretStore(platform: NodeJS.Platform = process.platform): SecretStore {
  if (platform === "darwin") return createMacosKeychainStore();
  if (platform === "linux") return createLinuxSecretServiceStore();
  return createUnavailableStore(
    "No supported OS credential store on this platform. Set the provider's API key in the environment that runs `npm run runner` instead.",
  );
}

/** An in-memory store for tests. */
export class MemorySecretStore implements SecretStore {
  readonly kind = "memory";
  readonly available = true;
  readonly entries = new Map<string, string>();

  #key(service: string, name: string): string {
    return `${service}\u0000${name}`;
  }

  async get(service: string, name: string): Promise<string | null> {
    return this.entries.get(this.#key(service, name)) ?? null;
  }

  async has(service: string, name: string): Promise<boolean> {
    return this.entries.has(this.#key(service, name));
  }

  async set(service: string, name: string, value: string): Promise<void> {
    checkField("value", value, MAX_SECRET_BYTES);
    this.entries.set(this.#key(service, name), value);
  }

  async delete(service: string, name: string): Promise<boolean> {
    return this.entries.delete(this.#key(service, name));
  }
}
