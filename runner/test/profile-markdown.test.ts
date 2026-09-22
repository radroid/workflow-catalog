import { describe, expect, it } from "vitest";
import { createInitialProfile } from "../store/profile-types.ts";
import { reduce } from "../store/profile-reducer.ts";
import { applyMarkdownEdits, parseProfileMarkdownEdits, renderProfileMarkdown } from "../store/profile-markdown.ts";

/**
 * `career-profile.md`'s round trip (mvp-spec §3 F5's accept test: "render →
 * edit one claim's text → parse → render equals expected"), plus the
 * section-agnostic id-marker parsing it depends on.
 */

function idGen(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

const NOW = "2026-01-01T00:00:00.000Z";

describe("profile-markdown", () => {
  it("renders the six mvp-spec §3 F5 sections in order, each `[id]`-marked", () => {
    const newId = idGen("id");
    let profile = createInitialProfile(newId);
    profile = reduce(profile, { type: "accountSource", category: "resume", status: "provided" }).profile;
    profile = reduce(profile, {
      type: "extractClaims",
      category: "resume",
      extracted: [{ text: "Led the payments team.", kind: "fact", evidenceRef: "resume.md#a", evidenceQuote: "Led the payments team" }],
      now: NOW,
      newId,
    }).profile;
    const claimId = profile.claims[0]!.id;
    profile = reduce(profile, { type: "decideClaim", claimId, decision: "confirmed", now: NOW, newId }).profile;

    const markdown = renderProfileMarkdown(profile);
    const headings = ["# Career profile", "## Confirmed claims", "## Presentation that can change", "## Needs a decision", "## Excluded", "## Boundaries", "## Preferences"];
    let cursor = -1;
    for (const heading of headings) {
      const at = markdown.indexOf(heading);
      expect(at, `expected to find "${heading}" after position ${cursor}`).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(markdown).toContain(`Led the payments team. \`[${claimId}]\``);
    expect(markdown).toContain(`\`[${profile.boundaries[0]!.id}]\``);
  });

  it("round-trips a text edit: render, edit one claim's text, parse, apply, render equals expected", () => {
    const newId = idGen("id");
    let profile = createInitialProfile(newId);
    profile = reduce(profile, { type: "accountSource", category: "resume", status: "provided" }).profile;
    profile = reduce(profile, {
      type: "extractClaims",
      category: "resume",
      extracted: [
        { text: "Led the payments team.", kind: "fact", evidenceRef: "resume.md#a", evidenceQuote: "Led the payments team" },
        { text: "B.S. Computer Science.", kind: "credential", evidenceRef: "resume.md#b", evidenceQuote: "B.S." },
      ],
      now: NOW,
      newId,
    }).profile;
    const [claimA, claimB] = profile.claims;
    profile = reduce(profile, { type: "decideClaim", claimId: claimA!.id, decision: "confirmed", now: NOW, newId }).profile;
    profile = reduce(profile, { type: "decideClaim", claimId: claimB!.id, decision: "confirmed", now: NOW, newId }).profile;

    const original = renderProfileMarkdown(profile);
    const edited = original.replace(`Led the payments team. \`[${claimA!.id}]\``, `Led the core payments team. \`[${claimA!.id}]\``);
    expect(edited).not.toBe(original);

    const updatedProfile = applyMarkdownEdits(profile, edited);
    expect(updatedProfile.claims.find((c) => c.id === claimA!.id)?.text).toBe("Led the core payments team.");
    expect(updatedProfile.claims.find((c) => c.id === claimB!.id)?.text).toBe("B.S. Computer Science."); // untouched

    const rerendered = renderProfileMarkdown(updatedProfile);
    const expected = renderProfileMarkdown({ ...profile, claims: profile.claims.map((c) => (c.id === claimA!.id ? { ...c, text: "Led the core payments team." } : c)) });
    expect(rerendered).toBe(expected);
  });

  it("parses every `[id]`-marked line, section-agnostic: boundaries and preferences edit the same way as claims", () => {
    const newId = idGen("id");
    const profile = createInitialProfile(newId);
    const markdown = renderProfileMarkdown(profile);
    const boundaryId = profile.boundaries[0]!.id;
    const edited = markdown.replace(`Do not invent metrics, credentials, or responsibilities. \`[${boundaryId}]\``, `Never invent a metric, credential, or responsibility. \`[${boundaryId}]\``);

    const edits = parseProfileMarkdownEdits(edited);
    expect(edits.get(boundaryId)).toBe("Never invent a metric, credential, or responsibility.");

    const updated = applyMarkdownEdits(profile, edited);
    expect(updated.boundaries.find((b) => b.id === boundaryId)?.text).toBe("Never invent a metric, credential, or responsibility.");
    expect(updated.boundaries[1]).toEqual(profile.boundaries[1]); // the second boundary is untouched
  });

  it("ignores an id in the markdown that matches no claim or statement — editing the file cannot invent a new claim", () => {
    const newId = idGen("id");
    const profile = createInitialProfile(newId);
    const markdown = `${renderProfileMarkdown(profile)}\n- A fact nobody extracted. \`[not-a-real-id]\`\n`;
    const updated = applyMarkdownEdits(profile, markdown);
    expect(updated.claims).toEqual(profile.claims);
    expect(updated.boundaries).toEqual(profile.boundaries);
  });

  it("is a no-op when the markdown carries no marked-line edits", () => {
    const newId = idGen("id");
    const profile = createInitialProfile(newId);
    const updated = applyMarkdownEdits(profile, "# Career profile\n\nNo markers here.\n");
    expect(updated).toBe(profile); // same reference: reducer-style, no unnecessary copy
  });

  describe("D5: multi-line text round-trips", () => {
    // A tiny seeded PRNG (mulberry32) — deterministic, no new dependency, so a
    // failure always reproduces from the printed seed. Generates 1-4 line
    // claim/statement text, some lines short, some long, to reproduce R8's
    // exact failure mode: "Ran the migration\n- Owned the rollback plan"
    // (a continuation line that itself starts with "- ") collapsing to just
    // its last line once round-tripped through the old single-line regex.
    function mulberry32(seed: number): () => number {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const WORDS = ["Ran", "the", "migration", "Owned", "rollback", "plan", "-", "led", "a", "team", "of", "engineers", "across", "three", "quarters", "`weird`", "[brackets]"];

    function randomLine(rand: () => number): string {
      const wordCount = 1 + Math.floor(rand() * 5);
      const words: string[] = [];
      for (let i = 0; i < wordCount; i++) words.push(WORDS[Math.floor(rand() * WORDS.length)]!);
      return words.join(" ");
    }

    /** 1-4 non-empty lines, joined with `\n` — some lines deliberately start with "-" (R8's exact repro) or contain a stray backtick/bracket, to prove those don't get confused for a new bullet or an id marker mid-text. */
    function randomMultiLineText(rand: () => number): string {
      const lineCount = 1 + Math.floor(rand() * 4);
      const lines: string[] = [];
      for (let i = 0; i < lineCount; i++) {
        const line = randomLine(rand);
        lines.push(rand() < 0.3 ? `- ${line}` : line);
      }
      return lines.join("\n");
    }

    for (let seed = 1; seed <= 60; seed++) {
      it(`round-trips a generated multi-line claim text (seed ${seed})`, () => {
        const rand = mulberry32(seed);
        const text = randomMultiLineText(rand);
        const newId = idGen("id");
        let profile = createInitialProfile(newId);
        profile = reduce(profile, { type: "accountSource", category: "resume", status: "provided" }).profile;
        profile = reduce(profile, {
          type: "extractClaims",
          category: "resume",
          extracted: [{ text, kind: "fact", evidenceRef: "resume.md#a", evidenceQuote: "seed" }],
          now: NOW,
          newId,
        }).profile;
        const claimId = profile.claims[0]!.id;
        profile = reduce(profile, { type: "decideClaim", claimId, decision: "confirmed", now: NOW, newId }).profile;

        const rendered = renderProfileMarkdown(profile);
        const edits = parseProfileMarkdownEdits(rendered);
        expect(edits.get(claimId), `seed ${seed}, generated text: ${JSON.stringify(text)}`).toBe(text);

        // Saving the markdown back UNCHANGED must reproduce the same profile exactly (R8's "saving unchanged markdown must not lose text").
        const roundTripped = applyMarkdownEdits(profile, rendered);
        expect(roundTripped).toEqual(profile);
        expect(renderProfileMarkdown(roundTripped)).toBe(rendered);
      });
    }

    it("round-trips a multi-line boundary edit too — the marker convention is section-agnostic", () => {
      const rand = mulberry32(4242);
      const newId = idGen("id");
      const profile = createInitialProfile(newId);
      const boundaryId = profile.boundaries[0]!.id;
      const text = randomMultiLineText(rand);
      const rendered = renderProfileMarkdown(profile);
      const replacementLines = text.split("\n").map((l, i) => (i === 0 ? `- ${l}` : `  ${l}`));
      replacementLines[replacementLines.length - 1] += ` \`[${boundaryId}]\``;
      const edited = rendered.replace(`- Do not invent metrics, credentials, or responsibilities. \`[${boundaryId}]\``, () => replacementLines.join("\n"));

      const edits = parseProfileMarkdownEdits(edited);
      expect(edits.get(boundaryId)).toBe(text);
      const updated = applyMarkdownEdits(profile, edited);
      expect(updated.boundaries.find((b) => b.id === boundaryId)?.text).toBe(text);
    });
  });
});
