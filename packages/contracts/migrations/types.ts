/**
 * The shape every `packages/contracts/migrations/NNNN-*.ts` file exports as
 * its default (P10-B, F12 "migrate workspace schema if needed"). A migration
 * runs forward only, from one workspace `packageVersion` to the very next
 * one — `runner/upgrade/migrate.ts` chains consecutive migrations to cover a
 * multi-version jump, never a file that claims to skip versions.
 *
 * `migrate` sees only the small, workspace-relative file I/O below, never a
 * full `Workspace` instance: this package (`@workflow-catalog/contracts`)
 * does not depend on the runner, and a migration must stay a pure
 * transformation of on-disk JSON, independent of how the runner stages or
 * commits it. `runner/upgrade/migrate.ts` is the only caller, and it is what
 * makes a run atomic (every `writeJson` here lands in memory first; nothing
 * touches disk until every migration in the chain has returned without
 * throwing) and idempotent-safe (a migration must leave an already-migrated
 * file exactly as it found it, so running the chain again is a no-op).
 *
 * `readJson`/`writeJson` operate on workspace-relative POSIX-style paths
 * (`"career-profile.json"`, `"applications/<id>.json"`), matching
 * `Workspace#resolve`'s own segment style; a migration never needs (and
 * cannot reach) an absolute path.
 */
export interface MigrationFileIO {
  /** Parsed JSON at `relativePath`, or `undefined` when the file does not exist. Throws only on a read error that is not "missing" (e.g. invalid JSON) — a migration should let that propagate, refusing the whole upgrade rather than guessing at a broken file. */
  readJson(relativePath: string): Promise<unknown>;
  /** Stages `value` to be written to `relativePath` once every migration step in the chain has succeeded. Overwrites any earlier staged write to the same path within this run. */
  writeJson(relativePath: string, value: unknown): Promise<void>;
}

export interface WorkspaceMigration {
  /** The `packageVersion` this migration applies to, e.g. `"0.1.0"`. */
  readonly from: string;
  /** The `packageVersion` a workspace is at once this migration has run, e.g. `"0.2.0"`. */
  readonly to: string;
  /** One line, shown nowhere yet but the migration's own file and test — for the person reading a diff or a failure message. */
  readonly description: string;
  /** Applies the migration. Idempotent: called again on a workspace already at `to`, it must change nothing. Throwing refuses the whole upgrade; the caller has staged no disk write yet. */
  migrate(io: MigrationFileIO): Promise<void>;
}

/** Runtime shape-check for a dynamically imported migration file's default export (mirrors `server/route-modules.ts`'s `validateRouteModule` — same reason: the loader crosses a module boundary `import()` can't type-check). */
export function isWorkspaceMigration(value: unknown): value is WorkspaceMigration {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.from === "string" &&
    candidate.from.length > 0 &&
    typeof candidate.to === "string" &&
    candidate.to.length > 0 &&
    typeof candidate.description === "string" &&
    candidate.description.length > 0 &&
    typeof candidate.migrate === "function"
  );
}
