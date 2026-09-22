import { defineConfig } from "@playwright/test";

// Extension tests share one persistent Chromium profile per test (see
// e2e/fixtures.ts) and never touch a shared server, so full parallelism
// across files is fine; Playwright still runs each test's own fixtures
// (a fresh persistent context) serially within that test.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
});
