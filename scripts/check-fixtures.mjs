#!/usr/bin/env node
// Fictional-fixtures policy scanner. No dependencies — see
// docs/spec/implementation/fixtures-policy.md for the rules this enforces:
//
//   (a) any email address in a tracked file whose domain is not an example
//       domain (`example`, `example.com`, `example.org`, `*.example`) or the
//       fixed exception `noreply@anthropic.com`.
//   (b) any URL inside a `fixtures/` directory whose host is not `*.example`.
//
// Scans `git ls-files` (tracked files only). Prints one `path:line: message`
// per offense and exits 1. Silent and exits 0 when the tree is clean.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /https?:\/\/[^\s"'<>()\\]+/g;

// The one fixed, non-domain exception the policy allows outright.
const ALLOWED_EMAIL_EXACT = new Set(["noreply@anthropic.com"]);

// Skipped so binary bytes are never decoded and pattern-matched as text.
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pdf", ".zip", ".gz",
]);

function isAllowedExampleHost(host) {
  const lower = host.toLowerCase();
  return (
    lower === "example" ||
    lower === "example.com" ||
    lower === "example.org" ||
    lower.endsWith(".example")
  );
}

function isBinaryPath(path) {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return BINARY_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

function extractHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function listTrackedFiles() {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.length > 0);
}

function scanFile(file, offenses) {
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    // Listed by git but unreadable here (e.g. a symlink) — nothing to scan.
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

function main() {
  const offenses = [];

  for (const file of listTrackedFiles()) {
    if (isBinaryPath(file)) continue;
    scanFile(file, offenses);
  }

  if (offenses.length > 0) {
    for (const offense of offenses) {
      console.error(offense);
    }
    console.error(`\n${offenses.length} fixture-policy offense(s) found.`);
    process.exit(1);
  }
}

main();
