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
//
// EVAL_RE used to be `(?<![.\w$])eval\s*\(`, which was meant to skip
// `obj.eval2(` (eval as a substring of a longer identifier) but, as a side
// effect, also skipped `window.eval(`/`globalThis.eval(` (real eval calls
// with a `.` immediately before them) and never matched an aliased call
// with no adjacent `(` at all, e.g. `(0, eval)(x)`. `\beval\b` fixes both:
// it requires a real word boundary on *both* sides, so `evaluate`/
// `retrieval` still don't match (no boundary between the shared letters),
// but `window.eval(`, `globalThis.eval(`, and `(0, eval)` all do (`.` and
// `(`/`,`/`)` are non-word characters, so the boundary is there).
const EVAL_RE = /\beval\b/;
// Same false-negative class on the Function side: minifiers drop `new`
// (zod's own probe below calls plain `Function(...)`), so requiring
// `new\s+Function` missed the built output's actual shape entirely. Matches
// `Function(` whether or not `new` precedes it, but not when it's a suffix
// of a longer identifier (`myFunction(`, `getFunction(`) via the negative
// lookbehind.
//
// The lookbehind used to also exclude a `.` immediately before `Function`,
// meant to rule out identifier-suffix cases like the ones above -- but `.`
// isn't a word character, and `myFunction(`/`getFunction(` are already
// excluded by `\w`/`$` alone. The side effect: `globalThis.Function(` and
// `self.Function(` -- real, callable references to the actual Function
// constructor via the global object, not identifier suffixes at all -- were
// silently skipped too. Dropping `.` from the class catches both while
// leaving the identifier-suffix exclusion intact (see the unit tests).
const NEW_FUNCTION_RE = /(?<![\w$])(?:new\s+)?Function\s*\(/;
const REMOTE_SCRIPT_SRC_RE = /<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//i;
const REMOTE_DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["'`]https?:\/\//;

// zod v4's own capability probe (bundled into assets/zod-jitless-*.js,
// unminified source in node_modules/zod): a lazy, memoized check that
// short-circuits on the global `jitless` flag *before* ever reaching this
// call — `extension/src/shared/zod-jitless.ts` sets that flag as the
// literal first import of every entry point (see that file and
// `zod-jitless.test.ts` for why import order guarantees this runs first).
// Even if it were somehow reached, MV3's default CSP has no `unsafe-eval`,
// so the call would just throw, which this probe catches and treats as
// "no eval available" — the exact outcome jitless mode assumes already.
// Allowed by this one exact literal snippet (observed in the current
// built output — the minifier's own choice of backtick-delimited empty
// string, `Function(``)`), not by filename or a broader pattern.
//
// The exception removes the snippet's own characters, never the line
// around it: every exact occurrence is cut out of the line and the Function
// pattern is tested against what is left (`withoutZodProbe` below). That
// matters because the built zod-jitless-*.js chunk is ONE ~10 KB line — an
// earlier `!line.includes(snippet)` exempted the whole chunk, and a planted
// `new Function(code)()` minified onto that same line passed the scan. Any
// *other* Function usage, on that line or anywhere else, including a future
// change to zod's own bundled probe that no longer matches this snippet
// verbatim, still fails the scan. Each occurrence is replaced with a space,
// not "": gluing the neighbours together could turn `x$<snippet>Function(e)`
// into `x$Function(e)`, which NEW_FUNCTION_RE's lookbehind would skip.
// NEW_FUNCTION_RE is the only pattern this exception applies to — the
// snippet contains no `eval`, remote script, or import.
const ZOD_JITLESS_PROBE_SNIPPET = "try{return Function(``),!0}catch{return!1}";

function withoutZodProbe(line) {
  return line.split(ZOD_JITLESS_PROBE_SNIPPET).join(" ");
}

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
        offenses.push(`${rel}:${lineNo}: forbidden eval reference in built output`);
      }
      if ((isJs || isHtml) && NEW_FUNCTION_RE.test(withoutZodProbe(line))) {
        offenses.push(`${rel}:${lineNo}: forbidden Function(...) constructor call in built output`);
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
