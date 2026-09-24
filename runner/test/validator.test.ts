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
    ["no dates at all for a claim that ends", "Platform Engineer at Fernwood Labs [C9]."],
    ["“since” against a single year", "Studied Computer Science since 2019 for the B.S. at Fernwood University [C6]."],
  ])("refuses %s", (_name, statement) => {
    expect(rulesWithC9(statement)).toEqual(["date"]);
  });

  it("passes the range as the claim states it, and an open end on a claim that is itself open", () => {
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
