import { describe, expect, it } from "vitest";
import { createInitialProfile } from "../store/profile-types.ts";
import { cleanText, reduce } from "../store/profile-reducer.ts";
import { applyMarkdownEdits, parseProfileMarkdownEdits, readMarkdownEdits, renderProfileMarkdown } from "../store/profile-markdown.ts";

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

/** A tiny seeded PRNG (mulberry32): deterministic, no new dependency, so a failure always reproduces from the printed seed. */
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
    // Generates 1-4 line claim/statement text, some lines short, some long,
    // to reproduce R8's exact failure mode: "Ran the migration\n- Owned the
    // rollback plan" (a continuation line that itself starts with "- ")
    // collapsing to just its last line once round-tripped through the old
    // single-line regex.
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

        // D9 (revision 2): the strict reader the store uses reads the same text back, and nothing else.
        const strict = readMarkdownEdits(profile, rendered);
        expect(strict.ok, strict.ok ? "" : strict.problem).toBe(true);
        if (strict.ok) expect(strict.edits.get(claimId)).toBe(text);
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

describe("N6 (revision 3): marker-shaped text never breaks the runner's own file", () => {
  // Claim text comes from a model reading a source, so a hostile source can
  // make any line of it end in something shaped like a marker: an unknown id,
  // another item's real id, or the claim's own, perhaps followed by
  // backslashes or a no-break space (which the reader's marker pattern also
  // accepts as trailing space).
  const WORDS = ["Ran", "the", "Harbor", "rollout", "at", "Northwind", "Labs", "-", "`[", "]`", "\\"];
  const TAILS = ["", "\\", "\\\\", " ", " \\", " \\"];
  const FAKE_IDS = ["x", "not-a-real-id", "id-999"];

  function pick<T>(rand: () => number, items: readonly T[]): T {
    return items[Math.floor(rand() * items.length)]!;
  }

  function hostileLine(rand: () => number, realIds: readonly string[]): string {
    let line = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => pick(rand, WORDS)).join(" ");
    if (rand() < 0.75) {
      const id = rand() < 0.5 ? pick(rand, realIds) : pick(rand, FAKE_IDS);
      line = `${line}${rand() < 0.8 ? " " : ""}\`[${id}]\`${pick(rand, TAILS)}`;
    }
    return rand() < 0.2 ? `- ${line}` : line;
  }

  function hostileText(rand: () => number, realIds: readonly string[]): string {
    return Array.from({ length: 1 + Math.floor(rand() * 3) }, () => hostileLine(rand, realIds)).join("\n");
  }

  function ok(result: ReturnType<typeof reduce>) {
    expect(result.ok, result.message).toBe(true);
    return result.profile;
  }

  for (let seed = 1; seed <= 40; seed++) {
    it(`reads back hostile claim, evidence, question, note and preference text exactly (seed ${seed})`, () => {
      const rand = mulberry32(9000 + seed);
      const newId = idGen("id");
      let profile = createInitialProfile(newId); // boundaries id-1, id-2; the claims get id-3 and id-4
      profile = ok(reduce(profile, { type: "accountSource", category: "resume", status: "provided" }));
      const realIds = ["id-1", "id-2", "id-3", "id-4"];
      const text = () => hostileText(rand, realIds);
      profile = ok(
        reduce(profile, {
          type: "extractClaims",
          category: "resume",
          extracted: [
            { text: text(), kind: "fact", evidenceRef: "resume.md#a", evidenceQuote: text() },
            { text: text(), kind: "fact", evidenceRef: "resume.md#b", evidenceQuote: "b" },
          ],
          now: NOW,
          newId,
        }),
      );
      const [first, second] = profile.claims;
      profile = ok(reduce(profile, { type: "decideClaim", claimId: first!.id, decision: "confirmed", now: NOW, newId }));
      profile = ok(reduce(profile, { type: "decideClaim", claimId: second!.id, decision: "disputed", question: text(), now: NOW, newId }));
      profile = ok(reduce(profile, { type: "recordQuestionNote", claimId: second!.id, note: text(), now: NOW, newId }));
      profile = ok(reduce(profile, { type: "addStatement", kind: "preference", text: text(), now: NOW, newId }));

      const rendered = renderProfileMarkdown(profile);
      const strict = readMarkdownEdits(profile, rendered);
      expect(strict.ok, strict.ok ? "" : `seed ${seed}: ${strict.problem}\n${rendered}`).toBe(true);
      if (strict.ok) {
        for (const claim of profile.claims) expect(strict.edits.get(claim.id)).toBe(claim.text);
        expect(strict.edits.get(profile.preferences[0]!.id)).toBe(profile.preferences[0]!.text);
      }
      // The lenient reader agrees, and an unchanged save changes nothing.
      expect(applyMarkdownEdits(profile, rendered)).toEqual(profile);

      // A person's edit to the disputed claim's words reads back as exactly that edit.
      const newText = text();
      const edited = renderProfileMarkdown({ ...profile, claims: profile.claims.map((claim) => (claim.id === second!.id ? { ...claim, text: newText } : claim)) });
      const read = readMarkdownEdits(profile, edited);
      expect(read.ok, read.ok ? "" : `seed ${seed}: ${read.problem}`).toBe(true);
      if (read.ok) expect(read.edits.get(second!.id)).toBe(cleanText(newText)); // the store keeps text cleaned (a no-break space can't end it)
    });
  }

  it("escapes only what needs it: a line ending in a marker-shaped token gets one backslash, and nothing else changes", () => {
    const newId = idGen("id");
    let profile = createInitialProfile(newId);
    profile = reduce(profile, { type: "accountSource", category: "resume", status: "provided" }).profile;
    profile = reduce(profile, {
      type: "extractClaims",
      category: "resume",
      extracted: [{ text: "Ran the Harbor rollout `[id-1]`\nand the Quill rollout\\", kind: "fact", evidenceRef: "resume.md#a", evidenceQuote: "Harbor" }],
      now: NOW,
      newId,
    }).profile;
    const markdown = renderProfileMarkdown(profile);
    expect(markdown).toContain("- Ran the Harbor rollout `[id-1]`\\\n  and the Quill rollout\\ `[id-3]`\n");
  });

  it("P03.2 (round-4 reviewer probe 3): nestedLine escapes a marker-shaped question or note too, and leaves an ordinary one alone", () => {
    // The seeded-random suite above already proves hostile nested text (evidence, question, notes) never
    // breaks the document (strict.ok stays true); nested lines are never read back, so that test can't pin
    // down the escape itself the way the bullet-line test above does. This does, directly, on the exact
    // rendered "  - **Question:** …" / "  - **Your note:** …" lines escapeLine produces (profile-markdown.ts:131).
    const newId = idGen("id");
    let profile = createInitialProfile(newId);
    profile = reduce(profile, { type: "accountSource", category: "resume", status: "provided" }).profile;
    profile = reduce(profile, {
      type: "extractClaims",
      category: "resume",
      extracted: [{ text: "Cut deploy time.", kind: "metric", evidenceRef: "resume.md#a", evidenceQuote: "Cut deploy time" }],
      now: NOW,
      newId,
    }).profile;
    const claimId = profile.claims[0]!.id;
    // Ends exactly in a marker-shaped token: MARKER_TAIL matches, so it gets one backslash.
    profile = reduce(profile, { type: "decideClaim", claimId, decision: "disputed", question: "Measured against `[id-1]`", now: NOW, newId }).profile;
    profile = reduce(profile, { type: "recordQuestionNote", claimId, note: "Yes, see `[not-a-real-id]`", now: NOW, newId }).profile;

    const markdown = renderProfileMarkdown(profile);
    expect(markdown).toContain("  - **Question:** Measured against `[id-1]`\\\n");
    expect(markdown).toContain("  - **Your note:** Yes, see `[not-a-real-id]`\\\n");

    // An ordinary question, not marker-shaped, is untouched (the same "escapes only what needs it" property).
    profile = reduce(profile, {
      type: "extractClaims",
      category: "resume",
      extracted: [{ text: "Cut build time.", kind: "metric", evidenceRef: "resume.md#b", evidenceQuote: "Cut build time" }],
      now: NOW,
      newId,
    }).profile;
    const claimId2 = profile.claims.at(-1)!.id;
    profile = reduce(profile, { type: "decideClaim", claimId: claimId2, decision: "disputed", question: "Measured against what baseline?", now: NOW, newId }).profile;
    const markdown2 = renderProfileMarkdown(profile);
    expect(markdown2).toContain("  - **Question:** Measured against what baseline?\n");
    expect(markdown2).not.toContain("baseline?\\");
  });
});
