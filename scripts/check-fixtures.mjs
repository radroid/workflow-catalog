#!/usr/bin/env node
// Fictional-fixtures policy scanner. No dependencies — see
// docs/spec/implementation/fixtures-policy.md for the rules this enforces:
//
//   (a) any email address in a tracked file whose domain is not an example
//       domain (`example`, `example.com`, `example.org`, `*.example`).
//   (b) any URL inside a `fixtures/` directory whose host is not `*.example`.
//
// One addition beyond the policy doc: `noreply@anthropic.com` is always
// allowed. That's not a fixtures-policy.md rule — it's a scanner-level
// allowance so this repo's own commit-attribution text
// (`Co-Authored-By: ... <noreply@anthropic.com>`) never trips the scanner if
// it ends up quoted inside a tracked file (e.g. this packet's own report).
//
// Scans `git ls-files -z` (tracked files only; -z so non-ASCII/space/quote
// paths come back as raw bytes instead of `git ls-files`' default quoted-
// and-escaped form — a plain readFileSync on the escaped form throws ENOENT
// and must never be treated as "nothing to scan"). Prints one
// `path:line: message` per offense and exits 1. Silent and exits 0 when the
// tree is clean.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /https?:\/\/[^\s"'<>()\\]+/g;

// The one fixed, non-domain exception — see the header comment above.
const ALLOWED_EMAIL_EXACT = new Set(["noreply@anthropic.com"]);

// Skipped so binary bytes are never decoded and pattern-matched as text.
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pdf", ".zip", ".gz",
]);

// readFileSync errors that mean "there is genuinely nothing to scan here"
// (deleted from the worktree without `git rm`, or a submodule/gitlink
// directory entry). Anything else — permission errors, encoding surprises,
// a path git can see but Node can't for some other reason — is reported as
// an offense instead of silently skipped; that silent skip is exactly how
// this scanner used to miss non-ASCII fixture paths.
const SKIPPABLE_READ_ERRORS = new Set(["ENOENT", "EISDIR"]);

function isAllowedExampleHost(host) {
  const lower = host.toLowerCase();
  return (
    lower === "example" ||
    lower === "example.com" ||
    lower === "example.org" ||
    lower.endsWith(".example")
  );
}

function isBinaryPath(filePath) {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return false;
  return BINARY_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

function extractHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function listTrackedFiles(cwd) {
  // -z: NUL-separated, unquoted paths. Without it, git ls-files renders
  // non-ASCII (and space/quote-containing) paths as a quoted, octal-escaped
  // string — e.g. "packages/x/fixtures/r\303\251sum\303\251.md" — which is
  // not the real filesystem path and will never openable via readFileSync.
  const output = execFileSync("git", ["ls-files", "-z"], { cwd, encoding: "utf8" });
  return output.split("\0").filter((entry) => entry.length > 0);
}

function scanFile(cwd, file, offenses) {
  let content;
  try {
    content = readFileSync(path.join(cwd, file), "utf8");
  } catch (error) {
    if (error && SKIPPABLE_READ_ERRORS.has(error.code)) {
      return;
    }
    const reason = error && error.code ? error.code : String(error);
    offenses.push(`${file}: could not read this tracked file (${reason}) — treating as an offense rather than skipping it silently`);
    return;
  }

  const inFixturesDir = /(^|\/)fixtures\//.test(file);
  const lines = content.split("\n");

  lines.forEach((line, index) => {
    const lineNo = index + 1;

    for (const match of line.matchAll(EMAIL_RE)) {
      const email = match[0];
      if (ALLOWED_EMAIL_EXACT.has(email.toLowerCase())) continue;
      const domain = email.slice(email.indexOf("@") + 1);
      if (isAllowedExampleHost(domain)) continue;
      offenses.push(
        `${file}:${lineNo}: disallowed email address "${email}" — use an example domain (see docs/spec/implementation/fixtures-policy.md)`,
      );
    }

    if (inFixturesDir) {
      for (const match of line.matchAll(URL_RE)) {
        const url = match[0];
        const host = extractHost(url);
        if (host !== null && isAllowedExampleHost(host)) continue;
        offenses.push(
          `${file}:${lineNo}: disallowed URL "${url}" in a fixtures/ directory — host must be *.example (see docs/spec/implementation/fixtures-policy.md)`,
        );
      }
    }
  });
}

// Exported (well, top-level — this is a script, not a package) so the
// regression test in check-fixtures.test.mjs can run the same logic against
// a throwaway repo without spawning a subprocess, and so nothing here
// secretly depends on process.cwd() rather than the cwd it was asked about.
export function checkFixtures(cwd) {
  const offenses = [];

  for (const file of listTrackedFiles(cwd)) {
    if (isBinaryPath(file)) continue;
    scanFile(cwd, file, offenses);
  }

  return offenses;
}

function main() {
  const offenses = checkFixtures(process.cwd());

  if (offenses.length > 0) {
    for (const offense of offenses) {
      console.error(offense);
    }
    console.error(`\n${offenses.length} fixture-policy offense(s) found.`);
    process.exit(1);
  }
}

main();
