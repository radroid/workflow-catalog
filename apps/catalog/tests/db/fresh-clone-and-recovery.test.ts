import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// P09-B revision round (UI critic issue 4): on a fresh clone, neither
// apps/catalog/.data/ nor .data/pglite/ exist yet — PGlite's own directory
// handling (unhelped) only ever manages the final path segment, so the
// very first database request crashed with ENOENT. Worse, getDb() cached
// the *rejected* promise on globalThis, so every subsequent request kept
// replaying that same dead rejection forever — only a process restart
// (which starts a brand-new globalThis) recovered. Both halves fixed in
// lib/db/index.ts: mkdir(dir, { recursive: true }) before opening PGlite,
// and getDb() clears its own cache entry when createDb() rejects, so the
// next call retries from scratch instead of replaying the failure.

const { PGliteMock } = vi.hoisted(() => ({ PGliteMock: vi.fn() }));

// Mocking @electric-sql/pglite's constructor, not node:fs/promises's mkdir,
// keeps the "cache clears on failure" test independent of *what* makes
// createDb() reject — it forces a failure at the one call every version of
// createDb() (pre- and post-fix) makes unconditionally, so this test proves
// getDb()'s own retry behavior rather than being coupled to the mkdir fix
// covered by the sibling test below.
vi.mock("@electric-sql/pglite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@electric-sql/pglite")>();
  return { ...actual, PGlite: PGliteMock };
});

describe("getDb() on a fresh clone / after a failed attempt", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "wc-catalog-fresh-clone-"));
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
  });

  afterEach(async () => {
    const { resetDbCacheForTests } = await import("../../lib/db");
    resetDbCacheForTests();
    vi.unstubAllEnvs();
    PGliteMock.mockReset();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("opens successfully when neither the data dir nor its parent exists yet (a real fresh clone)", async () => {
    // Two missing levels, not one: apps/catalog/.data/ AND .data/pglite/,
    // matching what a real clone looks like (only .data's parent exists).
    // A non-recursive mkdir only ever creates the last segment, so this
    // specifically exercises the two-levels-missing case. No mocking here
    // — this exercises the real recursive mkdir against the real filesystem
    // and the real (unmocked, restored below) PGlite.
    // A plain arrow function can't be invoked via `new` (no [[Construct]]
    // internal slot) — mockImplementation needs a real `function` here
    // since createDb() calls `new PGlite(dataDir)`.
    const actual = await vi.importActual<typeof import("@electric-sql/pglite")>("@electric-sql/pglite");
    PGliteMock.mockImplementation(function (...args: ConstructorParameters<typeof actual.PGlite>) {
      return new actual.PGlite(...args);
    });

    const dataDir = path.join(tmpRoot, "does-not-exist-yet", "pglite");
    expect(existsSync(dataDir)).toBe(false);
    vi.stubEnv("CATALOG_PGLITE_DIR", dataDir);

    const { getDb } = await import("../../lib/db");
    const db = await getDb();

    expect(db).toBeDefined();
    expect(existsSync(dataDir)).toBe(true);
  });

  it("retries instead of permanently caching a rejected promise, once the transient failure clears", async () => {
    const dataDir = path.join(tmpRoot, "pglite");
    vi.stubEnv("CATALOG_PGLITE_DIR", dataDir);

    const actual = await vi.importActual<typeof import("@electric-sql/pglite")>("@electric-sql/pglite");
    let attempt = 0;
    PGliteMock.mockImplementation(function (...args: ConstructorParameters<typeof actual.PGlite>) {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("simulated transient PGlite open failure");
      }
      return new actual.PGlite(...args);
    });

    const { getDb } = await import("../../lib/db");

    await expect(getDb()).rejects.toThrow("simulated transient PGlite open failure");
    // Pre-fix, this second call would have returned the exact same
    // (rejected) cached promise from globalThis — never re-invoking
    // createDb() at all, so `attempt` would stay at 1 and this would also
    // reject, forever, until the process restarted.
    const db = await getDb();

    expect(db).toBeDefined();
    expect(attempt).toBe(2);
  });
});
