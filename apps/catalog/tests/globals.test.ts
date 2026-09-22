import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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

  it("globals.css remaps --font-sans and --font-mono to the next/font variables", () => {
    expect(globalsCss).toMatch(/--font-sans:\s*var\(--font-geist-sans\)/);
    expect(globalsCss).toMatch(/--font-mono:\s*var\(--font-geist-mono\)/);
  });
});
