import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

/**
 * The Codex CLI. With provider "chatgpt", eve's chatgpt() spawns
 * `codex app-server` from the eve server's PATH and Codex owns the ChatGPT
 * sign-in (`codex login`; eve-spike.md). Setup records the directory codex was
 * found in (RUNNER_CODEX_DIR) and `npm run runner` puts it first on eve's
 * PATH, next to the directory of the node binary running the runner (an
 * npm-installed codex is a `#!/usr/bin/env node` script).
 */
export interface CodexLoginStatus {
  readonly loggedIn: boolean;
  /** "ChatGPT", "an API key", ...: what codex says it is signed in with. */
  readonly method?: string;
  readonly detail: string;
}

export type CodexStatusRunner = (codexPath: string) => Promise<{ code: number; output: string }>;

/** The first executable called `name` on `pathEnv`, or undefined. */
export async function findOnPath(name: string, pathEnv: string | undefined = process.env.PATH): Promise<string | undefined> {
  const candidates = process.platform === "win32" ? [name, `${name}.cmd`, `${name}.exe`] : [name];
  for (const dir of (pathEnv ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      try {
        await access(full, constants.X_OK);
        return full;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}

/** Runs `codex login status` (read-only; prints no secret). */
export const runCodexLoginStatus: CodexStatusRunner = (codexPath) =>
  new Promise((resolve) => {
    const env = { ...process.env, PATH: [path.dirname(codexPath), path.dirname(process.execPath), process.env.PATH ?? ""].join(path.delimiter) };
    const child = spawn(codexPath, ["login", "status"], { shell: false, stdio: ["ignore", "pipe", "pipe"], env });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, output: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output: Buffer.concat(chunks).toString("utf8") });
    });
  });

/** Interprets `codex login status`: exit 0 and "Logged in using <method>" means signed in. */
export function parseCodexLoginStatus(result: { code: number; output: string }): CodexLoginStatus {
  const line = result.output
    .split(/\r?\n/)
    .map((text) => text.trim())
    .find((text) => /logged in/i.test(text));
  if (result.code === 0 && line && !/not logged in/i.test(line)) {
    const method = /logged in using (.+)$/i.exec(line)?.[1]?.trim();
    return { loggedIn: true, method, detail: line };
  }
  return { loggedIn: false, detail: line ?? (result.output.trim().split(/\r?\n/)[0] || `codex exited with ${result.code}`) };
}

export async function codexLoginStatus(codexPath: string, run: CodexStatusRunner = runCodexLoginStatus): Promise<CodexLoginStatus> {
  return parseCodexLoginStatus(await run(codexPath));
}

/** PATH for the eve process: codex's directory, then node's, then the inherited PATH. */
export function evePathEnv(codexDir: string | undefined, inherited: string | undefined = process.env.PATH): string {
  const parts = [codexDir, path.dirname(process.execPath), ...(inherited ?? "").split(path.delimiter)].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return [...new Set(parts)].join(path.delimiter);
}
