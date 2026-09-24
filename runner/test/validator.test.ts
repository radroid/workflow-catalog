import { readFileSync } from "node:fs";
import path from "node:path";
import { claimSchema, jobSnapshotSchema } from "@workflow-catalog/contracts";
import { describe, expect, it } from "vitest";
import { JOB_ASSISTANT_DIR } from "../lib/paths.ts";
import { labelClaims } from "../validate/claims.ts";
import { credentialsIn, datesIn, numbersIn, titlesIn } from "../validate/facts.ts";
import { citedLabels, splitSentences, strayBrackets, stripCitations } from "../validate/text.ts";
import { describeLocation, validateDraft, type Draft, type ValidationRule } from "../validate/validator.ts";

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
  it("splits sentences, but never at B.S., an initial, a decimal or before a lower-case word", () => {
    expect(splitSentences("B.S. Computer Science, Fernwood University, 2019 [C6].")).toEqual(["B.S. Computer Science, Fernwood University, 2019 [C6]."]);
    expect(splitSentences("Cut costs by 3.5 points [C1]. Then shipped it [C3].")).toEqual(["Cut costs by 3.5 points [C1].", "Then shipped it [C3]."]);
    expect(splitSentences("Worked with J. Doe on it [C1]. e.g. this stays [C1].")).toEqual(["Worked with J. Doe on it [C1]. e.g. this stays [C1]."]);
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
    expect(datesIn("Joined in March 2022, left 3 June 2024.")).toEqual({ years: ["2022", "2024"], months: [3, 6] });
    expect(datesIn("You may start in 2022.")).toEqual({ years: ["2022"], months: [] });
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
