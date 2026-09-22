import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const globalsCss = readFileSync(path.join(here, "../app/globals.css"), "utf8");
const themeCss = readFileSync(
  path.join(here, "../../../docs/spec/visuals/theme.css"),
  "utf8",
);

describe("catalog theme wiring", () => {
  it("globals.css imports theme.css", () => {
    expect(globalsCss).toMatch(/@import\s+["'].*theme\.css["'];/);
  });

  it("theme.css defines --background", () => {
    expect(themeCss).toMatch(/--background:/);
  });

  it("globals.css remaps --font-sans and --font-mono to the next/font variables, with no extra generic fallback appended", () => {
    // next/font's generated variable already ends in a full fallback chain
    // (see geist's dist/mono.js: fallback: [..., "monospace"]), so the
    // remap must not append another generic family after it — that's what
    // produced the doubled "..., monospace, monospace" the P00 UI critique
    // flagged. These regexes require the declaration to end right at the
    // var(...) call (an optional space then ";"), not extend past it.
    expect(globalsCss).toMatch(/--font-sans:\s*var\(--font-geist-sans\)\s*;/);
    expect(globalsCss).toMatch(/--font-mono:\s*var\(--font-geist-mono\)\s*;/);
  });

  it("the font remap is declared explicitly under both :root and [data-theme=\"dark\"]", () => {
    // theme.css's own [data-theme="dark"] block re-declares the bare
    // "Geist, sans-serif" family names, so the remap must be explicit in
    // dark mode too rather than relying on cascade order between two
    // equal-specificity selectors (the P00 UI critique's other font note).
    const darkBlockMatch = /\[data-theme="dark"\]\s*{([^}]*)}/.exec(globalsCss);
    expect(darkBlockMatch, "globals.css must have its own [data-theme=\"dark\"] block").not.toBeNull();
    const darkBlockBody = darkBlockMatch?.[1] ?? "";
    expect(darkBlockBody).toMatch(/--font-sans:\s*var\(--font-geist-sans\)/);
    expect(darkBlockBody).toMatch(/--font-mono:\s*var\(--font-geist-mono\)/);
  });

  it("sets -webkit-text-size-adjust: 100% on html", () => {
    expect(globalsCss).toMatch(/-webkit-text-size-adjust:\s*100%/);
  });

  it("cards pair the hairline border with --shadow-sm", () => {
    const cardRuleMatch = /\.card\s*{([^}]*)}/.exec(globalsCss);
    expect(cardRuleMatch).not.toBeNull();
    const body = cardRuleMatch?.[1] ?? "";
    expect(body).toMatch(/border:\s*1px solid var\(--border\)/);
    expect(body).toMatch(/box-shadow:\s*var\(--shadow-sm\)/);
  });

  it("gives buttons and links a themed :focus-visible ring, not the browser default", () => {
    const ringRuleMatch = /(?:button|\.button|a):focus-visible[^{]*{([^}]*)}/.exec(globalsCss);
    expect(ringRuleMatch, "expected a shared :focus-visible rule for buttons/links").not.toBeNull();
    expect(ringRuleMatch?.[1]).toMatch(/outline:\s*2px solid var\(--ring\)/);
  });

  it("applies the ghost style to <a class=\"button ghost\"> links, not just <button class=\"ghost\">", () => {
    const ghostRuleMatch = /button\.ghost,\s*\n?\s*\.button\.ghost\s*{([^}]*)}/.exec(globalsCss);
    expect(ghostRuleMatch, "expected a combined button.ghost, .button.ghost rule").not.toBeNull();
    expect(ghostRuleMatch?.[1]).toMatch(/background:\s*transparent/);
  });

  it("applies the primary style to <a class=\"button primary\"> links, not just <button class=\"primary\">", () => {
    // Same bug class as .button.ghost above: the template page's download
    // link is an <a className="button primary">, not a <button>, so a
    // selector requiring a literal button element leaves it on .button's
    // plain card background/foreground text — effectively unreadable
    // against the intended primary treatment. Caught in the P09-B revision
    // round.
    const primaryRuleMatch = /button\.primary,\s*\n?\s*\.button\.primary\s*{([^}]*)}/.exec(globalsCss);
    expect(primaryRuleMatch, "expected a combined button.primary, .button.primary rule").not.toBeNull();
    expect(primaryRuleMatch?.[1]).toMatch(/background:\s*var\(--primary\)/);
    expect(primaryRuleMatch?.[1]).toMatch(/color:\s*var\(--primary-foreground\)/);

    const primaryHoverMatch = /button\.primary:hover,\s*\n?\s*\.button\.primary:hover\s*{([^}]*)}/.exec(globalsCss);
    expect(primaryHoverMatch, "expected a combined button.primary:hover, .button.primary:hover rule").not.toBeNull();
  });

  it("gives the auto-focused 'Refused' alert a themed :focus ring, not the browser default", () => {
    const alertRingMatch = /\.flash\.error:focus\s*{([^}]*)}/.exec(globalsCss);
    expect(alertRingMatch, "expected a .flash.error:focus rule").not.toBeNull();
    expect(alertRingMatch?.[1]).toMatch(/outline:\s*2px solid var\(--ring\)/);
  });

  it("fills the install checklist's toggle button solid when aria-pressed, not just its check-mark", () => {
    const pressedMatch = /\.check-row button\[aria-pressed="true"\]\s*{([^}]*)}/.exec(globalsCss);
    expect(pressedMatch, "expected a .check-row button[aria-pressed=\"true\"] rule").not.toBeNull();
    expect(pressedMatch?.[1]).toMatch(/background:\s*var\(--foreground\)/);
  });

  it("wraps command-block text instead of relying on horizontal scroll", () => {
    const commandBlockMatch = /pre\.command-block\s*{([^}]*)}/.exec(globalsCss);
    expect(commandBlockMatch).not.toBeNull();
    const body = commandBlockMatch?.[1] ?? "";
    expect(body).toMatch(/white-space:\s*pre-wrap/);
    expect(body).toMatch(/overflow-wrap:\s*anywhere/);
    expect(body).not.toMatch(/overflow-x:\s*auto/);
  });

  // Regression guard for a real bug found while screenshotting the template
  // page: className="row wrap" was meant to invoke a new flex-wrap modifier,
  // but CSS class selectors match by whole token, not by which rule a human
  // meant — it ALSO matched the pre-existing .wrap page-wrapper class
  // (max-width/margin/64px padding), injecting unwanted padding into every
  // pill row. Renamed to .row.multiline; this pins both halves of the fix.
  it("names the pill-row wrap modifier .row.multiline, not .row.wrap (which would collide with .wrap, the page wrapper)", () => {
    const multilineMatch = /\.row\.multiline\s*{([^}]*)}/.exec(globalsCss);
    expect(multilineMatch, "expected a .row.multiline rule").not.toBeNull();
    expect(multilineMatch?.[1]).toMatch(/flex-wrap:\s*wrap/);
    expect(globalsCss).not.toMatch(/\.row\.wrap\b/);
  });

  it("lets long pill text wrap onto multiple lines inside .row.multiline, instead of forcing horizontal overflow", () => {
    // Every other .pill use (version numbers, admin's used/unused status) is
    // a couple of short words, where nowrap is correct — it's what keeps
    // e.g. "UNUSED" from breaking mid-word. The template page's source and
    // connection pills carry long explanatory phrases; a single nowrap flex
    // item can't wrap itself onto a new row, so it forced the page wider
    // than the viewport at 390px. Scoped to .row.multiline .pill rather
    // than loosening the base .pill rule everywhere.
    const overrideMatch = /\.row\.multiline \.pill\s*{([^}]*)}/.exec(globalsCss);
    expect(overrideMatch, "expected a .row.multiline .pill override rule").not.toBeNull();
    expect(overrideMatch?.[1]).toMatch(/white-space:\s*normal/);
  });

  it("has no remaining className=\"row wrap\" usage in app/ (the renamed class is row multiline)", () => {
    const appDir = path.join(here, "../app");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".tsx")) {
          if (/className="row wrap"/.test(readFileSync(full, "utf8"))) {
            offenders.push(full);
          }
        }
      }
    };
    walk(appDir);
    expect(offenders).toEqual([]);
  });
});

describe("app icon", () => {
  it("app/icon.svg exists, so /favicon.ico is no longer the only icon Chrome tries", () => {
    expect(existsSync(path.join(here, "../app/icon.svg"))).toBe(true);
  });
});
