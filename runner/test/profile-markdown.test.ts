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
    profile = reduce(profile, { type: "decideClaim", claimId, decision: "confirmed", now: NOW }).profile;

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
    profile = reduce(profile, { type: "decideClaim", claimId: claimA!.id, decision: "confirmed", now: NOW }).profile;
    profile = reduce(profile, { type: "decideClaim", claimId: claimB!.id, decision: "confirmed", now: NOW }).profile;

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
});
