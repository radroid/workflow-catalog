import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { workspaceManifestSchema, type WorkspaceManifest } from "@workflow-catalog/contracts";
import { newId } from "../lib/crypto.ts";
import type { Clock } from "../lib/clock.ts";
import { createJsonExclusive, readJsonFile, writeJsonAtomic } from "./atomic.ts";

/**
 * The person's workspace (mvp-spec §5): a folder they own, holding
 * workspace.json and one directory per kind of record. Everything the runner
 * writes about the person goes here, as files they can read and delete.
 *
 *   workspace.json   { workspaceId, workflowInstanceId, packageVersion, createdAt }
 *   sources/ jobs/ applications/ sessions/ runs/ outbox/ inbox/   (§5)
 *   .runner/         the bridge's own state: paired devices, pairing codes,
 *                    local-UI sign-in links, the event journal, the command
 *                    queue, the last model check
 *
 * Every path goes through `resolve`, which refuses anything that would land
 * outside the workspace root.
 */
export const WORKSPACE_MANIFEST_FILE = "workspace.json";
export const WORKSPACE_DIRECTORIES = ["sources", "jobs", "applications", "sessions", "runs", "outbox", "inbox"] as const;
export const RUNNER_STATE_DIR = ".runner";
export const RUNNER_STATE_DIRECTORIES = ["devices", "pairing", "ui-login", "events", "commands"] as const;

const DIRECTORY_MODE = 0o700;

export class WorkspaceError extends Error {
  override readonly name = "WorkspaceError";
}

/** A path that would leave the workspace root. */
export class WorkspacePathError extends Error {
  override readonly name = "WorkspacePathError";
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export interface CreateWorkspaceOptions {
  readonly packageVersion: string;
  readonly clock: Clock;
}

export class Workspace {
  readonly root: string;
  readonly manifest: WorkspaceManifest;

  private constructor(root: string, manifest: WorkspaceManifest) {
    this.root = root;
    this.manifest = manifest;
  }

  /** Opens an existing workspace. Throws WorkspaceError when workspace.json is missing or invalid. */
  static async open(dir: string): Promise<Workspace> {
    let root: string;
    try {
      root = await realpath(path.resolve(dir));
    } catch {
      throw new WorkspaceError(`No workspace at ${dir}: the folder does not exist. Run \`npm run setup\` in runner/.`);
    }
    const raw = await readJsonFile(path.join(root, WORKSPACE_MANIFEST_FILE)).catch((error: unknown) => {
      throw new WorkspaceError(`${WORKSPACE_MANIFEST_FILE} in ${root} is not valid JSON: ${(error as Error).message}`);
    });
    if (raw === undefined) {
      throw new WorkspaceError(`No ${WORKSPACE_MANIFEST_FILE} in ${root}. Run \`npm run setup\` in runner/.`);
    }
    const parsed = workspaceManifestSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new WorkspaceError(
        `${WORKSPACE_MANIFEST_FILE} in ${root} does not match the contract: ${issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "invalid"}`,
      );
    }
    const workspace = new Workspace(root, parsed.data);
    await workspace.ensureLayout();
    return workspace;
  }

  /**
   * Creates a workspace in `dir`: an empty or missing folder only. A folder
   * that already has other files is refused, so setup never adopts a
   * directory that belongs to something else.
   */
  static async create(dir: string, options: CreateWorkspaceOptions): Promise<Workspace> {
    const absolute = path.resolve(dir);
    await mkdir(absolute, { recursive: true, mode: DIRECTORY_MODE });
    const root = await realpath(absolute);
    const entries = (await readdir(root)).filter((name) => name !== ".DS_Store");
    if (entries.length > 0) {
      throw new WorkspaceError(
        `${root} is not empty and has no ${WORKSPACE_MANIFEST_FILE}. Choose an empty folder or an existing workspace.`,
      );
    }
    const manifest = workspaceManifestSchema.parse({
      workspaceId: newId(),
      workflowInstanceId: newId(),
      packageVersion: options.packageVersion,
      createdAt: options.clock.now().toISOString(),
    });
    const created = await createJsonExclusive(path.join(root, WORKSPACE_MANIFEST_FILE), manifest);
    if (!created) throw new WorkspaceError(`${WORKSPACE_MANIFEST_FILE} appeared in ${root} while setup was creating it.`);
    const workspace = new Workspace(root, manifest);
    await workspace.ensureLayout();
    return workspace;
  }

  /** Opens `dir` when it holds a workspace, otherwise creates one there. */
  static async openOrCreate(dir: string, options: CreateWorkspaceOptions): Promise<{ workspace: Workspace; created: boolean }> {
    const manifestPath = path.join(path.resolve(dir), WORKSPACE_MANIFEST_FILE);
    const exists = await stat(manifestPath).then(
      () => true,
      () => false,
    );
    if (exists) return { workspace: await Workspace.open(dir), created: false };
    return { workspace: await Workspace.create(dir, options), created: true };
  }

  /** Creates any missing §5 directories and the runner's state directories. */
  async ensureLayout(): Promise<void> {
    for (const name of WORKSPACE_DIRECTORIES) await mkdir(this.resolve(name), { recursive: true, mode: DIRECTORY_MODE });
    for (const name of RUNNER_STATE_DIRECTORIES) {
      await mkdir(this.resolve(RUNNER_STATE_DIR, name), { recursive: true, mode: DIRECTORY_MODE });
    }
  }

  /**
   * An absolute path inside the workspace. Each segment must be relative; the
   * joined result must stay under the root. Throws WorkspacePathError for an
   * absolute segment, a NUL byte, or any `..` that climbs out.
   */
  resolve(...segments: string[]): string {
    for (const segment of segments) {
      if (typeof segment !== "string" || segment.length === 0) throw new WorkspacePathError("Empty path segment.");
      if (segment.includes("\0")) throw new WorkspacePathError("Path contains a NUL byte.");
      if (path.isAbsolute(segment) || path.win32.isAbsolute(segment)) {
        throw new WorkspacePathError(`Absolute path not allowed in the workspace: ${segment}`);
      }
    }
    const target = path.resolve(this.root, ...segments);
    if (!isInside(this.root, target)) {
      throw new WorkspacePathError(`Path leaves the workspace: ${segments.join("/")}`);
    }
    return target;
  }

  /**
   * Like `resolve`, and also follows symlinks on the part of the path that
   * exists: a symlink inside the workspace that points outside it is refused.
   */
  async resolveReal(...segments: string[]): Promise<string> {
    const target = this.resolve(...segments);
    let existing = target;
    for (;;) {
      try {
        const real = await realpath(existing);
        if (!isInside(this.root, real)) throw new WorkspacePathError(`Path leaves the workspace through a symlink: ${segments.join("/")}`);
        return path.join(real, path.relative(existing, target));
      } catch (error) {
        if (error instanceof WorkspacePathError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = path.dirname(existing);
        if (parent === existing) throw error;
        existing = parent;
      }
    }
  }

  async readJson(...segments: string[]): Promise<unknown> {
    return readJsonFile(await this.resolveReal(...segments));
  }

  async writeJson(segments: readonly string[], value: unknown): Promise<void> {
    const file = await this.resolveReal(...segments);
    await mkdir(path.dirname(file), { recursive: true, mode: DIRECTORY_MODE });
    await writeJsonAtomic(file, value);
  }

  /** Writes only if the file does not exist yet; false when it did. */
  async createJson(segments: readonly string[], value: unknown): Promise<boolean> {
    const file = await this.resolveReal(...segments);
    await mkdir(path.dirname(file), { recursive: true, mode: DIRECTORY_MODE });
    return createJsonExclusive(file, value);
  }

  /** Names in a workspace directory, or [] when it does not exist. */
  async list(...segments: string[]): Promise<string[]> {
    try {
      return (await readdir(await this.resolveReal(...segments))).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /** The runner's own state directory, e.g. state("devices", "<id>.json"). */
  state(...segments: string[]): string[] {
    return [RUNNER_STATE_DIR, ...segments];
  }
}
