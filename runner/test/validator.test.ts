import { readFileSync } from "node:fs";
import path from "node:path";
import { claimSchema, jobSnapshotSchema } from "@workflow-catalog/contracts";
import { describe, expect, it } from "vitest";
import { JOB_ASSISTANT_DIR } from "../lib/paths.ts";
import { labelClaims } from "../validate/claims.ts";
import { credentialsIn, datesIn, numbersIn, titlesIn } from "../validate/facts.ts";
import { citedLabels, splitSentences, strayBrackets, stripCitations } from "../validate/text.ts";
import { describeLocation, validateDraft, type Draft, type ValidationClaim, type ValidationRule } from "../validate/validator.ts";

/**
 * The preparation validator (P05): one test per rule, a good draft that
 * passes them all, and a deliberately bad draft that trips many at once.
 * The claims are the package's own fixture (`expected-claims.json`, fictional
 * data) with their labels by position: C1 payments team (confirmed), C2 the
 * excluded 500% metric, C3 on-call tooling "used by three engineering teams"
 * (confirmed), C4 a candidate Harbor metric, C5 Ledgerkit maintainer, C6 the
 * B.S. (2019), C7 "Started at Northwind Labs in 2022.", C8 "Senior Platform
 * Engineer at Northwind Labs.". The posting is `job-fernwood.json`.
 */

const FIXTURES = path.join(JOB_ASSISTANT_DIR, "fixtures");
const CLAIMS = claimSchema.array().parse(JSON.parse(readFileSync(path.join(FIXTURES, "expected-claims.json"), "utf8")));
const EXCLUDED = claimSchema.parse(JSON.parse(readFileSync(path.join(FIXTURES, "expected-excluded-metric.json"), "utf8")));
const FERNWOOD = jobSnapshotSchema.parse(JSON.parse(readFileSync(path.join(FIXTURES, "job-fernwood.json"), "utf8")));
const LABELLED = labelClaims(CLAIMS);
const POSTING = [FERNWOOD.text, ...(FERNWOOD.structured.requirements ?? []), ...(FERNWOOD.structured.niceToHave ?? [])].join("\n");

function resume(...statements: string[]): Draft {
  return { resume: { sections: [{ heading: "Experience", statements }] } };
}

function check(draft: Draft, coverLetterRequested = false) {
  return validateDraft({ draft, claims: LABELLED, postingText: POSTING, coverLetterRequested });
}

function rules(draft: Draft): ValidationRule[] {
  return check(draft).refusals.map((refusal) => refusal.rule);
}

const GOOD: Draft = {
  resume: {
    sections: [
      {
        heading: "Experience",
        statements: [
          "Senior Platform Engineer at Northwind Labs since 2022 [C8][C7].",
          "Led the payments infrastructure team at Northwind Labs, redesigning the ledger service behind its billing [C1].",
          "Shipped on-call rotation tooling that three engineering teams use [C3].",
        ],
      },
      { heading: "Open source", statements: ["Maintainer of Ledgerkit, an open-source ledger reconciliation library [C5]."] },
      { heading: "Education", statements: ["B.S. Computer Science, Fernwood University, 2019 [C6]."] },
    ],
  },
  coverLetter: {
    paragraphs: [
      ["At Northwind Labs I led the payments infrastructure team and redesigned the ledger service behind its billing [C1].", "I also shipped on-call rotation tooling used by 3 engineering teams [C3]."],
      ["Outside work, I maintain Ledgerkit, an open-source ledger reconciliation library [C5]."],
    ],
  },
};

describe("the fixture labels the validator tests rely on", () => {
  it("C2 is the excluded metric, C4 a candidate, and the rest are confirmed", () => {
    expect(LABELLED.map((claim) => `${claim.label}:${claim.status}`)).toEqual([
      "C1:confirmed",
      "C2:excluded",
      "C3:confirmed",
      "C4:candidate",
      "C5:confirmed",
      "C6:confirmed",
      "C7:confirmed",
      "C8:confirmed",
    ]);
    expect(LABELLED[1]!.id).toBe(EXCLUDED.id);
  });
});

describe("a draft that states only what its cited claims say", () => {
  it("passes every rule, cover letter included", () => {
    const result = check(GOOD, true);
    expect(result.refusals).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("text helpers", () => {
  it("splits sentences, but never at B.S., an initial, a decimal or an abbreviation", () => {
    expect(splitSentences("B.S. Computer Science, Fernwood University, 2019 [C6].")).toEqual(["B.S. Computer Science, Fernwood University, 2019 [C6]."]);
    expect(splitSentences("Cut costs by 3.5 points [C1]. Then shipped it [C3].")).toEqual(["Cut costs by 3.5 points [C1].", "Then shipped it [C3]."]);
    // Revision 1 (V4): a full stop before a lower-case word ends a sentence too, unless it ends an abbreviation.
    // Round 1 kept this as one sentence; each half cites C1, so the draft is judged the same.
    expect(splitSentences("Worked with J. Doe on it [C1]. e.g. this stays [C1].")).toEqual(["Worked with J. Doe on it [C1].", "e.g. this stays [C1]."]);
    expect(splitSentences("Built ASP.NET and Node.js services with a Ph.D. student in the U.S. office [C1].")).toHaveLength(1);
  });

  it("gives markers after a full stop to the sentence before them", () => {
    expect(splitSentences("Led the team. [C1] Shipped the tool. [C3]")).toEqual(["Led the team. [C1]", "Shipped the tool. [C3]"]);
  });

  it("reads labels in any marker form, and strips them all at export", () => {
    expect(citedLabels("Led it [C1, C3] and [C5][C7] `[C8]`.")).toEqual(["C1", "C3", "C5", "C7", "C8"]);
    expect(stripCitations("Led it [C1, C3] and more [C5][C7] `[C8]`.")).toBe("Led it and more.");
    expect(stripCitations("Senior Platform Engineer at Northwind Labs [C8]. [C7]")).toBe("Senior Platform Engineer at Northwind Labs.");
    expect(strayBrackets("Led it [C1] [see here] [C3]")).toEqual(["[see here]"]);
  });

  it("names a location in plain words", () => {
    expect(describeLocation({ part: "resume", section: 0, statement: 1, heading: "Experience" })).toBe("Resume, Experience, bullet 2");
    expect(describeLocation({ part: "cover_letter", section: 1, statement: 0 })).toBe("Cover letter, paragraph 2, sentence 1");
  });

  it("finds numbers, dates, titles and credentials the way the rules compare them", () => {
    expect(numbersIn("Grew signups 500% with a 12-person team, $2.5M, 1,200 users, twenty-five pilots, 3x and doubled").map((fact) => fact.key)).toEqual([
      "500%",
      "12",
      "2500000",
      "1200",
      "25",
      "3x",
      "2x",
    ]);
    expect(numbersIn("three engineering teams").map((fact) => fact.key)).toEqual(numbersIn("3 engineering teams").map((fact) => fact.key));
    expect(numbersIn("Runs on EC2, K8s and B2B in 2022")).toEqual([]);
    expect(datesIn("Joined in March 2022, left 3 June 2024.")).toEqual({ years: ["2022", "2024"], months: [3, 6], endYears: ["2024"], startOnly: false });
    expect(datesIn("You may start in 2022.")).toEqual({ years: ["2022"], months: [], endYears: [], startOnly: true });
    expect(titlesIn("Senior Platform Engineer at Northwind Labs.")).toEqual(["senior platform engineer"]);
    expect(titlesIn("Promoted to Head of Platform, then worked as a staff engineer.")).toEqual(["head of platform", "staff engineer"]);
    expect(titlesIn("Lead the migration with senior engineers.")).toEqual([]);
    expect(credentialsIn("B.S. Computer Science and an M.S. later; AWS Certified.")).toEqual(["bs", "ms", "certified"]);
    expect(credentialsIn("Rotated the TLS certificate on the master branch.")).toEqual([]);
  });
});

describe("one rule at a time", () => {
  it("uncited: every sentence cites, even the second sentence of a bullet", () => {
    expect(rules(resume("Led the payments infrastructure team at Northwind Labs [C1]. Loved every minute of it."))).toEqual(["uncited"]);
    expect(rules(resume("Led the payments infrastructure team at Northwind Labs."))).toEqual(["uncited"]);
  });

  it("stray_marker: square brackets hold labels only", () => {
    expect(rules(resume("Led the payments infrastructure team [see portfolio] [C1]."))).toEqual(["stray_marker"]);
  });

  it("unknown_citation: a label this preparation never gave out", () => {
    expect(rules(resume("Led the payments infrastructure team [C99]."))).toEqual(["unknown_citation"]);
  });

  it("excluded_claim: by label, by id and by wording, and the message never names it", () => {
    const byLabel = check(resume("Grew signups after the launch [C2]."));
    expect(byLabel.refusals.map((refusal) => refusal.rule)).toEqual(["excluded_claim"]);

    const byId = check(resume(`Led the payments infrastructure team (${EXCLUDED.id}) [C1].`));
    expect(byId.refusals.map((refusal) => refusal.rule)).toEqual(["excluded_claim"]);

    const byWording = check(resume("Led the payments infrastructure team after launching the self-serve onboarding flow [C1]."));
    expect(byWording.refusals.map((refusal) => refusal.rule)).toEqual(["excluded_claim"]);

    for (const refusal of [...byLabel.refusals, ...byId.refusals, ...byWording.refusals]) {
      expect(refusal.message).not.toContain(EXCLUDED.id);
      expect(refusal.message).not.toContain(EXCLUDED.text);
      expect(refusal.message.toLowerCase()).not.toContain("exclud");
    }
    // An unknown label and an excluded one read the same to the model.
    const unknown = check(resume("Grew signups after the launch [C99]."));
    expect(byLabel.refusals[0]!.message.replace("C2", "C#")).toBe(unknown.refusals[0]!.message.replace("C99", "C#"));
  });

  it("unconfirmed_citation: a candidate claim is not a fact yet", () => {
    expect(rules(resume("Cut the release time to under an hour [C4]."))).toEqual(["unconfirmed_citation"]);
  });

  it("raw_id: labels only, never an id", () => {
    expect(rules(resume(`Led the payments infrastructure team [C1] (see ${CLAIMS[0]!.id}).`))).toEqual(["raw_id"]);
  });

  it("number: a quantity the cited claims don't state, in digits, words, percent or scale", () => {
    expect(rules(resume("Led a 12-person payments infrastructure team [C1]."))).toEqual(["number"]);
    expect(rules(resume("Shipped on-call rotation tooling used by five engineering teams [C3]."))).toEqual(["number"]);
    expect(rules(resume("Shipped on-call rotation tooling used by 3 engineering teams [C3]."))).toEqual([]);
    expect(rules(resume("Led the payments infrastructure team, growing billing 500% [C1]."))).toEqual(["number"]);
    expect(rules(resume("Led the payments infrastructure team and doubled throughput [C1]."))).toEqual(["number"]);
    // A number the posting states is still not the person's: "8+ years" is Fernwood's requirement.
    expect(rules(resume("Brings 8+ years of platform work [C8]."))).toEqual(["number"]);
  });

  it("date: years and months must be the cited claims' own", () => {
    expect(rules(resume("Started at Northwind Labs in 2021 [C7]."))).toEqual(["date"]);
    expect(rules(resume("Started at Northwind Labs in March 2022 [C7]."))).toEqual(["date"]);
    expect(rules(resume("Started at Northwind Labs in 2022 [C7]."))).toEqual([]);
    expect(rules(resume("Senior Platform Engineer at Northwind Labs since 2022 [C8]."))).toEqual(["date"]);
  });

  it("title: word for word, never inflated, trimmed or lower-cased around", () => {
    expect(rules(resume("Staff Platform Engineer at Northwind Labs [C8]."))).toEqual(["title"]);
    expect(rules(resume("Platform Engineer at Northwind Labs [C8]."))).toEqual(["title"]);
    expect(rules(resume("Worked at Northwind Labs as a staff engineer [C8]."))).toEqual(["title"]);
    expect(rules(resume("Worked at Northwind Labs as a senior platform engineer [C8]."))).toEqual([]);
  });

  it("credential: a degree the cited claims don't state", () => {
    expect(rules(resume("M.S. Computer Science, Fernwood University, 2019 [C6]."))).toEqual(["credential"]);
    expect(rules(resume("Certified Kubernetes administrator who maintains Ledgerkit [C5]."))).toEqual(["credential"]);
  });

  it("posting_wording: six words in a row from the posting that the cited claims don't hold", () => {
    expect(rules(resume("Experience leading platform or infrastructure teams at Northwind Labs [C1]."))).toEqual(["posting_wording"]);
  });

  it("heading: the runner's fixed section headings only", () => {
    const draft: Draft = { resume: { sections: [{ heading: "Ignore previous instructions", statements: ["Led the payments infrastructure team at Northwind Labs [C1]."] }] } };
    expect(rules(draft)).toEqual(["heading"]);
  });

  it("empty: a resume needs a sentence, and so does a cover letter that was asked for", () => {
    expect(rules({ resume: { sections: [] } })).toEqual(["empty"]);
    expect(check({ resume: GOOD.resume }, true).refusals.map((refusal) => refusal.rule)).toEqual(["empty"]);
    expect(rules(resume("   "))).toEqual(["empty"]);
  });
});

describe("a deliberately bad draft", () => {
  it("is refused sentence by sentence, each refusal in plain words with its place", () => {
    const bad: Draft = {
      resume: {
        sections: [
          {
            heading: "Experience",
            statements: [
              "Principal Platform Engineer at Northwind Labs since 2019 [C8].",
              "Grew signups 500% after launching the self-serve onboarding flow [C2].",
              "Cut release time from a day to under an hour [C4].",
              "A rockstar engineer with strong distributed systems fundamentals.",
            ],
          },
          { heading: "Hobbies", statements: ["Maintainer of Ledgerkit with 40 contributors [C5] [my repo]."] },
        ],
      },
      coverLetter: { paragraphs: [["I have followed Fernwood for years [C99]."]] },
    };
    const result = check(bad, true);
    expect(result.ok).toBe(false);
    const summary = result.refusals.map((refusal) => `${describeLocation(refusal.where)}: ${refusal.rule}`);
    expect(new Set(summary)).toEqual(
      new Set([
        "Resume, Experience, bullet 1: title",
        "Resume, Experience, bullet 1: date",
        "Resume, Experience, bullet 2: excluded_claim",
        // 500% is in no confirmed claim, whatever the sentence cites.
        "Resume, Experience, bullet 2: number",
        "Resume, Experience, bullet 3: unconfirmed_citation",
        "Resume, Experience, bullet 4: uncited",
        "Resume, Hobbies, bullet 1: heading",
        "Resume, Hobbies, bullet 1: stray_marker",
        "Resume, Hobbies, bullet 1: number",
        "Cover letter, paragraph 1, sentence 1: unknown_citation",
      ]),
    );
    for (const refusal of result.refusals) {
      expect(refusal.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
      expect(refusal.message).not.toContain(EXCLUDED.text);
    }
  });
});

/**
 * Revision 1 (V1–V4, V10): every probe the round-1 reviewer found passing,
 * each as a whole draft that must now be refused, and the controls that
 * must still pass. The validator only ever got stricter. C9 is a test-local
 * confirmed claim with a closed date range (fictional: Ada Quill at Fernwood
 * Labs); the rest are the fixture's.
 */
const FERNWOOD_LABS: ValidationClaim = { label: "C9", id: "7b1e4f2a-3c5d-4e6f-8a9b-0c1d2e3f4a5b", kind: "title", status: "confirmed", text: "Platform Engineer at Fernwood Labs, 2019–2021." };
const WITH_C9 = [...LABELLED, FERNWOOD_LABS];
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const NEXT_LINE = String.fromCharCode(0x85);

function rulesWithC9(...statements: string[]): ValidationRule[] {
  return validateDraft({ draft: resume(...statements), claims: WITH_C9, postingText: POSTING, coverLetterRequested: false }).refusals.map((refusal) => refusal.rule);
}

describe("revision 1, V1: numbers the claims don't state", () => {
  it.each([
    ["a thousands separator that looks like a year", "Led the payments infrastructure team at Northwind Labs for 1,950 merchants [C1]."],
    ["a round thousand with a separator", "Led the payments infrastructure team at Northwind Labs for 2,000 merchants [C1]."],
    ["a unit glued to the number", "Led the payments infrastructure team at Northwind Labs, cutting latency to 200ms [C1]."],
    ["a size unit glued to the number", "Led the payments infrastructure team at Northwind Labs, moving 5GB a day [C1]."],
    ["scientific notation", "Led the payments infrastructure team at Northwind Labs through 1e6 ledger entries [C1]."],
    ["Arabic-Indic digits", "Led the payments infrastructure team at Northwind Labs, growing billing ٥٠٠% [C1]."],
    ["an ordinal", "Led the payments infrastructure team at Northwind Labs, the 3rd team to adopt it [C1]."],
    ["a multiplier written first", "Led the payments infrastructure team at Northwind Labs, growing billing x3 [C1]."],
    ["a decimal comma", "Led the payments infrastructure team at Northwind Labs with a 3,5 rating [C1]."],
  ])("refuses %s", (_name, statement) => {
    expect(rules(resume(statement))).toEqual(["number"]);
  });

  it("reads a thousands separator as part of one number: 1,200 is 1200, never 1 and 200 (the reviewer's M9)", () => {
    const merchants: ValidationClaim = { label: "C10", id: "3d2c1b0a-9f8e-4d7c-8b6a-5f4e3d2c1b0a", kind: "metric", status: "confirmed", text: "Onboarded 1,200 merchants to the ledger service at Northwind Labs." };
    const withMerchants = (statement: string) => validateDraft({ draft: resume(statement), claims: [...LABELLED, merchants], postingText: POSTING, coverLetterRequested: false }).refusals.map((refusal) => refusal.rule);
    expect(withMerchants("Onboarded 1,200 merchants to the ledger service at Northwind Labs [C10].")).toEqual([]);
    expect(withMerchants("Onboarded 1200 merchants to the ledger service at Northwind Labs [C10].")).toEqual([]);
    // The claim's one number can't be split into two the sentence states.
    expect(withMerchants("Onboarded 200 merchants to the ledger service at Northwind Labs in 1 quarter [C10].")).toEqual(["number"]);
    expect(withMerchants("Onboarded 12 merchants to the ledger service at Northwind Labs [C10].")).toEqual(["number"]);
  });

  it("reads digits of any script as the number they are, and keeps names that start with a letter as names", () => {
    expect(rules(resume("Shipped the on-call rotation tooling used by ٣ engineering teams [C3]."))).toEqual([]);
    expect(numbersIn("Runs on EC2, K8s, P99 and Q3 dashboards")).toEqual([]);
    expect(numbersIn("200ms, 200 ms, 5GB, 1e6, 1,950, 2,000").map((fact) => fact.key)).toEqual(["200", "200", "5", "1000000", "1950", "2000"]);
    // A year is the date rule's, even with letters glued on.
    expect(numbersIn("in 2019 and 2019Q3")).toEqual([]);
    expect(datesIn("in 2019Q3 and FY2021").years).toEqual(["2019", "2021"]);
  });
});

describe("revision 1, V2: titles, however they are written", () => {
  it.each([
    ["an abbreviated seniority", "Sr. Platform Engineer at Fernwood Labs from 2019 to 2021 [C9]."],
    ["a hyphen hiding the role", "Staff Platform-Engineer at Fernwood Labs from 2019 to 2021 [C9]."],
    ["a role word opening the sentence", "Director at Fernwood Labs from 2019 to 2021 [C9]."],
    ["an acronym opening the sentence", "CTO at Fernwood Labs from 2019 to 2021 [C9]."],
    ["an opening role word before a comma", "Architect, Fernwood Labs, 2019–2021 [C9]."],
    ["a lower-case role of something", "Worked as director of platform at Fernwood Labs from 2019 to 2021 [C9]."],
    ["a lower-case role of something opening the sentence", "director of platform at Fernwood Labs from 2019 to 2021 [C9]."],
    ["a lower-case role after a title context", "Promoted to principal engineer at Fernwood Labs in 2021 [C9]."],
  ])("refuses %s", (_name, statement) => {
    expect(rulesWithC9(statement)).toEqual(["title"]);
  });

  it("still passes the title as the claim writes it, and verb-like openings", () => {
    expect(rulesWithC9("Platform Engineer at Fernwood Labs from 2019 to 2021 [C9].")).toEqual([]);
    expect(rulesWithC9("Worked as a platform engineer at Fernwood Labs from 2019 to 2021 [C9].")).toEqual([]);
    expect(titlesIn("Lead the migration at Fernwood Labs, then head the team.")).toEqual([]);
    expect(titlesIn("Sr. Platform Engineer, then Staff Platform-Engineer")).toEqual(["sr platform engineer", "staff platform engineer"]);
  });
});

describe("revision 1, V3: dates that stay open or lose their end", () => {
  it.each([
    ["“since” against a closed range", "Platform Engineer at Fernwood Labs since 2019 [C9]."],
    ["“present” against a closed range", "Platform Engineer at Fernwood Labs, 2019–present [C9]."],
    ["a range left open", "Platform Engineer at Fernwood Labs, 2019– [C9]."],
    ["“currently” against a closed range", "Currently a Platform Engineer at Fernwood Labs, 2019–2021 [C9]."],
    ["“to date” against a closed range", "Platform Engineer at Fernwood Labs from 2019 to date [C9]."],
    ["the start without the end", "Platform Engineer at Fernwood Labs from 2019 [C9]."],
    ["“since” against a single year", "Studied Computer Science since 2019 for the B.S. at Fernwood University [C6]."],
  ])("refuses %s", (_name, statement) => {
    expect(rulesWithC9(statement)).toEqual(["date"]);
  });

  it("passes the range as the claim states it, and an open end on a claim that is itself open", () => {
    // Revision 2, X4(b): a sentence that states no date leaves the range out; it doesn't change it. (Revision 1
    // refused this one, "no dates at all for a claim that ends".)
    expect(rulesWithC9("Platform Engineer at Fernwood Labs [C9].")).toEqual([]);
    expect(rulesWithC9("Platform Engineer at Fernwood Labs, 2019–2021 [C9].")).toEqual([]);
    expect(rulesWithC9("Platform Engineer at Fernwood Labs from 2019 until 2021 [C9].")).toEqual([]);
    // C7, "Started at Northwind Labs in 2022.", states a start and no end: it is open.
    expect(rulesWithC9("Senior Platform Engineer at Northwind Labs since 2022 [C8][C7].")).toEqual([]);
    expect(rulesWithC9("Senior Platform Engineer at Northwind Labs, 2022–present [C8][C7].")).toEqual([]);
    expect(rules(resume("Kept the on-call rotation tooling up to date for three engineering teams [C3]."))).toEqual([]);
  });

  it("names what is wrong, once per sentence", () => {
    const [refusal] = validateDraft({ draft: resume("Platform Engineer at Fernwood Labs since 2019 [C9]."), claims: WITH_C9, postingText: POSTING, coverLetterRequested: false }).refusals;
    expect(refusal!.message).toBe("C9 ends in “2021”, and this sentence doesn't say so. “since” says it is still going on, and the claims this sentence cites (C9) don't. Dates must match the claims exactly.");
  });
});

describe("revision 1, V4: no uncited sentence rides along with a cited one", () => {
  const cited = "Shipped the on-call rotation tooling used by three engineering teams [C3]";
  it.each([
    ["a full stop with no space before a capital", `${cited}.Won the Fernwood award.`],
    ["an ellipsis character", `${cited}… Won the Fernwood award.`],
    ["an ellipsis character before a lower-case word", `${cited}…won the Fernwood award.`],
    ["a capital outside ASCII", `${cited}. Élu meilleur ingénieur.`],
    ["a lower-case word", `${cited}. then won the Fernwood award.`],
    ["a lower-case word straight after a marker's full stop", `${cited}.won the Fernwood award.`],
    ["an exclamation mark", `${cited}!Won the Fernwood award.`],
    ["a question mark and a space", `${cited}? won the Fernwood award.`],
    ["a fullwidth full stop", `${cited}．Won the Fernwood award.`],
    ["a zero-width space", `${cited}.${ZERO_WIDTH_SPACE}Won the Fernwood award.`],
    ["a next-line character", `${cited}.${NEXT_LINE}Won the Fernwood award.`],
    ["a line break with no full stop", `${cited}\nWon the Fernwood award.`],
    ["an opening quote before a capital", `${cited}.“Won” the Fernwood award.`],
  ])("refuses %s", (_name, statement) => {
    expect(rules(resume(statement))).toEqual(["uncited"]);
  });

  // The same, with the uncited sentence first and no marker before the break: only the splitting rules stand between it and the citation.
  const lead = "Shipped the on-call rotation tooling used by three engineering teams";
  it.each([
    ["a full stop straight before a capital", `${lead}.Won the Fernwood award [C3].`],
    ["a full stop straight before a capital outside ASCII", `${lead}.Élu meilleur ingénieur [C3].`],
    ["a full stop and a space before a lower-case word", `${lead}. then won the Fernwood award [C3].`],
    ["an ellipsis character and a space", `${lead}… Won the Fernwood award [C3].`],
  ])("refuses %s when the cited sentence comes second", (_name, statement) => {
    expect(rules(resume(statement))).toEqual(["uncited"]);
  });

  it("keeps a statement whole where no sentence ends", () => {
    for (const statement of GOOD.resume.sections.flatMap((section) => section.statements)) expect(splitSentences(statement)).toHaveLength(1);
    expect(splitSentences("Shipped tooling [C3]\n[C1]")).toEqual(["Shipped tooling [C3] [C1]"]);
  });
});

describe("revision 1, V10: the model never learns which label, id or wording was an excluded claim's", () => {
  function forModel(statement: string) {
    return validateDraft({ draft: resume(statement), claims: LABELLED, postingText: POSTING, coverLetterRequested: false }).forModel;
  }

  it("an excluded label reads exactly as a label it was never given, alone or beside one", () => {
    const excluded = forModel("Grew signups after the launch [C2].");
    const unknown = forModel("Grew signups after the launch [C99].");
    expect(excluded.map((refusal) => refusal.rule)).toEqual(["unknown_citation"]);
    expect(excluded[0]!.message.replace("C2", "C#")).toBe(unknown[0]!.message.replace("C99", "C#"));
    // Side by side with an unknown label: one refusal naming both, as two unknown labels would get.
    expect(forModel("Grew signups after the launch [C2][C99].")).toEqual(forModel("Grew signups after the launch [C98][C99].").map((refusal) => ({ ...refusal, message: refusal.message.replace("C98", "C2") })));
    // An unconfirmed claim's label too.
    expect(forModel("Cut the release time to under an hour [C4].").map((refusal) => [refusal.rule, refusal.message])).toEqual([["unknown_citation", "C4 isn't one of the confirmed claims you were given. Cite only those."]]);
  });

  it("an excluded claim's id reads as any other id, and its wording as something the claims don't state", () => {
    const byId = forModel(`Led the payments infrastructure team (${EXCLUDED.id}) [C1].`);
    const otherId = forModel("Led the payments infrastructure team (0f0e0d0c-0b0a-4908-8706-050403020100) [C1].");
    // The same refusal, but for the sentence it quotes back (the model's own words, id and all).
    const withoutSentence = (refusals: typeof byId) => refusals.map(({ sentence: _sentence, ...rest }) => rest);
    expect(withoutSentence(byId)).toEqual(withoutSentence(otherId));
    expect(byId.map((refusal) => refusal.rule)).toEqual(["raw_id"]);
    const byWording = forModel("Led the payments infrastructure team after launching the self-serve onboarding flow [C1].");
    expect(byWording.map((refusal) => refusal.rule)).toEqual(["unknown_citation"]);
    for (const refusal of [...byId, ...byWording]) expect(refusal.message.toLowerCase()).not.toContain("exclud");
  });

  it("the person's view still says which it was", () => {
    const result = validateDraft({ draft: resume("Grew signups after launching the self-serve onboarding flow [C2]."), claims: LABELLED, postingText: POSTING, coverLetterRequested: false });
    expect(result.refusals.map((refusal) => refusal.rule)).toEqual(["excluded_claim", "excluded_claim"]);
    expect(result.forModel.map((refusal) => refusal.rule)).toEqual(["unknown_citation", "unknown_citation"]);
    expect(JSON.stringify(result.forModel)).not.toContain("excluded_claim");
  });
});

/**
 * Revision 2 (X1–X4): every probe the round-2 reviewer found passing, each
 * as a whole draft that must now be refused, the false refusals X2 and X4(b)
 * rule away, and the honest controls that must still pass. Extra claims are
 * test-local and fictional (Ada Quill at Fernwood Labs and Harbor), labelled
 * after the fixture's eight.
 */
function confirmedClaim(label: string, kind: ValidationClaim["kind"], text: string): ValidationClaim {
  const n = label.slice(1).padStart(4, "0");
  return { label, id: `0a0b0c0d-${n}-4e0f-8a1b-2c3d4e5f6a7b`, kind, status: "confirmed", text };
}

function rulesWith(extra: readonly ValidationClaim[], ...statements: string[]): ValidationRule[] {
  return validateDraft({ draft: resume(...statements), claims: [...LABELLED, ...extra], postingText: POSTING, coverLetterRequested: false }).refusals.map((refusal) => refusal.rule);
}

describe("revision 2, X2: an abbreviation is no longer mistaken for a sentence end", () => {
  const degree = confirmedClaim("C9", "credential", "B.Eng. Software Engineering, Fernwood University, 2019.");

  it("passes a degree cited verbatim from its claim, and with “in” after it", () => {
    expect(rulesWith([degree], "B.Eng. Software Engineering, Fernwood University, 2019 [C9].")).toEqual([]);
    expect(rulesWith([degree], "B.Eng. in Software Engineering at Fernwood University, 2019 [C9].")).toEqual([]);
    expect(rulesWith([degree], "Software Engineering (B.Eng.), Fernwood University, 2019 [C9].")).toEqual([]);
  });

  it.each([
    ["B.Tech.", "B.Tech. Computer Science, Fernwood University, 2019."],
    ["M.Phil.", "M.Phil. Computer Science, Fernwood University, 2020."],
    ["D.Phil.", "D.Phil. Computer Science, Fernwood University, 2023."],
  ])("passes %s as its claim states it", (_name, text) => {
    const claim = confirmedClaim("C9", "credential", text);
    expect(rulesWith([claim], `${text.slice(0, -1)} [C9].`)).toEqual([]);
    expect(splitSentences(`${text.slice(0, -1)} [C9].`)).toHaveLength(1);
  });

  it("reads each of these degrees as a credential, so one can't stand in for another", () => {
    expect(credentialsIn("B.Tech., M.Tech., M.Phil. and D.Phil.; BTech, MPhil, DPhil")).toEqual(["btech", "mtech", "mphil", "dphil"]);
    expect(rulesWith([degree], "D.Phil. Software Engineering, Fernwood University, 2019 [C9].")).toEqual(["credential"]);
    expect(rulesWith([degree], "M.Phil. Software Engineering, Fernwood University, 2019 [C9].")).toEqual(["credential"]);
  });

  it.each(["incl", "esp", "excl", "yrs", "avg", "intl", "univ", "govt", "mgmt", "assoc", "al", "cf"])("keeps a sentence whole at “%s.”", (abbreviation) => {
    expect(splitSentences(`Shipped the on-call rotation tooling ${abbreviation}. the runbooks [C3].`)).toHaveLength(1);
    expect(splitSentences(`Shipped the on-call rotation tooling ${abbreviation}. The runbooks [C3].`)).toHaveLength(1);
  });

  it("passes the reviewer's honest sentences with incl., esp. and approx. mid-sentence", () => {
    expect(rules(resume("Shipped the on-call rotation tooling used by three engineering teams incl. the payments team [C3]."))).toEqual([]);
    expect(rules(resume("Led the payments infrastructure team at Northwind Labs, esp. the ledger service behind its billing [C1]."))).toEqual([]);
    expect(rules(resume("Shipped the on-call rotation tooling used by approx. three engineering teams [C3]."))).toEqual([]);
  });

  const cited = "Shipped the on-call rotation tooling used by three engineering teams";
  it.each([
    ["after a cited sentence that contains an abbreviation", `${cited} incl. the payments team [C3]. Won the Fernwood award.`],
    ["before a cited sentence, itself containing an abbreviation", `Won the Fernwood award for the ledger service incl. its runbooks. ${cited} [C3].`],
    ["after a degree cited verbatim", "B.Eng. Software Engineering, Fernwood University, 2019 [C9]. Won the Fernwood award."],
    ["after a degree, lower-case", "B.Eng. Software Engineering, Fernwood University, 2019 [C9]. then won the Fernwood award."],
  ])("still refuses an uncited sentence after an ordinary full stop: %s", (_name, statement) => {
    expect(rulesWith([degree], statement)).toEqual(["uncited"]);
  });

  // A dotted word of one part ends its sentence unless it is listed or an initial, so nothing rides along after it.
  it.each([
    ["“it.” and a space", `The on-call team loved it. ${cited} [C3].`],
    ["“UK.” and a space", `${cited} in the UK. Won the Fernwood award [C3].`],
    ["“it.” and a capital, no space", `${cited} for it.Won the Fernwood award [C3].`],
  ])("refuses an uncited sentence that ends in a one-part dotted word: %s", (_name, statement) => {
    expect(rules(resume(statement))).toEqual(["uncited"]);
  });

  it("never reads two words run together (“it.Won.”) as one dotted abbreviation", () => {
    expect(splitSentences(`Loved it.Won. ${cited} [C3].`)).toEqual(["Loved it.", "Won.", `${cited} [C3].`]);
    expect(rules(resume(`Loved it.Won. ${cited} [C3].`))).toEqual(["uncited", "uncited"]);
  });

  it("keeps the honest controls: U.S. and e.g. mid-sentence, Ph.D., an initial, and Node.js", () => {
    expect(rules(resume("Led the payments infrastructure team at Northwind Labs for U.S. merchants [C1]."))).toEqual([]);
    expect(rules(resume("Led the U.S. Payments infrastructure team at Northwind Labs [C1]."))).toEqual([]);
    expect(rules(resume("Led the payments infrastructure team at Northwind Labs, e.g. redesigning the ledger service behind its billing [C1]."))).toEqual([]);
    expect(rules(resume("Shipped the on-call rotation tooling in Node.js, served from tools.example.com, used by three engineering teams [C3]."))).toEqual([]);
    expect(splitSentences("Worked with a Ph.D. student and J. Doe on it [C1].")).toHaveLength(1);
    expect(splitSentences("Built ASP.NET services for the U.S.Army team [C1].")).toHaveLength(1);
  });
});

describe("revision 2, X1: titles, whatever their case", () => {
  // C9 is FERNWOOD_LABS, "Platform Engineer at Fernwood Labs, 2019–2021.". C11 and C12 are written in sentence case.
  const harborStaff = confirmedClaim("C11", "title", "Staff engineer at Harbor, 2021–2023.");
  const harborFounding = confirmedClaim("C12", "title", "Founding engineer at Harbor.");
  const cofounder = confirmedClaim("C13", "title", "Cofounder at Harbor.");
  const claims = [FERNWOOD_LABS, harborStaff, harborFounding, cofounder];

  it.each([
    ["a sentence-case seniority", "Senior platform engineer at Fernwood Labs, 2019–2021 [C9]."],
    ["“Staff engineer” opening the sentence", "Staff engineer at Fernwood Labs, 2019–2021 [C9]."],
    ["“Principal engineer” opening the sentence", "Principal engineer at Fernwood Labs, 2019–2021 [C9]."],
    ["“Lead platform engineer” opening the sentence", "Lead platform engineer at Fernwood Labs, 2019–2021 [C9]."],
    ["an opening phrase that ends in a role word", "Engineering manager at Fernwood Labs, 2019–2021 [C9]."],
    ["an opening VP with what it heads", "VP engineering at Fernwood Labs, 2019–2021 [C9]."],
    ["an opening “Head of”", "Head of platform at Fernwood Labs, 2019–2021 [C9]."],
    ["an opening “Chief architect”", "Chief architect at Fernwood Labs, 2019–2021 [C9]."],
    ["“and became” mid-sentence", "Platform Engineer at Fernwood Labs, 2019–2021, and became engineering manager there [C9]."],
    ["“later named” mid-sentence", "Platform Engineer at Fernwood Labs, 2019–2021, later named platform architect [C9]."],
    ["“named” with “of the”", "Platform Engineer at Fernwood Labs, 2019–2021, and named engineer of the year [C9]."],
    ["a lower-case role of the X", "director of the platform group at Fernwood Labs, 2019–2021 [C9]."],
    ["“Was named” opening the sentence", "Was named platform architect at Fernwood Labs, 2019–2021 [C9]."],
    ["a Senior in mixed case after “as a”", "Worked at Fernwood Labs as a Senior platform engineer, 2019–2021 [C9]."],
    ["a capitalized phrase with a lower-case role word", "Senior Platform engineer at Fernwood Labs, 2019–2021 [C9]."],
  ])("refuses %s against a claim that says otherwise", (_name, statement) => {
    expect(rulesWith(claims, statement)).toEqual(["title"]);
  });

  it("refuses “Staff engineer” against “Senior Platform Engineer”, with the open start C7 beside it", () => {
    expect(rules(resume("Staff engineer at Northwind Labs since 2022 [C8][C7]."))).toEqual(["title"]);
  });

  it("names the title it read, whatever its case", () => {
    const [refusal] = validateDraft({ draft: resume("Staff engineer at Fernwood Labs, 2019–2021 [C9]."), claims: [...LABELLED, ...claims], postingText: POSTING, coverLetterRequested: false }).refusals;
    expect(refusal!.message).toBe("The title “staff engineer” must match a title in the claims this sentence cites (C9) word for word.");
  });

  it("reads a claim in sentence case for its title, so the same title in title case passes", () => {
    expect(titlesIn("Staff engineer at Harbor, 2021–2023.")).toEqual(["staff engineer"]);
    expect(titlesIn("Founding engineer at Harbor.")).toEqual(["founding engineer"]);
    expect(rulesWith(claims, "Staff Engineer at Harbor, 2021–2023 [C11].")).toEqual([]);
    expect(rulesWith(claims, "Staff engineer at Harbor, 2021–2023 [C11].")).toEqual([]);
    expect(rulesWith(claims, "Founding Engineer at Harbor [C12].")).toEqual([]);
    expect(rulesWith(claims, "Founding engineer at Harbor [C12].")).toEqual([]);
  });

  it("passes a title that differs from its claim only in case or a hyphen", () => {
    expect(rulesWith(claims, "Platform engineer at Fernwood Labs, 2019–2021 [C9].")).toEqual([]);
    expect(rulesWith(claims, "PLATFORM ENGINEER at Fernwood Labs, 2019–2021 [C9].")).toEqual([]);
    expect(rulesWith(claims, "Platform-Engineer at Fernwood Labs, 2019–2021 [C9].")).toEqual([]);
    expect(rulesWith(claims, "Worked at Fernwood Labs as a Platform engineer, 2019–2021 [C9].")).toEqual([]);
    expect(rules(resume("Senior platform engineer at Northwind Labs [C8]."))).toEqual([]);
    expect(rules(resume("Senior Platform-Engineer at Northwind Labs [C8]."))).toEqual([]);
    expect(rulesWith(claims, "Co-founder at Harbor [C13].")).toEqual([]);
  });

  it("reads each form the way the rule compares it", () => {
    expect(titlesIn("Became engineering manager at Fernwood Labs, and was named engineer of the year.")).toEqual(["engineering manager", "engineer of the year"]);
    expect(titlesIn("director of the platform group")).toEqual(["director of the platform group"]);
    expect(titlesIn("Head of the Platform Group at Harbor.")).toEqual(["head of the platform group"]);
    expect(titlesIn("Director of engineering at Harbor.")).toEqual(titlesIn("Director of Engineering at Harbor."));
    expect(titlesIn("VP engineering, Harbor.")).toEqual(["vp engineering"]);
    expect(titlesIn("Joined Harbor in 2021. Staff engineer there until 2023.")).toEqual(["staff engineer"]);
  });

  it("leaves verbs and names alone: “Lead the …”, “Head the …”, a certificate, someone else's role", () => {
    for (const text of [
      "Lead the migration at Fernwood Labs, then head the team.",
      "Head the platform team at Fernwood Labs.",
      "Lead platform engineering for the payments team at Northwind Labs.",
      "Led platform engineer hiring at Harbor.",
      "Certified Kubernetes administrator who maintains Ledgerkit.",
      "Worked with the platform architect at Harbor.",
      "Maintainer of Ledgerkit, an open-source ledger reconciliation library.",
    ]) {
      expect(titlesIn(text), text).toEqual([]);
    }
  });
});

describe("revision 2, X3: numbers written as words", () => {
  const led = "Led the payments infrastructure team at Northwind Labs";
  const shipped = "Shipped the on-call rotation tooling used by three engineering teams";
  it.each([
    ["zero in a compound", `${led} through zero-downtime ledger releases [C1].`],
    ["N-fold as one word", `${led}, growing ledger throughput tenfold [C1].`],
    ["threefold against a claim that says three", `${shipped}, cutting pages threefold [C3].`],
    ["twofold", `${shipped}, a twofold gain [C3].`],
    ["a numeral glued to “fold”", `${led}, growing ledger throughput 10fold [C1].`],
    ["“by half”", `${led}, cutting billing costs by half [C1].`],
    ["“in half”", `${led}, cutting ledger costs in half [C1].`],
    ["“helped double”", `${led} and helped double billing volume [C1].`],
    ["triple as a whole word", `${led} and helped triple billing volume [C1].`],
    ["quadruple as a whole word", `${led} and helped quadruple billing volume [C1].`],
    ["“by a third”", `${led}, cutting ledger errors by a third [C1].`],
    ["“by a quarter”", `${led}, cutting ledger errors by a quarter [C1].`],
    ["“two thirds”", `${led}, cutting ledger errors by two thirds [C1].`],
    ["double-digit growth", `${led}, with double-digit billing growth [C1].`],
  ])("refuses %s", (_name, statement) => {
    expect(rules(resume(statement))).toEqual(["number"]);
  });

  it("reads each word as the quantity it states", () => {
    expect(numbersIn("zero tenfold half double a third").map((fact) => fact.key)).toEqual(["0", "10x", "0.5x", "2x", "0.333333x"]);
    expect(numbersIn("threefold, twofold, 10fold, two-fold").map((fact) => fact.key)).toEqual(["3x", "2x", "10x", "2x"]);
    expect(numbersIn("triple, quadruple, a quarter, one-third, three quarters, double digits").map((fact) => fact.key)).toEqual(["3x", "4x", "0.25x", "0.333333x", "0.75x", "double-digit"]);
    // As the words they are: "half" is what "halved" is, "tenfold" what "10x" is.
    expect(numbersIn("in half")[0]!.key).toBe(numbersIn("halved")[0]!.key);
    expect(numbersIn("tenfold")[0]!.key).toBe(numbersIn("10x")[0]!.key);
  });

  it("passes the same quantity in other words when a claim states it", () => {
    const halved = confirmedClaim("C9", "metric", "Cut ledger reconciliation time in half at Northwind Labs.");
    const tenfold = confirmedClaim("C10", "metric", "Grew ledger throughput tenfold at Northwind Labs.");
    const downtime = confirmedClaim("C11", "fact", "Ran zero-downtime ledger releases at Northwind Labs.");
    const third = confirmedClaim("C12", "metric", "Cut ledger errors by a third at Northwind Labs.");
    const claims = [halved, tenfold, downtime, third];
    expect(rulesWith(claims, "Halved ledger reconciliation time at Northwind Labs [C9].")).toEqual([]);
    expect(rulesWith(claims, "Grew ledger throughput 10x at Northwind Labs [C10].")).toEqual([]);
    expect(rulesWith(claims, "Ran zero-downtime ledger releases at Northwind Labs [C11].")).toEqual([]);
    expect(rulesWith(claims, "Cut ledger errors by a third at Northwind Labs [C12].")).toEqual([]);
    // …and never another one.
    expect(rulesWith(claims, "Cut ledger errors by half at Northwind Labs [C12].")).toEqual(["number"]);
  });

  it("leaves compounds and ordinals that state no quantity alone", () => {
    expect(rules(resume(`${led}, redesigning its double-entry ledger service [C1].`))).toEqual([]);
    expect(rules(resume(`${led}, integrating a third-party billing API [C1].`))).toEqual([]);
    expect(rules(resume(`${shipped} on behalf of the payments team [C3].`))).toEqual([]);
    expect(numbersIn("double-checked the half-duplex links for a third party in the third quarter, each quarter")).toEqual([]);
    expect(numbersIn("manifold, scaffold, halfway, first-class")).toEqual([]);
  });
});

describe("revision 2, X4: open ends, and a sentence that states no date", () => {
  // (a) The reviewer's three probes, then the rest of the ruling's open ends and start markers, each against claims that end.
  it.each([
    ["“still” beside the claim's own range", "Platform Engineer at Fernwood Labs, 2019–2021, and still there [C9]."],
    ["“to this day” against a single year", "Studying at Fernwood University from 2019 to this day [C6]."],
    ["“onward” against a single year", "At Fernwood University from 2019 onward [C6]."],
    ["“onwards” against a single year", "Studied Computer Science at Fernwood University from 2019 onwards [C6]."],
    ["“and counting” against a single year", "B.S. Computer Science, Fernwood University, 2019, and counting [C6]."],
    ["“until this day” against a single year", "Studied Computer Science at Fernwood University until this day [C6]."],
    ["“from” and a year with no end", "Studied Computer Science at Fernwood University from 2019 [C6]."],
    ["“starting” and a year with no end", "Starting in 2019, studied Computer Science at Fernwood University [C6]."],
    ["“since” and a year with no end", "At Fernwood University since 2019 [C6]."],
    ["an open end with no year against a closed range", "Platform Engineer at Fernwood Labs, still [C9]."],
  ])("refuses %s", (_name, statement) => {
    expect(rulesWithC9(statement)).toEqual(["date"]);
  });

  it("passes every open end when a cited claim is itself open (C7 states a start and no end)", () => {
    for (const statement of [
      "Senior Platform Engineer at Northwind Labs from 2022 [C8][C7].",
      "Senior Platform Engineer at Northwind Labs from 2022 onward [C8][C7].",
      "Still a Senior Platform Engineer at Northwind Labs [C8][C7].",
      "Senior Platform Engineer at Northwind Labs since 2022, and counting [C8][C7].",
      "Senior Platform Engineer at Northwind Labs to this day [C8][C7].",
      "Starting in 2022, Senior Platform Engineer at Northwind Labs [C8][C7].",
    ]) {
      expect(rulesWithC9(statement), statement).toEqual([]);
    }
  });

  it("names a start with no end as what it is", () => {
    const [refusal] = validateDraft({ draft: resume("Studied Computer Science at Fernwood University from 2019 [C6]."), claims: WITH_C9, postingText: POSTING, coverLetterRequested: false }).refusals;
    expect(refusal!.message).toBe("“from 2019” names a start and no end, so it says it is still going on, and the claims this sentence cites (C6) don't. Dates must match the claims exactly.");
  });

  it("never reads a range that has an end as a start with none", () => {
    for (const statement of [
      "Platform Engineer at Fernwood Labs from 2019 to mid-2021 [C9].",
      "Platform Engineer at Fernwood Labs from 2019 until summer 2021 [C9].",
      "Platform Engineer at Fernwood Labs from 2019 through Q2 2021 [C9].",
      "Platform Engineer at Fernwood Labs from early 2019 to the end of 2021 [C9].",
      "Platform Engineer at Fernwood Labs from March 2019 to June 2021 [C9].",
    ]) {
      expect(datesIn(statement).openEnd, statement).toBeUndefined();
      expect(datesIn(statement).endYears, statement).toEqual(["2021"]);
    }
    // …so a claim with such a range is closed, and "since" against it is refused.
    const harbor = confirmedClaim("C9", "title", "Staff engineer at Harbor from 2021 to mid-2023.");
    expect(rulesWith([harbor], "Staff engineer at Harbor from 2021 to mid-2023 [C9].")).toEqual([]);
    expect(rulesWith([harbor], "Staff engineer at Harbor since 2021 [C9].")).toEqual(["date"]);
  });

  it("reads “from” as a start only right before its year", () => {
    // "Graduated from Fernwood University in 2019." states when something ended, not when it started: it isn't open.
    const graduated = confirmedClaim("C9", "fact", "Graduated from Fernwood University in 2019.");
    expect(datesIn(graduated.text)).toEqual({ years: ["2019"], months: [], endYears: [], startOnly: false });
    expect(rulesWith([graduated], "Graduated from Fernwood University in 2019 [C9].")).toEqual([]);
    expect(rulesWith([graduated], "At Fernwood University since 2019 [C9].")).toEqual(["date"]);
    expect(rulesWith([graduated], "At Fernwood University from 2019 [C9].")).toEqual(["date"]);
  });

  it("reads each open end as written", () => {
    expect(datesIn("from 2019 to this day").openEnd).toBe("to this day");
    expect(datesIn("2019–2021, and still there").openEnd).toBe("still");
    expect(datesIn("from 2019 onwards").openEnd).toBe("onwards");
    expect(datesIn("three years and counting").openEnd).toBe("and counting");
    expect(datesIn("Starting in March 2019")).toEqual({ years: ["2019"], months: [3], endYears: [], openEnd: "Starting in March 2019", openStart: true, startOnly: true });
    expect(datesIn("from 2019 to 2021")).toEqual({ years: ["2019", "2021"], months: [], endYears: ["2021"], startOnly: false });
  });

  // (b) V3 amended: the end-year rule applies only when the sentence itself states a year, a month or an open end.
  it("passes a sentence that states no date, and still refuses one that states half the range", () => {
    const pipeline = confirmedClaim("C9", "fact", "Built the billing pipeline at Fernwood Labs between 2019 and 2021.");
    expect(rulesWith([pipeline], "Built the billing pipeline at Fernwood Labs [C9].")).toEqual([]);
    expect(rulesWith([pipeline], "Built the billing pipeline at Fernwood Labs between 2019 and 2021 [C9].")).toEqual([]);
    expect(rulesWith([pipeline], "Built the billing pipeline at Fernwood Labs in 2019 [C9].")).toEqual(["date"]);
    expect(rulesWith([pipeline], "Built the billing pipeline at Fernwood Labs in March 2019 [C9].")).toEqual(["date"]);
    expect(rulesWith([pipeline], "Built the billing pipeline at Fernwood Labs, still running it [C9].")).toEqual(["date"]);
  });
});

describe("revision 2: an honest resume and cover letter still pass every rule", () => {
  it("passes a realistic draft built only from the fixture's confirmed claims", () => {
    const realistic: Draft = {
      resume: {
        sections: [
          { heading: "Summary", statements: ["Senior Platform Engineer at Northwind Labs since 2022, leading its payments infrastructure team [C8][C7][C1]."] },
          {
            heading: "Experience",
            statements: [
              "Senior Platform Engineer, Northwind Labs, 2022 to present [C8][C7].",
              "Led the payments infrastructure team at Northwind Labs [C1].",
              "Redesigned the ledger service that powers Northwind Labs' billing, e.g. its reconciliation runs [C1].",
              "Shipped on-call rotation tooling that three engineering teams use, incl. runbooks [C3].",
            ],
          },
          { heading: "Open source", statements: ["Maintainer of Ledgerkit, an open-source library for ledger reconciliation in Node.js [C5]."] },
          { heading: "Education", statements: ["B.S. in Computer Science, Fernwood University (2019) [C6]."] },
        ],
      },
      coverLetter: {
        paragraphs: [
          ["Since 2022 I have worked at Northwind Labs as a Senior Platform Engineer [C7][C8].", "There I led the payments infrastructure team and redesigned the ledger service behind its billing [C1]."],
          ["I also shipped the on-call rotation tooling that three engineering teams rely on [C3].", "Outside work, I maintain Ledgerkit, an open-source ledger reconciliation library [C5]."],
          ["I earned a B.S. in Computer Science at Fernwood University in 2019 [C6]."],
        ],
      },
    };
    const result = check(realistic, true);
    expect(result.refusals).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

/**
 * Revision 3 (Y1–Y4): every probe the round-3 reviewer found passing, each as a whole draft that must now be
 * refused, the false refusals Y2 and Y3 rule away, and the honest controls that must still pass. Extra claims are
 * test-local and fictional, labelled after the fixture's eight.
 */
describe("revision 3, Y1: the present, and dates counted from today", () => {
  // C9 is FERNWOOD_LABS, "Platform Engineer at Fernwood Labs, 2019–2021."; C10 is a closed billing claim.
  const billing = confirmedClaim("C10", "fact", "Built the billing pipeline at Fernwood Labs between 2019 and 2021.");
  const closed = [FERNWOOD_LABS, billing];

  it.each([
    ["“Now” with no year", "Now a Platform Engineer at Fernwood Labs [C9]."],
    ["“Presently” with no year", "Presently a Platform Engineer at Fernwood Labs [C9]."],
    ["“Nowadays” with no year", "Nowadays a Platform Engineer at Fernwood Labs [C9]."],
    ["“to date” with no year", "Platform Engineer at Fernwood Labs to date [C9]."],
    ["“as of now”", "Platform Engineer at Fernwood Labs as of now [C9]."],
    ["“now” mid-sentence, citing two closed claims", "Platform Engineer at Fernwood Labs, where I now own the billing pipeline [C9][C10]."],
    ["“today”", "Today I run the billing pipeline at Fernwood Labs [C10]."],
    ["“at present”", "Platform Engineer at Fernwood Labs at present [C9]."],
    ["“these days”", "Built the billing pipeline at Fernwood Labs, which these days runs nightly [C10]."],
    ["“continues to”", "Built the billing pipeline at Fernwood Labs, which continues to run nightly [C10]."],
    ["“Remains”", "Remains a Platform Engineer at Fernwood Labs [C9]."],
    ["“and beyond” after the claim's own range", "Platform Engineer at Fernwood Labs, 2019–2021 and beyond [C9]."],
    ["“now” beside the claim's own range", "Built and now run the billing pipeline at Fernwood Labs [C10]."],
  ])("refuses %s against claims that end", (_name, statement) => {
    expect(rulesWith(closed, statement)).toEqual(["date"]);
  });

  it.each([
    ["“last year”", "Built the billing pipeline at Fernwood Labs last year [C10]."],
    ["“this year”", "Built the billing pipeline at Fernwood Labs this year [C10]."],
    ["“Recently”", "Recently built the billing pipeline at Fernwood Labs [C10]."],
    ["“lately”", "Lately rebuilt the billing pipeline at Fernwood Labs [C10]."],
    ["“last month”", "Rebuilt the billing pipeline at Fernwood Labs last month [C10]."],
    ["“this month”", "Rebuilt the billing pipeline at Fernwood Labs this month [C10]."],
    ["“a few years ago”", "Built the billing pipeline at Fernwood Labs a few years ago [C10]."],
    ["“the past quarter”", "Rebuilt the billing pipeline at Fernwood Labs over the past quarter [C10]."],
  ])("refuses a date counted from today: %s", (_name, statement) => {
    expect(rulesWith(closed, statement)).toEqual(["date"]);
  });

  it("refuses “N years ago”, and says to use the claims' years", () => {
    const [number, date] = validateDraft({ draft: resume("Built the billing pipeline at Fernwood Labs two years ago [C10]."), claims: [...LABELLED, ...closed], postingText: POSTING, coverLetterRequested: false }).refusals;
    expect(number!.rule).toBe("number");
    expect(date!.message).toBe("“two years ago” counts from today, and the claims this sentence cites (C10) don't. Use the years they state instead. Dates must match the claims exactly.");
  });

  it("names the phrase that leaves it open", () => {
    const [refusal] = validateDraft({ draft: resume("Platform Engineer at Fernwood Labs as of now [C9]."), claims: WITH_C9, postingText: POSTING, coverLetterRequested: false }).refusals;
    expect(refusal!.message).toBe("C9 ends in “2021”, and this sentence doesn't say so. “as of now” says it is still going on, and the claims this sentence cites (C9) don't. Dates must match the claims exactly.");
  });

  it("passes the present on a claim that is itself open, and a date counted from today that the claim states in the same words", () => {
    const staff = confirmedClaim("C11", "title", "Staff Engineer at Northwind Labs since 2022.");
    const recent = confirmedClaim("C12", "fact", "Recently rebuilt the ledger reconciliation runs at Northwind Labs.");
    const claims = [...closed, staff, recent];
    expect(rulesWith(claims, "Staff Engineer at Northwind Labs since 2022, where I now lead the payments infrastructure team [C11].")).toEqual([]);
    expect(rules(resume("Senior Platform Engineer at Northwind Labs since 2022, where I now lead the payments infrastructure team [C8][C7][C1]."))).toEqual([]);
    expect(rules(resume("Senior Platform Engineer at Northwind Labs, which I remain today [C8][C7]."))).toEqual([]);
    expect(rulesWith(claims, "Recently rebuilt the ledger reconciliation runs at Northwind Labs [C12].")).toEqual([]);
    // …and never another such date: "lately" is not "recently".
    expect(rulesWith(claims, "Lately rebuilt the ledger reconciliation runs at Northwind Labs [C12].")).toEqual(["date"]);
  });

  it("keeps the honest controls: “up to date”, a degree's last year, and the claim's own range", () => {
    expect(rules(resume("Kept the on-call rotation tooling up to date for three engineering teams [C3]."))).toEqual([]);
    expect(rules(resume("Kept the on-call rotation tooling up-to-date for three engineering teams [C3]."))).toEqual([]);
    expect(rules(resume("Completed the last year of the B.S. Computer Science at Fernwood University in 2019 [C6]."))).toEqual([]);
    expect(rulesWith(closed, "Platform Engineer at Fernwood Labs, 2019–2021 [C9].")).toEqual([]);
    expect(rulesWith(closed, "Built the billing pipeline at Fernwood Labs [C10].")).toEqual([]);
  });

  it("reads each as written", () => {
    expect(datesIn("Now a Platform Engineer").openEnd).toBe("now");
    expect(datesIn("Platform Engineer as of now").openEnd).toBe("as of now");
    expect(datesIn("Platform Engineer until now").openEnd).toBe("until now");
    expect(datesIn("Platform Engineer to date").openEnd).toBe("to date");
    expect(datesIn("which continues to run").openEnd).toBe("continues to");
    expect(datesIn("2019–2021 and beyond").openEnd).toBe("and beyond");
    expect(datesIn("these days").openEnd).toBe("these days");
    expect(datesIn("Remains a Platform Engineer").openEnd).toBe("remains");
    expect(datesIn("kept up-to-date").openEnd).toBeUndefined();
    expect(datesIn("recently, last year and this month, two years ago, a few weeks ago, the past quarter, the last three years").relative).toEqual([
      "recently",
      "last year",
      "this month",
      "two years ago",
      "a few weeks ago",
      "past quarter",
      "last three years",
    ]);
    expect(datesIn("the last year of the degree, in 2019").relative).toBeUndefined();
    expect(datesIn("Platform Engineer at Fernwood Labs, 2019–2021.")).toEqual({ years: ["2019", "2021"], months: [], endYears: ["2021"], startOnly: false });
  });
});

describe("revision 3, Y2: short abbreviations a claim may state, and a way out for the rest", () => {
  const cited = "Shipped the on-call rotation tooling used by three engineering teams";
  const places = confirmedClaim("C9", "fact", "Moved the Harbor deploy fleet from the Mt. Hood data centre to the Ft. Worth region in 2022.");
  const reserve = confirmedClaim("C10", "fact", "Served as a Lt. in the Fernwood reserve signals unit, 2015–2018.");

  it("passes the reviewer's three: Mt. and Ft. and Lt. cited verbatim from their claims, and Mx. as an honorific", () => {
    expect(rulesWith([places, reserve], "Moved the Harbor deploy fleet from the Mt. Hood data centre to the Ft. Worth region in 2022 [C9].")).toEqual([]);
    expect(rulesWith([places, reserve], "Served as a Lt. in the Fernwood reserve signals unit, 2015–2018 [C10].")).toEqual([]);
    expect(rules(resume("Led the payments infrastructure team at Northwind Labs, mentored by Mx. Quill [C1]."))).toEqual([]);
    expect(splitSentences("Moved the Harbor deploy fleet from the Mt. Hood data centre to the Ft. Worth region in 2022 [C9].")).toHaveLength(1);
  });

  it.each(["mt", "ft", "pt", "lt", "mx", "rd", "sgt", "capt", "cpl", "pvt", "col", "gen", "maj", "adm", "cmdr", "rev", "hon", "gov", "sen", "rep", "supt", "ave", "blvd"])(
    "keeps a sentence whole at “%s.”",
    (abbreviation) => {
      const title = `${abbreviation[0]!.toUpperCase()}${abbreviation.slice(1)}`;
      expect(splitSentences(`Shipped the on-call rotation tooling with ${title}. Quill for three engineering teams [C3].`)).toHaveLength(1);
      expect(splitSentences(`Shipped the on-call rotation tooling on Quill ${abbreviation}. for three engineering teams [C3].`)).toHaveLength(1);
    },
  );

  it("still splits at a one-part dotted word that isn't listed: “it.” and “UK.”", () => {
    expect(rules(resume(`The on-call team loved it. ${cited} [C3].`))).toEqual(["uncited"]);
    expect(rules(resume(`${cited} in the UK. Won the Fernwood award [C3].`))).toEqual(["uncited"]);
    expect(splitSentences(`Won the award for it. ${cited} [C3].`)).toHaveLength(2);
  });

  it("tells the model and the person where an unlisted one seemed to end the sentence, so writing it out is the way through", () => {
    const hint = "This sentence seems to end at “Sq.”. If that's an abbreviation, write the word out.";
    const result = check(resume("Ran the Harbor ops desk on Quill Sq. Fernwood for three engineering teams [C3]."));
    expect(result.refusals.map((refusal) => [refusal.rule, refusal.sentence])).toEqual([["uncited", "Ran the Harbor ops desk on Quill Sq."]]);
    expect(result.refusals[0]!.message).toBe(`Every sentence needs the labels of the confirmed claims it states, like [C1]. Cite them, or take the sentence out. ${hint}`);
    expect(result.forModel[0]!.message).toBe(result.refusals[0]!.message);
    // An ordinary sentence end gets no hint.
    const plain = check(resume(`Won the Fernwood award. ${cited} [C3].`));
    expect(plain.refusals[0]!.message).toBe("Every sentence needs the labels of the confirmed claims it states, like [C1]. Cite them, or take the sentence out.");
  });
});

describe("revision 3, Y3: titles wherever they stand", () => {
  // C9 is FERNWOOD_LABS, "Platform Engineer at Fernwood Labs, 2019–2021."; C10 is written in sentence case.
  const harborStaff = confirmedClaim("C10", "title", "Staff engineer at Harbor, 2021–2023.");
  const claims = [FERNWOOD_LABS, harborStaff];

  it.each([
    ["an opening title before an em dash", "Engineering manager — Fernwood Labs, 2019–2021 [C9]."],
    ["an opening title before “on”", "Engineering manager on the payments team at Fernwood Labs, 2019–2021 [C9]."],
    ["an opening title before “with”", "Engineering manager with Fernwood Labs, 2019–2021 [C9]."],
    ["an opening title before a bracket", "Security engineer (Fernwood Labs), 2019–2021 [C9]."],
    ["a title after “and”", "Platform Engineer and team lead at Fernwood Labs, 2019–2021 [C9]."],
    ["a title after “and”, with a modifier", "Platform Engineer and engineering manager at Fernwood Labs, 2019–2021 [C9]."],
    ["“technical lead” after “and”", "Platform Engineer and technical lead at Fernwood Labs, 2019–2021 [C9]."],
    ["a title after “then”, between commas", "Platform Engineer, then engineering manager, at Fernwood Labs, 2019–2021 [C9]."],
    ["a title after “later”, at the end", "Platform Engineer at Fernwood Labs, 2019–2021, later platform architect [C9]."],
    ["a title before “role”", "Took on the engineering manager role at Fernwood Labs, 2019–2021 [C9]."],
    ["a title before “position”", "Took on the team lead position at Fernwood Labs, 2019–2021 [C9]."],
    ["an opening title before “in”", "Engineering manager in the Fernwood Labs payments group, 2019–2021 [C9]."],
    ["an opening title before a colon", "Engineering manager: Fernwood Labs, 2019–2021 [C9]."],
    ["an opening title ending the sentence", "Engineering manager [C9]."],
    ["an opening title before an unspaced em dash", "Engineering manager—Fernwood Labs, 2019–2021 [C9]."],
    ["an opening title before a spaced hyphen", "Engineering manager - Fernwood Labs, 2019–2021 [C9]."],
    ["an opening VP before an em dash", "VP engineering — Fernwood Labs, 2019–2021 [C9]."],
  ])("refuses %s against a claim that says otherwise", (_name, statement) => {
    expect(rulesWith(claims, statement)).toEqual(["title"]);
  });

  it("passes the claim's own title in each of those places", () => {
    for (const statement of [
      "Platform engineer — Fernwood Labs, 2019–2021 [C9].",
      "Platform engineer on the payments team at Fernwood Labs, 2019–2021 [C9].",
      "Platform engineer with Fernwood Labs, 2019–2021 [C9].",
      "Platform engineer (Fernwood Labs), 2019–2021 [C9].",
      "Platform engineer in the Fernwood Labs payments group, 2019–2021 [C9].",
      "Platform engineer: Fernwood Labs, 2019–2021 [C9].",
      "Platform engineer [C9].",
      "Platform Engineer at Fernwood Labs, 2019–2021, and staff engineer at Harbor, 2021–2023 [C9][C10].",
      "Platform Engineer at Fernwood Labs, 2019–2021, then staff engineer at Harbor, 2021–2023 [C9][C10].",
      "Platform Engineer at Fernwood Labs, 2019–2021, later staff engineer at Harbor, 2021–2023 [C9][C10].",
      "Took on the platform engineer role at Fernwood Labs, 2019–2021 [C9].",
      "Staff Engineer — Harbor, 2021–2023 [C10].",
    ]) {
      expect(rulesWith(claims, statement), statement).toEqual([]);
    }
  });

  it("passes “As Senior Platform Engineer at Northwind Labs, I led …”: a capitalized first word that can't be part of a title isn't one", () => {
    expect(rules(resume("As Senior Platform Engineer at Northwind Labs, I led the payments infrastructure team [C8][C1]."))).toEqual([]);
    expect(rules(resume("While Senior Platform Engineer at Northwind Labs, led the payments infrastructure team [C8][C1]."))).toEqual([]);
    expect(titlesIn("As Senior Platform Engineer at Northwind Labs, I led the payments infrastructure team.")).toEqual(["senior platform engineer"]);
    // …and one that can is read as before.
    expect(rules(resume("As Staff Platform Engineer at Northwind Labs, I led the payments infrastructure team [C8][C1]."))).toEqual(["title"]);
  });

  it("leaves verbs alone after “and”, “then” and a first word: no title's follower comes after them", () => {
    for (const text of [
      "Lead the migration at Fernwood Labs, then head the team.",
      "Led the payments infrastructure team, then redesigned the ledger service.",
      "I design and lead the platform migrations at Northwind Labs.",
      "I lead with the ledger service's reconciliation runs at Northwind Labs.",
      "Shipped the on-call rotation tooling, and later its runbooks.",
      "Developer tooling for three engineering teams: shipped the on-call rotation.",
    ]) {
      expect(titlesIn(text), text).toEqual([]);
    }
  });

  it("reads each new form the way the rule compares it", () => {
    expect(titlesIn("Security engineer (Fernwood Labs), 2019–2021.")).toEqual(["security engineer"]);
    expect(titlesIn("Engineering manager — Fernwood Labs.")).toEqual(["engineering manager"]);
    expect(titlesIn("Platform Engineer and team lead at Fernwood Labs.")).toEqual(["platform engineer", "team lead"]);
    expect(titlesIn("Took on the engineering manager role at Fernwood Labs.")).toEqual(["engineering manager"]);
    expect(titlesIn("Platform Engineer at Fernwood Labs, later platform architect.")).toEqual(["platform engineer", "platform architect"]);
  });
});

describe("revision 3, Y4: more quantities in words", () => {
  const led = "Led the payments infrastructure team at Northwind Labs";
  const shipped = "Shipped the on-call rotation tooling used by three engineering teams";
  it.each([
    ["“an order of magnitude”", `${led}, cutting ledger latency by an order of magnitude [C1].`],
    ["“orders of magnitude”", `${led}, cutting ledger latency by orders of magnitude [C1].`],
    ["“single-digit”", `${led}, bringing ledger latency to single-digit milliseconds [C1].`],
    ["“quintupled”", `${led}, which quintupled billing throughput [C1].`],
    ["“sextupled”", `${led}, which sextupled billing throughput [C1].`],
    ["quintuple as a whole word", `${led} and helped quintuple billing throughput [C1].`],
    ["sextuple as a whole word", `${led} and helped sextuple billing throughput [C1].`],
    ["“a couple of”", `${shipped} and a couple of partner teams [C3].`],
    ["“scores of”", `${shipped} and scores of engineers [C3].`],
    ["“dozens”", `${shipped} and dozens of engineers [C3].`],
    ["“hundreds”", `${shipped} and hundreds of engineers [C3].`],
  ])("refuses %s", (_name, statement) => {
    expect(rules(resume(statement))).toEqual(["number"]);
  });

  it("reads each as the quantity it states", () => {
    expect(numbersIn("an order of magnitude, orders of magnitude, single-digit, quintupled, sextuple").map((fact) => fact.key)).toEqual(["10x", "10x", "single-digit", "5x", "6x"]);
    expect(numbersIn("a couple of teams, scores of engineers, a dozen, dozens, millions").map((fact) => fact.key)).toEqual(["a couple", "scores of", "12", "dozens", "millions"]);
    expect(numbersIn("by an order of magnitude")[0]!.key).toBe(numbersIn("tenfold")[0]!.key);
    // Not a quantity: an order of service, a couple in a name, test scores.
    expect(numbersIn("in order of priority, the couple's scores")).toEqual([]);
  });

  it("passes a claim's own quantity word cited verbatim, and the same quantity in other words", () => {
    const faster = confirmedClaim("C9", "metric", "Cut ledger latency by an order of magnitude at Northwind Labs.");
    const partners = confirmedClaim("C10", "fact", "Shipped the on-call rotation tooling to a couple of partner teams.");
    const mentees = confirmedClaim("C11", "fact", "Mentored scores of engineers at Northwind Labs.");
    const latency = confirmedClaim("C12", "metric", "Brought ledger latency to single-digit milliseconds at Northwind Labs.");
    const growth = confirmedClaim("C13", "metric", "Quintupled billing throughput at Northwind Labs.");
    const claims = [faster, partners, mentees, latency, growth];
    expect(rulesWith(claims, "Cut ledger latency by an order of magnitude at Northwind Labs [C9].")).toEqual([]);
    expect(rulesWith(claims, "Cut ledger latency tenfold at Northwind Labs [C9].")).toEqual([]);
    expect(rulesWith(claims, "Shipped the on-call rotation tooling to a couple of partner teams [C10].")).toEqual([]);
    expect(rulesWith(claims, "Mentored scores of engineers at Northwind Labs [C11].")).toEqual([]);
    expect(rulesWith(claims, "Brought ledger latency to single-digit milliseconds at Northwind Labs [C12].")).toEqual([]);
    expect(rulesWith(claims, "Quintupled billing throughput at Northwind Labs [C13].")).toEqual([]);
    expect(rulesWith(claims, "Helped quintuple billing throughput at Northwind Labs [C13].")).toEqual([]);
    // …and never another one: dozens are not scores, double digits are not single ones.
    expect(rulesWith(claims, "Mentored dozens of engineers at Northwind Labs [C11].")).toEqual(["number"]);
    expect(rulesWith(claims, "Brought ledger latency to double-digit milliseconds at Northwind Labs [C12].")).toEqual(["number"]);
  });
});
