#!/usr/bin/env node
/* global console, process -- this package's eslint config has no Node
   environment globals configured (see eslint.config.mjs at the repo root);
   declared inline rather than via a package-local eslint.config.mjs override,
   which flat config would treat as replacing the root config rather than
   extending it. */
/**
 * Part of `pnpm --filter contracts build` (see package.json's `build`
 * script: `tsc -p tsconfig.build.json && node scripts/emit-schemas.mjs`):
 * regenerates `packages/job-assistant/schemas/*.schema.json` from
 * `SCHEMA_REGISTRY` (src/registry.ts) using zod 4's `z.toJSONSchema`,
 * targeting JSON Schema draft 2020-12.
 *
 * Plain `.mjs`, not TypeScript (CLAUDE.md: "Node 24 runs plain .mjs; no
 * tsx/esbuild needed"): it imports the already-compiled
 * `../dist/registry.js`, produced by the `tsc` step that always runs
 * immediately before this one in the `build` script, rather than the `src/`
 * TypeScript — a plain Node process can only resolve a relative import by
 * its exact on-disk extension (no bundler-style extension inference), and
 * `dist/` is where that exact-extension `.js` file actually lives.
 * `src/`'s own internal imports use explicit `.js`-suffixed specifiers
 * that resolve to their sibling `.ts` files under `tsc`'s Bundler
 * resolution (see e.g. `src/registry.ts`) precisely so the compiled
 * `dist/*.js` output keeps working ones.
 *
 * `schema-drift.test.ts` (run by plain `pnpm test`, no build required)
 * imports the same `SCHEMA_REGISTRY` straight from `src/registry.ts` via
 * Vite's resolver — which, unlike plain Node, does resolve those `.js`
 * specifiers to their `.ts` source — and calls the same
 * `z.toJSONSchema(schema, { target: "draft-2020-12" })` shape inline to
 * regenerate and compare against the committed files, so a forgotten build
 * is still caught without needing dist/ to exist.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SCHEMA_REGISTRY } from "../dist/registry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schemasOutDir = path.resolve(here, "../../job-assistant/schemas");

mkdirSync(schemasOutDir, { recursive: true });

for (const entry of SCHEMA_REGISTRY) {
  const outPath = path.join(schemasOutDir, `${entry.name}.schema.json`);
  const jsonSchema = z.toJSONSchema(entry.schema, { target: "draft-2020-12" });
  const next = `${JSON.stringify(jsonSchema, null, 2)}\n`;

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
