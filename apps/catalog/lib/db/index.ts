import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./types";
import { neonDb } from "./neon-db";

export type { Db, QueryResult, SqlRow } from "./types";

let cached: Promise<Db> | null = null;

/**
 * Fail-closed driver selection, per docs/spec/implementation/P09-catalog-site.md:
 *  - `DATABASE_URL` set → Neon (`@neondatabase/serverless`), production.
 *  - Unset AND running on Vercel (`process.env.VERCEL` set) → throw. Never
 *    fall back to the local store when deployed.
 *  - Unset AND not on Vercel → PGlite, self-migrated into a gitignored
 *    directory inside apps/catalog (or an in-memory/custom dir for tests).
 *
 * `@electric-sql/pglite` is imported lazily (dynamic `import()`) so it and
 * its WASM payload never end up in the Vercel production bundle — only the
 * `DATABASE_URL` branch (neon-db.ts) ever executes there.
 */
export function getDb(): Promise<Db> {
  if (!cached) {
    cached = createDb();
  }
  return cached;
}

async function createDb(): Promise<Db> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    return neonDb(databaseUrl);
  }

  if (process.env.VERCEL) {
    throw new Error(
      "DATABASE_URL is not set while running on Vercel (process.env.VERCEL is set). " +
        "Refusing to fall back to the local PGlite store in production.",
    );
  }

  const [{ PGlite }, { pgliteDb }, { migratePglite }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("./pglite-db"),
    import("./migrate"),
  ]);
  const client = new PGlite(defaultPgliteDataDir());
  await migratePglite(client);
  return pgliteDb(client);
}

function defaultPgliteDataDir(): string {
  const configured = process.env.CATALOG_PGLITE_DIR;
  if (configured) return configured;
  const here = path.dirname(fileURLToPath(import.meta.url)); // apps/catalog/lib/db
  return path.join(here, "..", "..", ".data", "pglite");
}

/** Test-only: forces the next `getDb()` call to rebuild its driver from scratch. */
export function resetDbCacheForTests(): void {
  cached = null;
}
