import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALWAYS_ASK_KINDS, ALWAYS_ASK_WORDS, draftQuestion, needsQuestion, usesAlwaysAskWord } from "../store/profile-questions.ts";

/**
 * P03 revision 1, R4: `profile-questions.ts`'s doc comment says its
 * `ALWAYS_ASK_KINDS`/`ALWAYS_ASK_WORDS` are "kept in sync by hand" with
 * `follow-up-questions/SKILL.md`'s Boundaries section, but nothing in this
 * repo ever checked that by hand-keeping actually held — a title/date
 * silently dropped from `ALWAYS_ASK_KINDS`, or "maintainer" silently dropped
 * from `ALWAYS_ASK_WORDS`, would only ever show up as a claim that should
 * have asked a question and didn't, deep in some other test's assertions
 * (or not at all). This file reads the skill directly and parses the same
 * two lists out of it, exactly the way `packages/job-assistant/test/fixtures.test.ts`
 * already does for the job-assistant package's own fixtures (same regexes,
 * so both tests read the skill the same way) — so a drift between the
 * runner's mechanical copy and the skill's own words fails here, directly,
 * naming which list and which entry.
 */

const SKILL_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "job-assistant", "skills", "follow-up-questions", "SKILL.md");

describe("profile-questions: kept in sync with follow-up-questions/SKILL.md", () => {
  const skill = readFileSync(SKILL_PATH, "utf8");
  const skillKinds = [...skill.matchAll(/^- Every claim with `kind: "(\w+)"` gets a question, no exceptions/gm)].map((match) => match[1]!);
  const wordList = skill.match(/Always-ask words: ((?:`[^`]+`(?:, )?)+)/)?.[1] ?? "";
  const skillWords = [...wordList.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);

  it("the skill itself still names the three always-ask kinds and six always-ask words this test parses (a sanity check on the parse, not on profile-questions.ts)", () => {
    expect(skillKinds).toEqual(["metric", "title", "date"]);
    expect(skillWords).toEqual(["led", "founded", "the only", "fastest", "maintainer", "used by"]);
  });

  it("ALWAYS_ASK_KINDS matches the skill's kinds exactly — dropping title or date here would silently stop always asking about them", () => {
    expect([...ALWAYS_ASK_KINDS].sort()).toEqual([...skillKinds].sort());
  });

  it("ALWAYS_ASK_WORDS matches the skill's words exactly — dropping a word (e.g. \"maintainer\") here would silently stop always asking about it", () => {
    expect([...ALWAYS_ASK_WORDS].sort()).toEqual([...skillWords].sort());
  });
});

describe("needsQuestion / usesAlwaysAskWord / draftQuestion", () => {
  it("every metric, title, and date claim needs a question, no exceptions, even when the text itself is unremarkable", () => {
    expect(needsQuestion({ kind: "metric", text: "Shipped things." })).toBe(true);
    expect(needsQuestion({ kind: "title", text: "Shipped things." })).toBe(true);
    expect(needsQuestion({ kind: "date", text: "Shipped things." })).toBe(true);
  });

  it("a fact or credential claim needs a question only when its text uses an always-ask word, whole-word and case-insensitive", () => {
    expect(needsQuestion({ kind: "fact", text: "Worked on the payments team." })).toBe(false);
    expect(needsQuestion({ kind: "fact", text: "Led the payments team." })).toBe(true);
    expect(needsQuestion({ kind: "fact", text: "LED the payments team." })).toBe(true);
    expect(needsQuestion({ kind: "credential", text: "The only certified operator on the team." })).toBe(true);
    expect(needsQuestion({ kind: "fact", text: "Maintainer of a popular open-source tool." })).toBe(true);
    // Whole-word only: "unledded" contains "led" as a substring, not as a word.
    expect(usesAlwaysAskWord("This is unledded text.")).toBe(false);
  });

  it("draftQuestion never presupposes the answer and names the claim's own text", () => {
    for (const kind of ["metric", "title", "date", "fact", "credential"] as const) {
      const question = draftQuestion({ kind, text: "Cut deploy time in half." });
      expect(question).toContain("Cut deploy time in half.");
      expect(question.trim().endsWith("?")).toBe(true);
    }
  });
});
