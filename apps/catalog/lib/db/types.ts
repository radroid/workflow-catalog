// The small query interface every service function is written against.
// Both the production driver (Neon HTTP, lib/db/neon-db.ts) and the local
// driver (PGlite, lib/db/pglite-db.ts) implement exactly this shape, so
// service code and tests never branch on which one is live.

export type SqlRow = Record<string, unknown>;

export interface QueryResult<T extends SqlRow = SqlRow> {
  rows: T[];
}

export interface Db {
  query<T extends SqlRow = SqlRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}
