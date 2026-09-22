import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Workspace } from "./workspace.ts";

/**
 * D8 (P03 revision 2): the one way a career-profile write happens, from the
 * bridge's routes and from the eve process's tool steps alike. Directive-free
 * (no "use step"/"use workflow"), so both eve app roots and the bridge import
 * it (docs/spec/research/eve-runtime.md §8 item 14).
 *
 * `withProfileLock(workspace, work)` runs `work` (read, reconcile
 * career-profile.md, reduce, write) under two locks:
 *
 * 1. A per-workspace promise chain in this process, the same pattern as
 *    `CommandQueue.#exclusive` (store/commands.ts). The bridge makes a new
 *    ProfileStore per request, so the chain lives in a module-level map keyed
 *    by the workspace root, not on the store instance.
 * 2. A cross-process lock file, `.runner/profile.lock`, created with an
 *    O_EXCL open (`"wx"`). It is held only while `work` runs. A writer that
 *    finds it held retries for at most `waitMs` (about 5 s), then fails with
 *    ProfileBusyError, which the route answers with 503 and
 *    PROFILE_BUSY_MESSAGE. A lock file older than `staleMs` (30 s) was left by
 *    a process that died holding it: it is broken, with a log line.
 *
 * P02 has no cross-process lock to reuse: `createFileExclusive` (atomic.ts)
 * creates a file exclusively but has no wait, staleness or release, so the
 * lock is written here with a plain O_EXCL open.
 */

export const PROFILE_LOCK_SEGMENTS = [".runner", "profile.lock"] as const;
export const PROFILE_BUSY_MESSAGE = "The profile is busy. Try again in a moment.";
export const DEFAULT_LOCK_WAIT_MS = 5_000;
export const DEFAULT_STALE_LOCK_MS = 30_000;
const FIRST_POLL_MS = 20;
const MAX_POLL_MS = 200;

export class ProfileBusyError extends Error {
  override readonly name = "ProfileBusyError";
  constructor() {
    super(PROFILE_BUSY_MESSAGE);
  }
}

export interface ProfileLockOptions {
  /** How long a writer waits for another process's lock before giving up. Default 5 s. */
  readonly waitMs?: number;
  /** A lock file older than this is broken. Default 30 s. */
  readonly staleMs?: number;
  /** Where the stale-lock line goes. Default: console.warn. */
  readonly log?: (message: string) => void;
  /**
   * The in-process chains, keyed by workspace root. Defaults to this module's
   * own map, shared by every ProfileStore in the process. A test passes a
   * fresh map to stand in for a second process.
   */
  readonly chains?: Map<string, Promise<unknown>>;
}

const PROCESS_CHAINS = new Map<string, Promise<unknown>>();

/** Runs `work` after every earlier call with the same key has settled (FIFO), whatever their outcome. */
export function serialise<T>(chains: Map<string, Promise<unknown>>, key: string, work: () => Promise<T>): Promise<T> {
  const tail = chains.get(key) ?? Promise.resolve();
  const run = tail.then(work, work);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, settled);
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return run;
}

interface LockRecord {
  readonly token: string;
  readonly pid: number;
  readonly acquiredAt: string;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function readLockRecord(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/** Creates the lock file exclusively. Returns its token, or undefined when another holder has it. */
async function tryCreate(file: string): Promise<string | undefined> {
  const record: LockRecord = { token: randomUUID(), pid: process.pid, acquiredAt: new Date().toISOString() };
  let handle;
  try {
    handle = await open(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
  } finally {
    await handle.close();
  }
  return record.token;
}

/**
 * Breaks the lock at `file` if it is older than `staleMs`. Re-reads it first
 * and only unlinks the same lock it judged stale, so a lock another process
 * has just re-created is left alone. True when the caller should retry at once.
 */
async function breakIfStale(file: string, staleMs: number, log: (message: string) => void): Promise<boolean> {
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    if (isMissing(error)) return true; // released in the meantime
    throw error;
  }
  const age = Date.now() - info.mtimeMs;
  if (age <= staleMs) return false;
  const before = await readLockRecord(file);
  const again = await stat(file).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (!again) return true;
  if (again.ino !== info.ino || again.mtimeMs !== info.mtimeMs) return true; // someone else broke and re-took it
  await unlink(file).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
  });
  log(`profile.lock was held for ${Math.round(age / 1000)} s, longer than ${Math.round(staleMs / 1000)} s: broke it (${(before ?? "").trim() || "empty lock file"}).`);
  return true;
}

async function release(file: string, token: string): Promise<void> {
  const content = await readLockRecord(file);
  if (content === undefined) return;
  let owner: string | undefined;
  try {
    owner = (JSON.parse(content) as Partial<LockRecord>).token;
  } catch {
    owner = undefined;
  }
  if (owner !== token) return; // broken as stale and re-taken by someone else: not ours to remove
  await unlink(file).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
  });
}

async function acquire(file: string, waitMs: number, staleMs: number, log: (message: string) => void): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  let delay = FIRST_POLL_MS;
  for (;;) {
    const token = await tryCreate(file);
    if (token) return token;
    if (await breakIfStale(file, staleMs, log)) continue;
    const left = deadline - Date.now();
    if (left <= 0) throw new ProfileBusyError();
    await sleep(Math.min(delay, left));
    delay = Math.min(delay * 2, MAX_POLL_MS);
  }
}

/**
 * Runs `work` with this process's chain for the workspace and the
 * cross-process lock file held; see the module comment. Throws
 * ProfileBusyError, without running `work`, when the lock stays held by
 * another process for longer than `waitMs`.
 */
export async function withProfileLock<T>(workspace: Workspace, work: () => Promise<T>, options: ProfileLockOptions = {}): Promise<T> {
  const chains = options.chains ?? PROCESS_CHAINS;
  const waitMs = options.waitMs ?? DEFAULT_LOCK_WAIT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
  const log = options.log ?? ((message: string) => console.warn(`[profile] ${message}`));
  return serialise(chains, workspace.root, async () => {
    const file = await workspace.resolveReal(...PROFILE_LOCK_SEGMENTS);
    const token = await acquire(file, waitMs, staleMs, log);
    try {
      return await work();
    } finally {
      await release(file, token);
    }
  });
}
