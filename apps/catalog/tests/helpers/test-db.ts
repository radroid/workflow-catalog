import { PGlite } from "@electric-sql/pglite";
import { migratePglite } from "../../lib/db/migrate";
import { pgliteDb } from "../../lib/db/pglite-db";
import type { Db } from "../../lib/db/types";

/**
 * A fresh, in-memory, already-migrated database for one test. Deliberately
 * bypasses the `getDb()` singleton in lib/db/index.ts (which reads
 * DATABASE_URL/VERCEL and caches its result process-wide) so tests never
 * share state with each other or depend on process.env.
 */
export async function createTestDb(): Promise<Db> {
  const client = new PGlite();
  await migratePglite(client);
  return pgliteDb(client);
}
