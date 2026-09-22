import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * Crash-safe file writes. Every workspace write goes through here: a reader
 * sees the old file or the new one, never a half-written file.
 *
 * writeFileAtomic: write a temp file in the same directory, fsync it, rename
 * it over the target, then fsync the directory so the rename itself is
 * durable. The same directory matters: rename is only atomic within one
 * filesystem.
 */
export interface WriteOptions {
  /** File mode for a new file. Defaults to 0o600: workspace files are personal. */
  readonly mode?: number;
}

function tempPathFor(target: string): string {
  const dir = path.dirname(target);
  return path.join(dir, `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
}

async function writeAndSync(file: string, data: string | Uint8Array, mode: number): Promise<void> {
  // "wx": the temp name is random, and refusing to reuse an existing path
  // means a planted symlink at that name cannot redirect the write.
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, constants.O_RDONLY);
    await handle.sync();
  } catch {
    // Some platforms cannot fsync a directory; the rename is still atomic.
  } finally {
    await handle?.close();
  }
}

export async function writeFileAtomic(target: string, data: string | Uint8Array, options: WriteOptions = {}): Promise<void> {
  const temp = tempPathFor(target);
  try {
    await writeAndSync(temp, data, options.mode ?? 0o600);
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  await syncDirectory(path.dirname(target));
}

/**
 * Creates `target` with `data` only if it does not exist yet, atomically.
 * Returns false, writing nothing, when the file already exists. Two
 * concurrent callers can never both succeed: the final step is link(2),
 * which fails with EEXIST instead of replacing a file the way rename does.
 */
export async function createFileExclusive(target: string, data: string | Uint8Array, options: WriteOptions = {}): Promise<boolean> {
  const temp = tempPathFor(target);
  try {
    await writeAndSync(temp, data, options.mode ?? 0o600);
    try {
      await link(temp, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await unlink(temp).catch(() => undefined);
  }
  await syncDirectory(path.dirname(target));
  return true;
}

export async function writeJsonAtomic(target: string, value: unknown, options: WriteOptions = {}): Promise<void> {
  await writeFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`, options);
}

export async function createJsonExclusive(target: string, value: unknown, options: WriteOptions = {}): Promise<boolean> {
  return createFileExclusive(target, `${JSON.stringify(value, null, 2)}\n`, options);
}

/** Reads and parses a JSON file. Returns undefined when it does not exist. */
export async function readJsonFile(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return JSON.parse(text) as unknown;
}
