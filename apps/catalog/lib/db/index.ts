import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./types";
import { neonDb } from "./neon-db";

export type { Db, QueryResult, SqlRow } from "./types";

// Cached on `globalThis`, not a module-level `let`. Under `next dev`
// (Turbopack), a Route Handler and a Server Component can each end up as
// separate bundled copies of this module — a module-level `let cached`
// would then be two independent bindings, each lazily creating its OWN
// PGlite client pointed at the same on-disk directory. Two live PGlite
// instances against one directory silently diverge (each is its own
// in-process WASM Postgres with no shared-buffer/WAL visibility across
// instances the way a real server would have): a write through one client
// is not guaranteed visible to a read through the other. That is exactly
// how this served stale sessions in a live walkthrough — a signed-out
// cookie still opened lessons, and a brand-new session was bounced —
// because app/(gated)/learn/[...slug]/route.ts's copy of `getDb()` had
// never seen what the page-rendering copy had written or revoked.
// `globalThis` is the one JS object every bundled copy of this module
// shares in the same process, in dev, in tests (see
// tests/db/global-singleton.test.ts, which simulates the duplicate-module
// scenario with `vi.resetModules()`), and in production (Neon's HTTP
// driver is just as safe, and cheaper than rebuilding it per bundle too).
declare global {
  var __catalogDbPromise: Promise<Db> | undefined;
}

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
  if (!globalThis.__catalogDbPromise) {
    // Cache the promise, not the resolved value — but a *rejected* promise
    // left cached on globalThis is a permanent outage: every future
    // getDb() call would keep returning that same dead promise, forever,
    // even once whatever caused the rejection (e.g. a data directory that
    // didn't exist yet) would no longer happen on retry. A P09-B revision
    // round caught this on a fresh clone specifically, where the very first
    // request's ENOENT (see defaultPgliteDataDir/mkdir below) got baked in
    // permanently — only a process restart cleared it. Clearing the cache
    // on failure lets the next call retry createDb() from scratch instead.
    globalThis.__catalogDbPromise = createDb().catch((err: unknown) => {
      globalThis.__catalogDbPromise = undefined;
      throw err;
    });
  }
  return globalThis.__catalogDbPromise;
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
  const dataDir = defaultPgliteDataDir();
  // { recursive: true }: on a fresh clone, neither apps/catalog/.data/ nor
  // .data/pglite/ exist yet — a non-recursive mkdir (or PGlite's own,
  // unhelped) only ever creates the final path segment, so the first
  // request on a fresh checkout crashed with ENOENT (the parent .data/ was
  // missing too). Also a no-op, not an error, when the directory already
  // exists — safe to run on every createDb() call, not just the first.
  await mkdir(dataDir, { recursive: true });
  const client = new PGlite(dataDir);
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
  globalThis.__catalogDbPromise = undefined;
}
