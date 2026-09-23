import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * P07-B revision 2, D: every built page ships base.css's
 * `[hidden]{display:none !important}`. Without it, an element hidden with
 * the `hidden` attribute still shows whenever one of its classes sets
 * `display` (`.stack`, `.row`), because an author rule beats the UA
 * stylesheet's own `[hidden]` rule. e2e/checks.ts's
 * `expectHiddenReallyHidden` proves the rule's effect in a real browser;
 * this proves it is in what ships, for every page, with no browser.
 *
 * Gated the same way as manifest.test.ts's dist tests: skipped when dist/
 * is absent, except under EXTENSION_DIST_REQUIRED=1 (CI's extension step,
 * which builds first), where a missing dist/ fails.
 */
const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const runIfBuilt = existsSync(distDir) || process.env.EXTENSION_DIST_REQUIRED === "1" ? it : it.skip;

const PAGES = ["src/popup/index.html", "src/options/index.html", "src/sidepanel/index.html"];
const HIDDEN_RULE = /\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*;?\s*\}/;

function linkedStylesheets(pagePath: string): string[] {
  const html = readFileSync(path.join(distDir, pagePath), "utf8");
  return [...html.matchAll(/<link\b[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => /\brel="stylesheet"/.test(tag))
    .map((tag) => /\bhref="([^"]+)"/.exec(tag)?.[1])
    .filter((href): href is string => href !== undefined);
}

describe("built pages ship the [hidden] rule (P07-B revision 2, D)", () => {
  for (const page of PAGES) {
    runIfBuilt(`${page} links a stylesheet with [hidden]{display:none!important}`, () => {
      const sheets = linkedStylesheets(page);
      expect(sheets.length, `${page} links no stylesheet`).toBeGreaterThan(0);
      const css = sheets.map((href) => readFileSync(path.join(distDir, href), "utf8")).join("\n");
      expect(css, `${page}'s stylesheets (${sheets.join(", ")})`).toMatch(HIDDEN_RULE);
    });
  }
});
