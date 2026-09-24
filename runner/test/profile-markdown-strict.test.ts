import { randomUUID } from "node:crypto";
import { SOURCE_CATEGORIES } from "@workflow-catalog/contracts";
import { describe, expect, it } from "vitest";
import { evidenceText, formatUtc, readMarkdownEdits, renderProfileMarkdown } from "../store/profile-markdown.ts";
import { reduce, type Action } from "../store/profile-reducer.ts";
import { createInitialProfile, type OnboardingProfile } from "../store/profile-types.ts";

/**
 * P03 revision 2: career-profile.md's rendering changes (a human UTC time,
 * VN8's indented continuation lines, notes, the proposed-revisions section,
 * the `_None yet._` placeholder) and D9's strict reader, which reports any
 * edit it can't apply instead of dropping it.
 */

const NOW = "2026-09-22T09:05:00.000Z";
const LATER = "2026-09-22T14:30:00.000Z";

function apply(profile: OnboardingProfile, action: Action): OnboardingProfile {
  const result = reduce(profile, action);
  expect(result.ok, result.message).toBe(true);
  return result.profile;
}

/** Sources accounted, one confirmed claim (Harbor) and one metric with an open question and a note. */
function sample(): OnboardingProfile {
  let profile = createInitialProfile(randomUUID);
  for (const category of SOURCE_CATEGORIES) profile = apply(profile, { type: "accountSource", category, status: category === "resume" ? "provided" : "not_applicable" });
  profile = apply(profile, {
    type: "extractClaims",
    category: "resume",
    extracted: [
      { text: "Worked on the Harbor deployment pipeline.", kind: "fact", evidenceRef: "resume.md#harbor", evidenceQuote: "Harbor internal deployment pipeline" },
      { text: "Cut report time by 30%.", kind: "metric", evidenceRef: "resume.md#reports", evidenceQuote: "Cut report time by 30%" },
    ],
    now: NOW,
    newId: randomUUID,
  });
  const [harbor, metric] = profile.claims;
  profile = apply(profile, { type: "decideClaim", claimId: harbor!.id, decision: "confirmed", now: NOW, newId: randomUUID });
  profile = apply(profile, { type: "decideClaim", claimId: metric!.id, decision: "disputed", now: NOW, newId: randomUUID, question: "Measured against what,\nand over what period?" });
  return apply(profile, { type: "recordQuestionNote", claimId: metric!.id, note: "I think it was the Q3 report.\nI need to check.", now: NOW, newId: randomUUID });
}

function problem(profile: OnboardingProfile, markdown: string): string {
  const read = readMarkdownEdits(profile, markdown);
  expect(read.ok).toBe(false);
  return read.ok ? "" : read.problem;
}

describe("career-profile.md rendering (revision 2)", () => {
  it("shows the approval time for a person, in UTC, not a raw ISO string", () => {
    expect(formatUtc("2026-09-22T14:05:09.000Z")).toBe("22 September 2026 at 14:05 UTC");
    let profile = sample();
    profile = apply(profile, { type: "answerQuestion", claimId: profile.claims[1]!.id, hasEvidence: false, now: NOW, newId: randomUUID });
    profile = apply(profile, { type: "approve", now: LATER });
    const markdown = renderProfileMarkdown(profile);
    expect(markdown).toContain("Approved as version 1 on 22 September 2026 at 14:30 UTC.");
    expect(markdown).not.toContain(LATER);
  });

  it("VN8: indents every later line of a multi-line question and note, so they stay inside their bullet", () => {
    const markdown = renderProfileMarkdown(sample());
    expect(markdown).toContain("  - **Question:** Measured against what,\n    and over what period?");
    expect(markdown).toContain("  - **Your note:** I think it was the Q3 report.\n    I need to check.");
  });

  it("VN8: indents a multi-line evidence quote too", () => {
    let profile = sample();
    const metric = profile.claims[1]!;
    profile = apply(profile, { type: "answerQuestion", claimId: metric.id, hasEvidence: true, statement: "From the reporting dashboard.\nQ3 against Q2.", now: LATER, newId: randomUUID });
    expect(renderProfileMarkdown(profile)).toContain('  - **Evidence:** your own statement: "From the reporting dashboard.\n    Q3 against Q2."');
  });

  it("VN3: an empty section shows its placeholder", () => {
    const markdown = renderProfileMarkdown(createInitialProfile(randomUUID));
    expect(markdown).toContain("## Confirmed claims\n\n_None yet._\n");
    expect(markdown).toContain("## Needs a decision\n\n_Nothing waiting on you._\n");
    expect(markdown).toContain("## Excluded\n\nKept here, visibly, so you can see what was left out. Never used in a generated document.\n\n_None excluded._\n");
    expect(markdown).toContain("## Preferences\n\n_None recorded yet._\n");
  });

  it("names a passage's ref, and says so plainly when a claim was confirmed without detail", () => {
    let profile = sample();
    expect(renderProfileMarkdown(profile)).toContain('  - **Evidence:** "Harbor internal deployment pipeline" (resume.md#harbor)');
    profile = apply(profile, { type: "answerQuestion", claimId: profile.claims[1]!.id, hasEvidence: true, now: LATER, newId: randomUUID });
    expect(renderProfileMarkdown(profile)).toContain("  - **Evidence:** you confirmed it without adding detail.");
  });

  it("lists proposed revisions while approved, and explains a withdrawal once it happens", () => {
    let profile = sample();
    const [harbor, metric] = profile.claims;
    profile = apply(profile, { type: "answerQuestion", claimId: metric!.id, hasEvidence: true, statement: "Q3 dashboard.", now: NOW, newId: randomUUID });
    profile = apply(profile, { type: "approve", now: NOW });
    profile = apply(profile, { type: "editClaimText", claimId: harbor!.id, text: "Rebuilt the Harbor deployment pipeline.", now: LATER, newId: randomUUID });
    const approved = renderProfileMarkdown(profile);
    expect(approved).toContain("## Proposed revisions\n\nVersion 1 stays in force until you accept or reject each of these on the Profile page.");
    expect(approved).toContain("- To the claim “Worked on the Harbor deployment pipeline.”, proposed 22 September 2026 at 14:30 UTC:\n  - Rebuilt the Harbor deployment pipeline.");

    profile = apply(profile, { type: "decideClaim", claimId: metric!.id, decision: "disputed", now: LATER, newId: randomUUID, question: "Which quarter?" });
    const withdrawn = renderProfileMarkdown(profile);
    expect(withdrawn).toContain(
      "Not approved. Approval of version 1 was withdrawn on 22 September 2026 at 14:30 UTC because the claim “Cut report time by 30%.” got an open question. Answer any open question, then approve again.",
    );
    expect(withdrawn).not.toContain("## Proposed revisions");
    expect(withdrawn).toContain("- Rebuilt the Harbor deployment pipeline. `[");
  });
});

describe("D9: readMarkdownEdits, the strict reader", () => {
  it("reads an unchanged render as no edit at all", () => {
    const profile = sample();
    const read = readMarkdownEdits(profile, renderProfileMarkdown(profile));
    expect(read.ok).toBe(true);
    if (read.ok) {
      for (const claim of profile.claims) expect(read.edits.get(claim.id)).toBe(claim.text);
      for (const boundary of profile.boundaries) expect(read.edits.get(boundary.id)).toBe(boundary.text);
    }
  });

  it("reads a text edit, including one that adds a line", () => {
    const profile = sample();
    const harbor = profile.claims[0]!;
    const edited = renderProfileMarkdown(profile).replace(`- Worked on the Harbor deployment pipeline. \`[${harbor.id}]\``, `- Rebuilt the Harbor deployment pipeline,\n  with a rollback plan. \`[${harbor.id}]\``);
    const read = readMarkdownEdits(profile, edited);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.edits.get(harbor.id)).toBe("Rebuilt the Harbor deployment pipeline,\nwith a rollback plan.");
  });

  it("ignores what editors do on their own: CRLF line endings, trailing spaces, extra blank lines", () => {
    const profile = sample();
    const edited = `${renderProfileMarkdown(profile).replace(/\n/g, "  \r\n")}\r\n\r\n`;
    expect(readMarkdownEdits(profile, edited).ok).toBe(true);
  });

  it("refuses a removed marker, naming the claim", () => {
    const profile = sample();
    const harbor = profile.claims[0]!;
    const edited = renderProfileMarkdown(profile).replace(` \`[${harbor.id}]\``, "");
    // J3: named by line number and by its words, never by the marker's id.
    expect(problem(profile, edited)).toBe("Line 9: the line for the claim “Worked on the Harbor deployment pipeline.” is missing, or its marker was changed. Put it back as it was.");
  });

  it("refuses a damaged marker", () => {
    const profile = sample();
    const boundary = profile.boundaries[0]!;
    const edited = renderProfileMarkdown(profile).replace(`\`[${boundary.id}]\``, `\`[${boundary.id}\``);
    expect(problem(profile, edited)).toContain("is missing, or its marker was changed");
  });

  it("refuses a deleted line", () => {
    const profile = sample();
    const boundary = profile.boundaries[1]!;
    const edited = renderProfileMarkdown(profile).replace(`- ${boundary.text} \`[${boundary.id}]\`\n`, "");
    expect(problem(profile, edited)).toContain("the boundary “Do not change employment dates or official titles.” is missing");
  });

  it("refuses a marker that matches nothing, a duplicated marker, and an emptied line", () => {
    const profile = sample();
    const harbor = profile.claims[0]!;
    const markdown = renderProfileMarkdown(profile);
    // J3: an unknown marker is named by its line, and the marker itself is never echoed.
    const unknown = problem(profile, markdown.replace("## Preferences\n\n_None recorded yet._", "## Preferences\n\n- Remote only. `[not-a-real-id]`"));
    expect(unknown).toMatch(/^Line \d+: the marker at the end of this line matches nothing in your profile\. Put back the marker it had\.$/);
    expect(unknown).not.toContain("not-a-real-id");
    const twice = problem(profile, markdown.replace("## Preferences\n\n_None recorded yet._", `## Preferences\n\n- Again. \`[${harbor.id}]\``));
    expect(twice).toMatch(/^Lines 9 and \d+ both carry the marker for the claim “Worked on the Harbor deployment pipeline\.”\. Keep one of them\.$/);
    expect(twice).not.toContain(harbor.id);
    // No space before the marker: it isn't read as one, so the claim's line is missing.
    expect(problem(profile, markdown.replace(`- Worked on the Harbor deployment pipeline. \`[${harbor.id}]\``, `- \`[${harbor.id}]\``))).toBe(
      "Line 9: the line for the claim “Worked on the Harbor deployment pipeline.” is missing, or its marker was changed. Put it back as it was.",
    );
    // Only the marker left: the words are gone.
    expect(problem(profile, markdown.replace(`- Worked on the Harbor deployment pipeline. \`[${harbor.id}]\``, `-  \`[${harbor.id}]\``))).toBe(
      "Line 9: the words of the claim “Worked on the Harbor deployment pipeline.” are gone. To leave it out, exclude it on the Onboarding page.",
    );
  });

  it("refuses a new bullet with no marker, instead of dropping it", () => {
    const profile = sample();
    const edited = renderProfileMarkdown(profile).replace("## Preferences\n\n_None recorded yet._", "## Preferences\n\n- Remote-first roles only.");
    expect(problem(profile, edited)).toMatch(/^Line \d+: this line has no marker\. New items can't be added in the file; add them on the Onboarding page\.$/);
  });

  it("refuses a bullet moved to another section", () => {
    const profile = sample();
    const metric = profile.claims[1]!;
    const markdown = renderProfileMarkdown(profile);
    const bullet = `- Cut report time by 30%. \`[${metric.id}]\``;
    const moved = markdown.replace(`${bullet}\n`, "").replace("## Confirmed claims\n\n", `## Confirmed claims\n\n${bullet}\n`);
    expect(problem(profile, moved)).toBe("Line 9: the line for the claim “Cut report time by 30%.” was moved. Put it back where it was.");
  });

  it("refuses an edit to a line that is never read back: evidence, a question, a heading", () => {
    const profile = sample();
    const markdown = renderProfileMarkdown(profile);
    expect(problem(profile, markdown.replace("(resume.md#harbor)", "(my own memory)"))).toBe(
      "Line 10: only the words before a marker can be edited. This line should read “- **Evidence:** \"Harbor internal deployment pipeline\" (resume.md#harbor)”.",
    );
    expect(problem(profile, markdown.replace("Measured against what,", "Measured against the Q2 report,"))).toContain("only the words before a marker can be edited");
    expect(problem(profile, markdown.replace("## Excluded", "## Left out"))).toContain("only the words before a marker can be edited");
  });

  it("P03.2 (round-4 reviewer probe 2): a problem's echoed text hides anything marker-shaped and cuts off past 80 characters (profile-markdown.ts:353)", () => {
    // Evidence lines are never read back (they carry no marker), so an edit to one falls into the
    // "only the words before a marker can be edited" problem, which echoes the line via clip(). That
    // makes them the one place a hostile or merely long evidence quote reaches clip()'s two defenses.
    let profile = createInitialProfile(randomUUID);
    profile = apply(profile, { type: "accountSource", category: "resume", status: "provided" });
    profile = apply(profile, {
      type: "extractClaims",
      category: "resume",
      extracted: [
        // A marker-shaped substring in the middle of the quote (escapeLine only ever touches the end
        // of a line) must still never reach a person-facing message: clip hides it too (defense in depth, J3).
        { text: "Cut deploy time in half.", kind: "fact", evidenceRef: "resume.md#a", evidenceQuote: "Uses the `[legacy-system]` pipeline daily." },
        // Long enough, once rendered with its **Evidence:** prefix and (ref) suffix, that clip's 80-character cut applies.
        {
          text: "Rebuilt the pipeline.",
          kind: "fact",
          evidenceRef: "resume.md#b",
          evidenceQuote: "Rebuilt the entire payments reconciliation pipeline from the ground up over one very long, very difficult quarter.",
        },
      ],
      now: NOW,
      newId: randomUUID,
    });
    const [embedded, long] = profile.claims;
    // Only a confirmed claim renders an **Evidence:** line (toMarkdownView).
    profile = apply(profile, { type: "decideClaim", claimId: embedded!.id, decision: "confirmed", now: NOW, newId: randomUUID });
    profile = apply(profile, { type: "decideClaim", claimId: long!.id, decision: "confirmed", now: NOW, newId: randomUUID });
    const markdown = renderProfileMarkdown(profile);

    const embeddedEvidence = `- **Evidence:** ${evidenceText(embedded!)}`;
    expect(markdown).toContain(embeddedEvidence);
    expect(embeddedEvidence.length).toBeLessThanOrEqual(80); // isolates marker-hiding from truncation
    const embeddedProblem = problem(profile, markdown.replace(embeddedEvidence, `${embeddedEvidence} (verified)`));
    expect(embeddedProblem).toContain(`only the words before a marker can be edited. This line should read “${embeddedEvidence.replace("`[legacy-system]`", "`[…]`")}”.`);
    expect(embeddedProblem).not.toContain("legacy-system");

    const longEvidence = `- **Evidence:** ${evidenceText(long!)}`;
    expect(markdown).toContain(longEvidence);
    expect(longEvidence.length).toBeGreaterThan(80);
    const longProblem = problem(profile, markdown.replace(longEvidence, `${longEvidence} (verified)`));
    const clipped = /should read “([^”]*)”/.exec(longProblem)?.[1];
    expect(clipped).toBe(`${longEvidence.slice(0, 79)}…`);
    expect(clipped).toHaveLength(80);
  });
});
