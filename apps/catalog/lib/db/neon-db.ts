import { neon } from "@neondatabase/serverless";
import type { Db, QueryResult, SqlRow } from "./types";

/**
 * Production driver: Neon's HTTP query function. One query per call over
 * HTTPS — no pool, no persistent connection, which is what makes it work
 * from a Vercel serverless function. `sql.query(text, params)` (default
 * options) resolves directly to an array of row objects; wrap it in the
 * `{ rows }` shape the rest of the app is written against.
 */
export function neonDb(connectionString: string): Db {
  const sql = neon(connectionString);

  return {
    async query<T extends SqlRow = SqlRow>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
      const rows = await sql.query(text, params);
      return { rows: rows as T[] };
    },
  };
}
