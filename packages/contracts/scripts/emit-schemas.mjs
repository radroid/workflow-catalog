#!/usr/bin/env node
/* global console, process -- this package's eslint config has no Node environment
   globals configured (see eslint.config.mjs at the repo root); declared
   inline rather than via a package-local eslint.config.mjs override, which
   flat config would treat as replacing the root config rather than
   extending it. */
/**
 * Part of `pnpm --filter contracts build` (see package.json's `build`
 * script): regenerates `packages/job-assistant/schemas/*.schema.json` from
 * `SCHEMA_REGISTRY` (src/registry.ts).
 *
 * `src/` uses plain extensionless relative imports (`from "./primitives"`,
 * not `from "./primitives.js"`) — required so a Next.js app that imports
 * `@workflow-catalog/contracts` resolves it under webpack/Turbopack (a
 * `.js`-suffixed specifier pointing at a `.ts` file breaks `next build`
 * even with `transpilePackages`). Plain Node's module loader can't resolve
 * an extensionless relative import at all (no bundler-style inference), so
 * this script can no longer just `import` the source directly, and can't
 * import the tsc-compiled `dist/` output either — `tsc` doesn't add
 * extensions to relative specifiers under `moduleResolution: "Bundler"`,
 * so `dist/*.js` has the exact same unresolvable extensionless imports as
 * `src/*.ts`.
 *
 * Instead this script asks Vite (already a root devDependency; no new
 * package) to resolve and transform `src/registry.ts` the same way it
 * transforms test files for `schema-drift.test.ts` — `ssrLoadModule` is
 * Vite's public API for exactly this ("load and execute a file with Vite's
 * resolution/transform pipeline, outside of serving HTTP requests"; it's
 * what tools like vite-node build on). One implementation of "what JSON
 * Schema does this registry entry produce" — `to-json-schema.ts` — is
 * shared between this script (loaded via Vite) and `schema-drift.test.ts`
 * (loaded directly by vitest), so the two can't compute different output.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const schemasOutDir = path.resolve(packageRoot, "../job-assistant/schemas");

async function main() {
  const server = await createServer({
    root: packageRoot,
    configFile: false,
    logLevel: "warn",
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  });

  try {
    const { SCHEMA_REGISTRY } = await server.ssrLoadModule("/src/registry.ts");
    const { generateSchemaDocument } = await server.ssrLoadModule("/src/to-json-schema.ts");

    mkdirSync(schemasOutDir, { recursive: true });

    for (const entry of SCHEMA_REGISTRY) {
      const outPath = path.join(schemasOutDir, `${entry.name}.schema.json`);
      const next = generateSchemaDocument(entry);

      // Skip the write when content is already identical, so `build` never
      // touches the file's mtime (and therefore never shows as "modified" to
      // `git status`) on a no-op regeneration.
      let previous = null;
      try {
        previous = readFileSync(outPath, "utf8");
      } catch {
        previous = null;
      }

      if (previous !== next) {
        writeFileSync(outPath, next, "utf8");
        console.log(`wrote ${path.relative(process.cwd(), outPath)}`);
      }
    }
  } finally {
    await server.close();
  }
}

await main();
