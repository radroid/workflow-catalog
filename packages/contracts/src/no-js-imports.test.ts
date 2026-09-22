import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression test for a real `next build` failure: a relative import
 * ending in `.js` that actually points at a `.ts` file (e.g.
 * `from "./primitives.js"`) typechecks and passes `vitest`/`tsc`'s Bundler
 * resolution, but webpack/Turbopack (via `transpilePackages`, the way
 * `apps/catalog` will consume `@workflow-catalog/contracts`) looks for a
 * literal `primitives.js` on disk, doesn't find one, and fails with
 * "Module not found." Every internal import in this package must stay
 * extensionless.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = here;

// A relative specifier ending in .js/.jsx/.ts/.tsx/.mjs/.cjs inside a
// quoted import/export-from clause.
const RELATIVE_EXTENSIONED_IMPORT_RE = /from\s+["'](\.\.?\/[^"']+\.(?:js|jsx|ts|tsx|mjs|cjs))["']/g;

function listSourceFiles(): string[] {
  return readdirSync(srcDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
}

describe("no relative import in packages/contracts/src ends in a file extension", () => {
  for (const file of listSourceFiles()) {
    it(`${file} has no extensioned relative import`, () => {
      const content = readFileSync(path.join(srcDir, file), "utf8");
      const offenders = [...content.matchAll(RELATIVE_EXTENSIONED_IMPORT_RE)].map((m) => m[1]);
      expect(offenders, `${file} imports with an explicit extension: ${JSON.stringify(offenders)}`).toEqual(
        [],
      );
    });
  }
});
