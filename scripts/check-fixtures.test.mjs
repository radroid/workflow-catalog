// Regression test for the non-ASCII-path bug: `git ls-files` (no -z) quotes
// and octal-escapes paths with non-ASCII bytes, so a plain readFileSync on
// that escaped string throws ENOENT — and the old scanner's empty
// `catch { return; }` swallowed that as "nothing to scan," silently letting
// a real offense through. Runs the actual CLI (`node check-fixtures.mjs`)
// against a throwaway git repo in os.tmpdir(), the same way CI invokes it,
// and asserts on the real process exit code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, "check-fixtures.mjs");

function makeTempRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "check-fixtures-test-"));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  return dir;
}

function stageFile(dir, relativePath, content) {
  const absolute = path.join(dir, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
  execFileSync("git", ["add", relativePath], { cwd: dir });
}

function runCheckFixtures(cwd) {
  try {
    const stdout = execFileSync("node", [scriptPath], { cwd, encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    // execFileSync throws on a non-zero exit; the exit code and captured
    // output are on the error object.
    return {
      status: typeof error.status === "number" ? error.status : 1,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : "",
    };
  }
}

test("flags a disallowed URL and email hiding behind a non-ASCII fixtures path", () => {
  const dir = makeTempRepo();
  try {
    stageFile(
      dir,
      "packages/x/fixtures/résumé.md",
      "See https://www.linkedin.com/jobs/view/2 and reach someone.else@gmail.com\n",
    );

    const result = runCheckFixtures(dir);

    assert.equal(result.status, 1, `expected exit 1, got ${result.status}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /résumé\.md/, "offense output should name the real (non-ASCII) file path");
    assert.match(result.stderr, /linkedin\.com/, "should flag the disallowed URL");
    assert.match(result.stderr, /gmail\.com/, "should flag the disallowed email");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("exits 0 on a clean tree that only uses allowed example domains", () => {
  const dir = makeTempRepo();
  try {
    stageFile(
      dir,
      "packages/x/fixtures/posting.md",
      "See https://jobs.example/posting/1 and reach ada@example.com\n",
    );

    const result = runCheckFixtures(dir);

    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr:\n${result.stderr}`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
