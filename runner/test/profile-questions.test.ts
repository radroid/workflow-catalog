import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALWAYS_ASK_KINDS, ALWAYS_ASK_WORDS, draftQuestion, needsQuestion, questionReason, usesAlwaysAskWord } from "../store/profile-questions.ts";

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

describe("questionReason (revision 3, J6.4): why a claim gets a question, named by its real trigger", () => {
  it("names a kind that always asks", () => {
    expect(questionReason({ kind: "metric", text: "Cut deploy time in half." })).toBe("it's a metric claim");
    expect(questionReason({ kind: "title", text: "Staff engineer." })).toBe("it's a title claim");
    expect(questionReason({ kind: "date", text: "Joined Northwind Labs in 2021." })).toBe("it's a date claim");
    // The kind wins over a word: a metric that also says "Led" is asked because it's a metric.
    expect(questionReason({ kind: "metric", text: "Led a 30% cut in deploy time." })).toBe("it's a metric claim");
  });

  it("otherwise quotes the always-ask word as written, the earliest one in the text", () => {
    expect(questionReason({ kind: "fact", text: "Led the payments team." })).toBe("it says “Led”");
    expect(questionReason({ kind: "credential", text: "The only certified operator on the team." })).toBe("it says “The only”");
    expect(questionReason({ kind: "fact", text: "Maintainer of Ledgerkit, which I founded." })).toBe("it says “Maintainer”");
    expect(questionReason({ kind: "fact", text: "Ledgerkit is used by 40 teams; I led it." })).toBe("it says “used by”");
  });

  it("is undefined when nothing mechanical asks: a claim disputed by hand", () => {
    expect(questionReason({ kind: "fact", text: "Worked on the payments team." })).toBeUndefined();
    expect(questionReason({ kind: "fact", text: "This is unledded text." })).toBeUndefined();
    // Agrees with needsQuestion everywhere.
    for (const claim of [
      { kind: "fact", text: "Founded Quill." },
      { kind: "credential", text: "B.S. Computer Science." },
      { kind: "fact", text: "The fastest release on the team." },
    ] as const) {
      expect(questionReason(claim) !== undefined).toBe(needsQuestion(claim));
    }
  });
});
