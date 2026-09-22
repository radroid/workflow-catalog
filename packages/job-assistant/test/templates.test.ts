import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.resolve(here, "../templates");

/**
 * String-level smoke checks only — no Handlebars dependency added to
 * actually render these (the P01 packet spec: "a render smoke test is
 * welcome but not required"). This still catches the two things most
 * likely to silently break the templates: a renamed/missing required
 * section heading, and a statement loop that stopped citing its claim ID.
 */

describe("templates/career-profile.md.hbs", () => {
  const content = readFileSync(path.join(templatesDir, "career-profile.md.hbs"), "utf8");

  it("has the exact six required section headings, in order", () => {
    const required = [
      "## Confirmed claims",
      "## Presentation that can change",
      "## Needs a decision",
      "## Excluded",
      "## Boundaries",
      "## Preferences",
    ];
    let searchFrom = 0;
    for (const heading of required) {
      const idx = content.indexOf(heading, searchFrom);
      expect(idx, `missing or out-of-order heading: "${heading}"`).toBeGreaterThanOrEqual(0);
      searchFrom = idx + heading.length;
    }
  });

  it("renders every claim with its id", () => {
    expect(content).toMatch(/\{\{this\.id\}\}/);
  });
});

describe("templates/resume.md.hbs", () => {
  const content = readFileSync(path.join(templatesDir, "resume.md.hbs"), "utf8");

  it("cites claim ids for each statement", () => {
    expect(content).toMatch(/claimIds/);
  });
});

describe("templates/cover-letter.md.hbs", () => {
  const content = readFileSync(path.join(templatesDir, "cover-letter.md.hbs"), "utf8");

  it("cites claim ids for each statement", () => {
    expect(content).toMatch(/claimIds/);
  });
});
