import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { ModelSettings } from "../agent/lib/model.ts";
import { writeJsonAtomic, readJsonFile } from "../store/atomic.ts";
import { EVE_PIN } from "./package-info.ts";
import { ADAPTER_DIR, EVE_OUTPUT_DIR, JOB_ASSISTANT_DIR, RUNNER_DIR } from "./paths.ts";

/**
 * Builds for mode A (eve-spike.md): the adapter first (`eve extension build`,
 * after copying the package's skills into it), then the runner (`eve build`).
 * `npm run runner` rebuilds only when something the build depends on changed:
 * a stamp in .output/ records a hash of the sources plus the provider and
 * model, because eve records the build-time model id as metadata.
 */
export const BUILD_STAMP_FILE = path.join(EVE_OUTPUT_DIR, ".runner-build-stamp.json");

export function eveCli(packageDir: string): string {
  return path.join(packageDir, "node_modules", "eve", "bin", "eve.js");
}

export interface RunOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Prefix for each output line, e.g. "[build] ". Output goes to this terminal only, never to a file. */
  readonly prefix?: string;
}

/** Runs node with `args`, streaming prefixed output. Rejects on a non-zero exit. */
export function runNode(args: readonly string[], options: RunOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    const prefix = options.prefix ?? "";
    createInterface({ input: child.stdout }).on("line", (line) => process.stdout.write(`${prefix}${line}\n`));
    createInterface({ input: child.stderr }).on("line", (line) => process.stderr.write(`${prefix}${line}\n`));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(args[0] ?? "node")} ${args.slice(1).join(" ")} failed (${signal ?? `exit ${code}`}).`));
    });
  });
}

/** Copies the package skills into the adapter, then `eve extension build`. */
export async function buildAdapter(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await runNode([path.join(ADAPTER_DIR, "scripts", "sync-skills.mjs")], { cwd: ADAPTER_DIR, env, prefix: "[adapter] " });
  await runNode([eveCli(ADAPTER_DIR), "extension", "build"], { cwd: ADAPTER_DIR, env, prefix: "[adapter] " });
}

/** `eve build` for the runner. `env` must carry the model settings: eve evaluates agent.ts while compiling. */
export async function buildRunner(env: NodeJS.ProcessEnv): Promise<void> {
  await runNode([eveCli(RUNNER_DIR), "build"], { cwd: RUNNER_DIR, env, prefix: "[build] " });
}

const IGNORED_DIRS = new Set(["node_modules", ".eve", ".output", ".nitro", "dist", ".git"]);

async function hashTree(hash: ReturnType<typeof createHash>, root: string, relative = ""): Promise<void> {
  let entries;
  try {
    entries = await readdir(path.join(root, relative), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) await hashTree(hash, root, child);
    } else if (entry.isFile()) {
      hash.update(`${child}\0`);
      hash.update(await readFile(path.join(root, child)));
      hash.update("\0");
    }
  }
}

/** Everything a build depends on: the agent, the adapter source, the package skills, the manifests, the model. */
export async function computeBuildStamp(model: ModelSettings): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`eve ${EVE_PIN}\0${model.provider}\0${model.model}\0`);
  await hashTree(hash, path.join(RUNNER_DIR, "agent"));
  await hashTree(hash, path.join(ADAPTER_DIR, "extension"));
  await hashTree(hash, path.join(JOB_ASSISTANT_DIR, "skills"));
  for (const file of [path.join(RUNNER_DIR, "package.json"), path.join(ADAPTER_DIR, "package.json"), path.join(RUNNER_DIR, "tsconfig.json")]) {
    hash.update(`${file}\0`);
    hash.update(await readFile(file).catch(() => Buffer.alloc(0)));
  }
  return hash.digest("hex");
}

/** True when .output/ is missing, or was built from different sources or a different model. */
export async function needsBuild(stamp: string): Promise<boolean> {
  const built = await stat(path.join(EVE_OUTPUT_DIR, "server", "index.mjs")).then(
    () => true,
    () => false,
  );
  if (!built) return true;
  const recorded = (await readJsonFile(BUILD_STAMP_FILE).catch(() => undefined)) as { stamp?: unknown } | undefined;
  return recorded?.stamp !== stamp;
}

export async function recordBuildStamp(stamp: string): Promise<void> {
  await writeJsonAtomic(BUILD_STAMP_FILE, { stamp, builtAt: new Date().toISOString() });
}
