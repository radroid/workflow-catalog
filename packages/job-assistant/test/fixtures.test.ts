import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { claimSchema, jobSnapshotSchema } from "@workflow-catalog/contracts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../fixtures");

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
