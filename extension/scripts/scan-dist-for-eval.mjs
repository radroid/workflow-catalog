#!/usr/bin/env node
/* global console, process */
// Built-output scan required by the P07 packet ("a built-output scan that
// fails on eval(, new Function, or remote <script src> / import() of
// http(s): URLs") and CLAUDE.md's hard rule ("no remote code, or eval").
//
// This is a static, literal-pattern scan of the *built* extension
// (extension/dist/), run as the last step of `pnpm build` (see
// package.json) so a violation fails the build, not just a lint pass.
// `scanDistForViolations` is exported so `scan-dist-for-eval.test.ts` can
// exercise the matching logic against small synthetic fixtures without
// needing a real build to exist first — the same split `check-fixtures.mjs`
// / `check-fixtures.test.mjs` use at the repo root.
//
// Why this is a *defense-in-depth* check, not the only guard: zod v4's
// object-schema parser can probe eval availability via `new Function(...)`
// (aliased through a local variable, so it would not even match this
// scan's literal pattern) unless `z.config({ jitless: true })` is set
// first. `extension/src/shared/zod-jitless.ts` sets that — imported first
// by every entry point — which is the real guarantee; see that file and
// `zod-jitless.test.ts` for the mechanism and its regression test.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Detection-only patterns: this file never calls eval()/Function() itself —
// these regexes exist solely to flag those calls in *other* built output.
const EVAL_RE = /(?<![.\w$])eval\s*\(/;
const NEW_FUNCTION_RE = /\bnew\s+Function\b/;
const REMOTE_SCRIPT_SRC_RE = /<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//i;
const REMOTE_DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["'`]https?:\/\//;

const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);

function listFiles(dir) {
  return readdirSync(dir, { recursive: true })
    .map((entry) => path.join(dir, entry))
    .filter((full) => {
      try {
        return statSync(full).isFile();
      } catch {
        return false;
      }
    });
}

/**
 * @param {string} distDir absolute path to a built extension output directory
 * @returns {string[]} one message per offense; empty when clean
 */
export function scanDistForViolations(distDir) {
  const offenses = [];

  for (const file of listFiles(distDir)) {
    const ext = path.extname(file).toLowerCase();
    const isJs = JS_EXTENSIONS.has(ext);
    const isHtml = HTML_EXTENSIONS.has(ext);
    if (!isJs && !isHtml) continue;

    const content = readFileSync(file, "utf8");
    const rel = path.relative(distDir, file);
    const lines = content.split("\n");

    lines.forEach((line, index) => {
      const lineNo = index + 1;

      if ((isJs || isHtml) && EVAL_RE.test(line)) {
        offenses.push(`${rel}:${lineNo}: forbidden eval(...) call in built output`);
      }
      if ((isJs || isHtml) && NEW_FUNCTION_RE.test(line)) {
        offenses.push(`${rel}:${lineNo}: forbidden "new Function" in built output`);
      }
      if (isHtml && REMOTE_SCRIPT_SRC_RE.test(line)) {
        offenses.push(`${rel}:${lineNo}: forbidden remote <script src="http(s)://..."> in built output`);
      }
      if (isJs && REMOTE_DYNAMIC_IMPORT_RE.test(line)) {
        offenses.push(`${rel}:${lineNo}: forbidden remote import("http(s)://...") in built output`);
      }
    });
  }

  return offenses;
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const distDir = path.resolve(here, "../dist");

  let offenses;
  try {
    offenses = scanDistForViolations(distDir);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      console.error(`${path.relative(process.cwd(), distDir)} does not exist — run the vite build step first.`);
      process.exit(1);
    }
    throw error;
  }

  if (offenses.length > 0) {
    for (const offense of offenses) {
      console.error(offense);
    }
    console.error(`\n${offenses.length} built-output violation(s) found.`);
    process.exit(1);
  }

  console.log(`dist/ scan clean: no eval, new Function, or remote script/import found.`);
}

// Only run when executed directly (`node scan-dist-for-eval.mjs`), not when
// imported by the vitest regression test.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
