#!/usr/bin/env node
/* global console */
// This package's shared eslint.config.mjs (repo root) has no Node
// environment/globals configured (no other package's own scripts/ was
// linted before this one) — declare the one Node global this file uses.
//
// Copies the two self-hosted asset sources into extension/public/ before
// `vite build` runs (Vite copies publicDir verbatim into dist/). Both are
// regenerated on every build instead of being committed as tracked files:
//
//   - docs/spec/visuals/theme.css: the repo's single source of design
//     tokens (CLAUDE.md / P07 packet: "import or copy at build time, never
//     edit it"). Copying instead of hand-duplicating means this package can
//     never drift from the canonical file, and there is nothing here for a
//     future editor to accidentally hand-edit.
//   - Geist / Geist Mono variable woff2 files, taken from the pinned
//     `geist` npm package (P07 packet: "Self-host Geist and Geist Mono
//     woff2, taken from the geist npm package's font files"). The variable
//     axis file covers every weight the theme uses (400/500/600) from one
//     file each, instead of shipping a static file per weight.
//
// extension/public/ is gitignored (extension/.gitignore) — it only ever
// holds files this script produces.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(here, "..");
const repoRoot = path.resolve(extensionRoot, "..");
const publicDir = path.join(extensionRoot, "public");

const require = createRequire(import.meta.url);

function copyInto(destRelative, srcAbsolute) {
  const dest = path.join(publicDir, destRelative);
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(srcAbsolute, dest);
  console.log(`copied ${path.relative(repoRoot, srcAbsolute)} -> extension/public/${destRelative}`);
}

// docs/spec/visuals/theme.css itself is outside this package's Owns: extension/**
// allowlist — read-only source, never written.
copyInto("theme.css", path.join(repoRoot, "docs/spec/visuals/theme.css"));

// Resolve the installed `geist` package's own directory (rather than
// hard-coding a node_modules path) so this keeps working under pnpm's
// per-package symlink layout and across manager/hoisting differences.
const geistPackageJson = require.resolve("geist/package.json");
const geistRoot = path.dirname(geistPackageJson);

copyInto(
  "fonts/Geist-Variable.woff2",
  path.join(geistRoot, "dist/fonts/geist-sans/Geist-Variable.woff2"),
);
copyInto(
  "fonts/GeistMono-Variable.woff2",
  path.join(geistRoot, "dist/fonts/geist-mono/GeistMono-Variable.woff2"),
);
