import { defineConfig } from "vitest/config";

// Every PGlite-backed test (tests/db/schema.test.ts, tests/invites.test.ts,
// tests/sessions.test.ts, tests/install-status.test.ts) calls
// tests/helpers/test-db.ts's createTestDb(), which does `new PGlite()` — a
// fresh WASM module instantiation. That instantiation is CPU-bound, and
// Vitest runs test files concurrently by default, so several of these can
// compete for the same cores at once.
//
// Measured directly on an 8-core dev machine at load average ~= core count
// (i.e. not even oversubscribed): individual PGlite-backed tests legitimately
// took 4.7s-7.9s, all comfortably over Vitest's 5000ms default `testTimeout`,
// with zero assertion failures once given headroom (21/21 passed at
// --testTimeout=30000). This is real WASM cold-start cost under concurrency,
// not a hang or a code defect — CI runners can be slower or more contended
// than this dev machine, so this sets a global floor with real margin above
// the worst observed time rather than reacting file-by-file.
//
// P09-B revision round: raising testTimeout alone (tried 30000) was not
// enough — full-suite runs kept timing out on a *shifting* subset of
// PGlite-backed files each time, including ones this round never touched
// (tests/learn-route.test.ts), which is the signature of contention, not a
// broken test. This machine has 8 cores (matches the paragraph above), but
// this repo's own autonomous build loop runs several implementers'
// worktrees concurrently on the same host (see repo root CLAUDE.md) — this
// suite is not the only thing competing for those 8 cores while it runs,
// which the original measurement above didn't account for. Capping the
// fork pool bounds how many PGlite/WASM cold-starts happen at once instead
// of trying to out-guess an unpredictable amount of *external* contention
// with an ever-larger timeout; testTimeout/hookTimeout stay raised too, as
// a second, independent margin. Confirmed with 2 consecutive full
// `pnpm --filter catalog test` runs, both 139/139 green (52s, then 20s —
// the second run alone is a good sign this really was contention, not a
// borderline-slow test: nothing changed except less of it competing for
// cores).
export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
    // poolOptions.forks.maxForks was removed in Vitest 4 — this is its
    // top-level replacement (confirmed via `vitest run --help`, which is
    // also where this repo's own tsc/eslint-config-next docs-lookup
    // convention points when a package's .d.ts doesn't surface a name
    // directly).
    maxWorkers: 3,
  },
});
