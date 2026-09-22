import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillsDir = path.resolve(here, "../skills");

const EXPECTED_SKILLS = [
  "onboarding-accounting",
  "claim-extraction",
  "follow-up-questions",
  "requirements-extraction",
  "claim-matching",
  "resume-drafting",
  "cover-letter-drafting",
  "revision-diff",
];

/**
 * Minimal, dependency-free frontmatter parser. SKILL.md frontmatter here is
 * always flat `key: value` pairs (eve reads `name`/`description`, optional
 * `license`/`metadata` — docs/spec/research/eve-runtime.md §2), so a full
 * YAML parser is unneeded; kept intentionally small rather than adding a
 * new dependency for two string fields.
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error("SKILL.md does not start with a --- frontmatter block");
  }
  const [, fmBlock, body] = match;
  const frontmatter: Record<string, string> = {};
  for (const line of fmBlock!.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    if (idx === -1) throw new Error(`malformed frontmatter line: "${line}"`);
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }
  return { frontmatter, body: body ?? "" };
}

function neverSectionItems(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const startIdx = lines.findIndex((line) => /^##\s+Never\s*$/i.test(line.trim()));
  if (startIdx === -1) return [];
  const items: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^##\s+/.test(line)) break;
    if (/^-\s+\S/.test(line.trim())) items.push(line.trim());
  }
  return items;
}

describe("skills/", () => {
  const actualSkillDirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  it("contains exactly the eight P01 skills", () => {
    expect(actualSkillDirs).toEqual([...EXPECTED_SKILLS].sort());
  });

  for (const skillName of EXPECTED_SKILLS) {
    describe(skillName, () => {
      const skillPath = path.join(skillsDir, skillName, "SKILL.md");

      it("SKILL.md exists and its frontmatter parses", () => {
        const content = readFileSync(skillPath, "utf8");
        expect(() => parseFrontmatter(content)).not.toThrow();
      });

      it("has a non-empty name equal to its directory", () => {
        const { frontmatter } = parseFrontmatter(readFileSync(skillPath, "utf8"));
        expect(frontmatter.name).toBeTruthy();
        expect(frontmatter.name).toBe(skillName);
      });

      it("has a non-empty description (eve requires it)", () => {
        const { frontmatter } = parseFrontmatter(readFileSync(skillPath, "utf8"));
        expect(frontmatter.description).toBeTruthy();
        expect(frontmatter.description!.length).toBeGreaterThan(10);
      });

      it("has a ## Never section with at least one item", () => {
        const { body } = parseFrontmatter(readFileSync(skillPath, "utf8"));
        const items = neverSectionItems(body);
        expect(items.length).toBeGreaterThan(0);
      });
    });
  }
});
