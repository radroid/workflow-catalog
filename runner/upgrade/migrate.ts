import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isWorkspaceMigration, type MigrationFileIO, type WorkspaceMigration } from "../../packages/contracts/migrations/types.ts";
import { REPO_ROOT } from "../lib/paths.ts";
import type { Workspace } from "../store/workspace.ts";
import { compareSemver } from "./semver.ts";

/**
 * Loads and runs `packages/contracts/migrations/*.ts` (P10 packet Owns).
 * Loading mirrors `server/route-modules.ts`'s `loadRouteModules`: every
 * `.ts` file but a test, a type declaration, or one starting with `_`/`.` is
 * dynamically imported by its file path (`types.ts` is also skipped by
 * name — it exports the shared interface, not a migration), and its default
 * export is shape-checked at runtime, since a computed `import()` is exactly
 * what `packages/contracts`'s own `tsc` cannot follow either (that package's
 * `tsconfig.json` typechecks the directory for its *own* correctness; this
 * loader still can't get static types out of a path built at runtime).
 *
 * `@workflow-catalog/contracts`'s public export (`packages/contracts/src/
 * index.ts`) never lists `migrations/` — this is the only consumer, so a
 * new package export surface was not worth adding for it.
 */
export const MIGRATIONS_DIR = path.join(REPO_ROOT, "packages", "contracts", "migrations");

export class MigrationLoadError extends Error {
  override readonly name = "MigrationLoadError";
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<WorkspaceMigration[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files = names.filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith(".d.ts") && file !== "types.ts" && !/^[_.]/.test(file)).sort();
  const migrations: WorkspaceMigration[] = [];
  for (const file of files) {
    let imported: { default?: unknown };
    try {
      imported = (await import(pathToFileURL(path.join(dir, file)).href)) as { default?: unknown };
    } catch (error) {
      throw new MigrationLoadError(`packages/contracts/migrations/${file} failed to load: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isWorkspaceMigration(imported.default)) {
      throw new MigrationLoadError(`packages/contracts/migrations/${file} must \`export default\` a WorkspaceMigration (from, to, description, migrate).`);
    }
    migrations.push(imported.default);
  }
  return migrations;
}

export class MigrationError extends Error {
  override readonly name = "MigrationError";
}

export interface RunMigrationsOptions {
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly workspace: Workspace;
  /** Injectable; defaults to `loadMigrations()`'s real directory. A test supplies its own chain — including one step that throws — without touching `packages/contracts/migrations/` (P10 packet Decisions: "a failed migration step that leaves the workspace unchanged"). */
  readonly migrations?: readonly WorkspaceMigration[];
}

export interface RanMigrationStep {
  readonly from: string;
  readonly to: string;
  readonly description: string;
}

export interface RunMigrationsResult {
  readonly ranSteps: readonly RanMigrationStep[];
}

/**
 * Runs every migration step from `currentVersion` to `targetVersion`, in
 * order, atomically: every `migrate()` call writes only into an in-memory
 * staging map (`MigrationFileIO.writeJson` here never touches disk), and a
 * step that throws propagates immediately — since nothing has reached disk
 * yet, the workspace is exactly as `runMigrations` found it (P10 packet
 * Decisions: "A failed step leaves the workspace as it was"). Only once
 * every step in the chain has returned does this commit the staged writes,
 * each through `Workspace#writeJson`'s own atomic write.
 *
 * The chain is built by matching each step's `from` to the previous step's
 * `to` (or `currentVersion` for the first step), never by file order or by
 * skipping a version: a gap (no migration whose `from` is the current
 * cursor) refuses with `MigrationError`, before anything is staged.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<RunMigrationsResult> {
  const { currentVersion, targetVersion, workspace } = options;
  const order = compareSemver(targetVersion, currentVersion);
  if (order < 0) throw new MigrationError(`Cannot migrate backward from ${currentVersion} to ${targetVersion}.`);
  if (order === 0) return { ranSteps: [] };

  const migrations = options.migrations ?? (await loadMigrations());
  const byFrom = new Map<string, WorkspaceMigration>();
  for (const migration of migrations) {
    if (byFrom.has(migration.from)) throw new MigrationLoadError(`Two migrations both claim to run from ${migration.from}.`);
    byFrom.set(migration.from, migration);
  }

  const chain: WorkspaceMigration[] = [];
  let cursor = currentVersion;
  while (compareSemver(cursor, targetVersion) < 0) {
    const step = byFrom.get(cursor);
    if (!step) throw new MigrationError(`No migration takes a workspace from ${cursor} toward ${targetVersion}. Nothing was changed.`);
    chain.push(step);
    cursor = step.to;
  }
  if (cursor !== targetVersion) {
    throw new MigrationError(`The migration chain from ${currentVersion} reaches ${cursor}, not the target ${targetVersion}. Nothing was changed.`);
  }

  const staged = new Map<string, unknown>();
  const io: MigrationFileIO = {
    async readJson(relativePath) {
      if (staged.has(relativePath)) return staged.get(relativePath);
      return workspace.readJson(...relativePath.split("/"));
    },
    async writeJson(relativePath, value) {
      staged.set(relativePath, value);
    },
  };

  const ranSteps: RanMigrationStep[] = [];
  for (const step of chain) {
    try {
      await step.migrate(io);
    } catch (error) {
      throw new MigrationError(
        `Migration ${step.from} -> ${step.to} (${step.description}) failed: ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`,
      );
    }
    ranSteps.push({ from: step.from, to: step.to, description: step.description });
  }

  for (const [relativePath, value] of staged) {
    await workspace.writeJson(relativePath.split("/"), value);
  }
  return { ranSteps };
}
