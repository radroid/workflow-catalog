import { defineConfig } from "@playwright/test";

// Extension tests share one persistent Chromium profile per test (see
// e2e/fixtures.ts) and never touch a shared server, so full parallelism
// across files is fine; Playwright still runs each test's own fixtures
// (a fresh persistent context) serially within that test.
//
// P07 part C: the two files that start a real bridge both bind
// 127.0.0.1:4310, the one origin the manifest's host permission allows, and
// both take it down and bring it back mid-test (the offline gates). They run
// in their own project, one file at a time; everything else stays parallel.
const BRIDGE_PORT_FILES = /(bridge|sessions)-e2e\.spec\.ts$/;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  projects: [
    { name: "extension", testIgnore: BRIDGE_PORT_FILES },
    { name: "bridge-port", testMatch: BRIDGE_PORT_FILES, workers: 1 },
  ],
});
