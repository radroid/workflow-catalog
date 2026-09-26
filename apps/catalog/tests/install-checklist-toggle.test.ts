import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const installPage = readFileSync(path.join(here, "../app/(gated)/install/page.tsx"), "utf8");

// Regression coverage for a P09-B must-fix: the checklist toggle buttons
// used to flip their own visible+accessible text between "Mark done" and
// "Undo". Per the ARIA APG toggle-button pattern a toggle's accessible name
// must stay constant across states (e.g. a mute button always reads "Mute",
// never "Unmute") — aria-pressed alone carries which state it's in. This
// repo has no React-rendering test harness (every existing test drives
// server logic directly or, for CSS/JSX facts, reads source as text — see
// tests/globals.test.ts); these assertions follow that same convention.
describe("install checklist toggle — constant accessible name (ARIA APG toggle button)", () => {
  it("never renders two different words for the two states", () => {
    expect(installPage).not.toMatch(/isChecked\s*\?\s*"Undo"\s*:\s*"Mark done"/);
    // The button's own JSX children (not prose in a comment elsewhere in the
    // file) must be the single constant word, immediately followed by the
    // closing </button>.
    const buttonBodyMatch = /<button type="submit" className="small" aria-pressed={isChecked}>([\s\S]*?)<\/button>/.exec(
      installPage,
    );
    expect(buttonBodyMatch, "expected to find the checklist toggle <button>").not.toBeNull();
    expect(buttonBodyMatch?.[1]).not.toMatch(/Undo/);
    expect(buttonBodyMatch?.[1]).not.toMatch(/Mark done/);
  });

  it("renders a constant visible word alongside aria-pressed carrying the state", () => {
    expect(installPage).toMatch(/aria-pressed={isChecked}/);
    // The visually-hidden per-item prefix keeps each button's *accessible
    // name* distinct even though the *visible* word is now always the same.
    expect(installPage).toMatch(/<span className="visually-hidden">{item\.label} — <\/span>\s*\n\s*Done/);
  });

  it("keeps the item-specific visually-hidden prefix so five buttons stay distinguishable", () => {
    expect(installPage).toMatch(/className="visually-hidden">{item\.label} — </);
  });
});
