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
export default defineConfig({
  test: {
    testTimeout: 20000,
  },
});
