import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";

const here = path.dirname(fileURLToPath(import.meta.url)); // apps/catalog/lib/db
const MIGRATION_PATH = path.join(here, "..", "..", "db", "migrations", "0001_init.sql");

export function readMigrationSql(): string {
  return readFileSync(MIGRATION_PATH, "utf8");
}

/**
 * Applies the schema to a PGlite instance. Idempotent (every statement in
 * the migration is `CREATE TABLE IF NOT EXISTS`), so calling this on every
 * process start is safe. Uses `exec`, not `query`: the migration file is
 * several semicolon-separated statements with no parameters, which is
 * `exec`'s job (PGlite's `query` is for one parameterized statement).
 *
 * Neon (production) is never auto-migrated here — see apps/catalog/README.md
 * for the owner's one-time manual migration step.
 */
export async function migratePglite(client: PGlite): Promise<void> {
  await client.exec(readMigrationSql());
}
