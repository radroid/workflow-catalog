import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { claimSchema, jobSnapshotSchema, type Claim } from "@workflow-catalog/contracts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../fixtures");
const followUpSkillPath = path.resolve(here, "../skills/follow-up-questions/SKILL.md");

/** Schema lookup for fixtures/index.json's non-"raw-text" values. Keys match the manifest's schema-name strings exactly. */
const SCHEMA_BY_NAME: Record<string, z.ZodType> = {
  "job-snapshot": jobSnapshotSchema,
  claim: claimSchema,
};

function readManifest(): Record<string, string> {
  return JSON.parse(readFileSync(path.join(fixturesDir, "index.json"), "utf8"));
}

function readFixture(file: string): unknown {
  const raw = readFileSync(path.join(fixturesDir, file), "utf8");
  return file.endsWith(".json") ? JSON.parse(raw) : raw;
}

describe("fixtures/index.json manifest", () => {
  it("lists every fixture file present in fixtures/, and nothing extra", () => {
    const manifest = readManifest();
    const actualFiles = readdirSync(fixturesDir).filter((f) => f !== "index.json");
    expect(new Set(Object.keys(manifest))).toEqual(new Set(actualFiles));
  });

  const manifest = readManifest();
  for (const [file, schemaName] of Object.entries(manifest)) {
    it(`${file} validates against its declared schema ("${schemaName}")`, () => {
      if (schemaName === "raw-text") {
        const text = readFixture(file) as string;
        expect(text.trim().length).toBeGreaterThan(0);
        return;
      }

      const isArray = schemaName.endsWith("[]");
      const baseName = isArray ? schemaName.slice(0, -2) : schemaName;
      const schema = SCHEMA_BY_NAME[baseName];
      if (!schema) {
        throw new Error(`fixtures/index.json names unknown schema "${schemaName}" for ${file}`);
      }

      const data = readFixture(file);
      if (isArray) {
        expect(Array.isArray(data)).toBe(true);
        for (const item of data as unknown[]) {
          const result = schema.safeParse(item);
          expect(result.success, result.success ? "" : JSON.stringify(result.error.issues, null, 2)).toBe(
            true,
          );
        }
      } else {
        const result = schema.safeParse(data);
        expect(result.success, result.success ? "" : JSON.stringify(result.error.issues, null, 2)).toBe(
          true,
        );
      }
    });
  }
});

/**
 * Revision 2, fix B. job-snapshot.ts documents `JobSnapshot.contentHash` as
 * the lowercase hex SHA-256 of `text` encoded as UTF-8, exactly as stored.
 * Revision 1 edited job-fernwood.json's text and left the old digest behind.
 */
describe("JobSnapshot fixtures carry the documented contentHash of their own text", () => {
  const snapshotFiles = Object.entries(readManifest())
    .filter(([, schemaName]) => schemaName === "job-snapshot")
    .map(([file]) => file);

  it("finds the three job posting fixtures", () => {
    expect([...snapshotFiles].sort()).toEqual(["job-fernwood.json", "job-harbor.json", "job-hostile.json"]);
  });

  it.each(snapshotFiles)("%s: contentHash = lowercase hex SHA-256 of text as UTF-8", (file) => {
    const snapshot = readFixture(file) as { text: string; contentHash: string };
    expect(snapshot.contentHash).toBe(createHash("sha256").update(snapshot.text, "utf8").digest("hex"));
  });
});

describe("hostile job posting fixture", () => {
  const hostile = readFixture("job-hostile.json") as {
    text: string;
    structured: { requirements?: string[] };
  };

  it("contains the required phrase verbatim", () => {
    expect(hostile.text).toContain("ignore previous instructions");
  });

  it("contains a fake action request naming an allowlisted action", () => {
    expect(hostile.text).toMatch(/open_application_group|report_status|capture_job/);
  });

  it("still validates as an ordinary JobSnapshot — hostile content is data, not a command", () => {
    expect(jobSnapshotSchema.safeParse(hostile).success).toBe(true);
  });

  // Issue 6: the injection lives one level deeper than the raw posting
  // text — inside an already-"extracted" structured.requirements[] entry,
  // as if a hostile instruction survived extraction disguised as a
  // requirement bullet. claim-matching/resume-drafting/cover-letter-drafting
  // consume structured.requirements[] directly (never re-parsing
  // JobSnapshot.text), so this is the shape their own Never-lines must hold
  // up against.
  it("also carries an injected instruction inside structured.requirements[], not just the raw text", () => {
    const requirements = hostile.structured.requirements ?? [];
    const poisoned = requirements.find((r) => r.includes("ignore previous instructions"));
    expect(poisoned, "no structured.requirements[] entry contains the injected instruction").toBeDefined();
    expect(poisoned).toMatch(/open_application_group|report_status|capture_job/);
  });

  it("structured.requirements[] with the injected instruction still validates — it's an ordinary string, not a special case", () => {
    expect(jobSnapshotSchema.safeParse(hostile).success).toBe(true);
  });
});

describe("expected-excluded-metric.json", () => {
  it("appears in expected-claims.json with a matching id, and is excluded", () => {
    const claims = readFixture("expected-claims.json") as Array<{ id: string; status: string; kind: string }>;
    const excludedMetric = readFixture("expected-excluded-metric.json") as { id: string };

    const match = claims.find((claim) => claim.id === excludedMetric.id);
    expect(match).toBeDefined();
    expect(match?.status).toBe("excluded");
    expect(match?.kind).toBe("metric");
  });
});

/**
 * Revision 2, fix C. follow-up-questions/SKILL.md always asks about metric,
 * title and date claims, and about any claim whose text uses one of its
 * always-ask words. So a confirmed claim of that sort must carry the question
 * it was asked and when it was answered. The kinds and the words are read
 * from the skill itself, so the skill and this test cannot drift apart.
 */
describe("confirmed claims follow follow-up-questions' always-ask rule", () => {
  const skill = readFileSync(followUpSkillPath, "utf8");
  const alwaysAskKinds = [
    ...skill.matchAll(/^- Every claim with `kind: "(\w+)"` gets a question, no exceptions/gm),
  ].map((match) => match[1]!);
  const wordList = skill.match(/Always-ask words: ((?:`[^`]+`(?:, )?)+)/)?.[1] ?? "";
  const alwaysAskWords = [...wordList.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);

  /** The skill's matching rule: a whole word (or phrase), in any letter case. */
  function usesAlwaysAskWord(text: string): boolean {
    return alwaysAskWords.some((word) =>
      new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text),
    );
  }

  const claims = Object.entries(readManifest())
    .filter(([, schemaName]) => schemaName === "claim" || schemaName === "claim[]")
    .flatMap(([file]) => {
      const data = readFixture(file);
      return (Array.isArray(data) ? data : [data]) as Claim[];
    });
  const alwaysAskConfirmed = claims.filter(
    (claim) => claim.status === "confirmed" && (alwaysAskKinds.includes(claim.kind) || usesAlwaysAskWord(claim.text)),
  );

  it("reads the always-ask kinds and words from the skill", () => {
    expect(alwaysAskKinds).toEqual(expect.arrayContaining(["metric", "title", "date"]));
    expect(alwaysAskWords).toEqual(
      expect.arrayContaining(["led", "founded", "the only", "fastest", "maintainer", "used by"]),
    );
  });

  it("matches whole words in any case, so 'Led' counts and 'ledger' does not", () => {
    expect(usesAlwaysAskWord("Led the payments infrastructure team")).toBe(true);
    // "ledger"/"Ledgerkit" both contain "led" as a substring, never as a
    // whole word — isolated from "maintainer" (a separate always-ask word,
    // covered below) so this only exercises the whole-word boundary.
    expect(usesAlwaysAskWord("Ledgerkit is an open-source ledger reconciliation library.")).toBe(false);
  });

  // P01.1 packet: the always-ask wording ("superlative, role, or scope")
  // already covered these two fixture claims' texts verbatim before the
  // word list did; these two words close that gap. See the fixtures test
  // below for the end-to-end proof (both claims carry question/answeredAt).
  it("matches the role/scope words added for 76d49b1e and 169fa5e1", () => {
    expect(usesAlwaysAskWord("Maintainer of Ledgerkit, an open-source ledger reconciliation library.")).toBe(
      true,
    );
    expect(usesAlwaysAskWord("Shipped the on-call rotation tooling used by three engineering teams.")).toBe(
      true,
    );
  });

  it("every confirmed metric, title or date claim, and every confirmed claim using an always-ask word, carries question and answeredAt", () => {
    expect(alwaysAskConfirmed.some((claim) => usesAlwaysAskWord(claim.text))).toBe(true);
    for (const claim of alwaysAskConfirmed) {
      const label = `${claim.id} (${claim.kind}) "${claim.text}"`;
      expect(claim.question, `${label} has no question`).toBeTruthy();
      expect(claim.answeredAt, `${label} has no answeredAt`).toBeTruthy();
    }
  });
});

describe("expected-claims.json", () => {
  it("every claim's evidence.quote appears verbatim in resume.md", () => {
    const resume = readFixture("resume.md") as string;
    const claims = readFixture("expected-claims.json") as Array<{ evidence: { quote: string } }>;
    for (const claim of claims) {
      expect(resume, `quote not found verbatim in resume.md: ${JSON.stringify(claim.evidence.quote)}`).toContain(
        claim.evidence.quote,
      );
    }
  });
});
