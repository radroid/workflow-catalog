import type { PGlite } from "@electric-sql/pglite";
import type { Db, QueryResult, SqlRow } from "./types";

/**
 * Local/test driver: an in-process Postgres compiled to WASM, no build
 * script, no separate server to run. `@electric-sql/pglite` is imported
 * lazily (see `createLocalDb` in `./index.ts`) so it never ends up in the
 * Vercel production bundle — only `neon-db.ts` runs there.
 */
export function pgliteDb(client: PGlite): Db {
  return {
    async query<T extends SqlRow = SqlRow>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
      const result = await client.query<T>(text, params);
      return { rows: result.rows };
    },
  };
}
