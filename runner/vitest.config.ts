import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Route-module fixtures are loaded by the tests, never run as tests.
    exclude: ["test/fixtures/**", "node_modules/**"],
    environment: "node",
    testTimeout: 20_000,
  },
});
