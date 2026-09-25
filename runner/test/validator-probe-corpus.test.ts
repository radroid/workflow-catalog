import { readFileSync } from "node:fs";
import path from "node:path";
import { claimSchema } from "@workflow-catalog/contracts";
import { describe, expect, it } from "vitest";
import { JOB_ASSISTANT_DIR } from "../lib/paths.ts";
import { labelClaims } from "../validate/claims.ts";
import { validateDraft, type Draft, type ValidationClaim } from "../validate/validator.ts";

/**
 * P05.1: the probe corpus. Every reviewer probe from P05's review rounds 2-5
 * and the merge gate (`/tmp/wc-rev-p05-r{2,3,4,5}-probes/` and
 * `/tmp/wc-gate-p05-probes/`, 16 files: r2, r2b, r2c, r2d, r3,
 * r3-realistic-reworded, r3b, r3c, r3d, r4, r4b, r4c, r5, r5b, r5c and the
 * gate reviewer's own `validator-probe-gate.ts`, which is also where the
 * merge gate's FOLLOW-UPs F1-F5 live as named probes), pinned as one row
 * each with today's verdict against the validator as merged at P05 (fa66206
 * / 3e2c868), so a later change to `runner/validate/` can't silently drift a
 * probe's outcome. `reviewerWant` is the probe's own original expectation,
 * kept only for reference: several rows recorded a REFUSE the reviewer
 * wanted as a PASS or vice versa (a cost already accepted at P05's merge,
 * catalogued in the round review files); `verdict` is what pins the test.
 *
 * Every extra claim's `id` is a placeholder: the validator's title, number,
 * date and credential rules read a claim's `text`, `kind` and `status`
 * only, never its `id` (only `raw_id`/`excluded_claim` read a sentence's own
 * text for a UUID, and no probe sentence names one of these placeholders).
 *
 * Every row runs as a single resume bullet under "Experience": the
 * validator's per-sentence rules never depend on which of the fixed resume
 * headings a bullet sits under, so a probe originally run under "Education"
 * or "Skills" gets the identical verdict here (confirmed against the
 * captured output when the corpus was built).
 */

interface CorpusRow {
  readonly source: string;
  readonly index: number;
  readonly name: string;
  readonly statements: readonly string[];
  readonly verdict: "PASS" | "REFUSE";
  readonly reviewerWant: "PASS" | "REFUSE" | null;
  readonly refusals: ReadonlyArray<{ readonly rule: string; readonly message: string }>;
}

interface CorpusFixture {
  readonly sources: Readonly<Record<string, ReadonlyArray<{ readonly id: string; readonly text: string; readonly kind: string; readonly status: string }>>>;
  readonly rows: readonly CorpusRow[];
}

const FIXTURE: CorpusFixture = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/validator-probes.json"), "utf8"));

const BASE_CLAIMS = labelClaims(claimSchema.array().parse(JSON.parse(readFileSync(path.join(JOB_ASSISTANT_DIR, "fixtures/expected-claims.json"), "utf8"))));

function claimsFor(source: string): ValidationClaim[] {
  const extra = FIXTURE.sources[source];
  if (extra === undefined) throw new Error(`no claims recorded for source ${source}`);
  return [...BASE_CLAIMS, ...extra.map((claim, index) => ({ label: `C${BASE_CLAIMS.length + index + 1}`, id: claim.id, kind: claim.kind as ValidationClaim["kind"], status: claim.status as ValidationClaim["status"], text: claim.text }))];
}

function draftOf(statements: readonly string[]): Draft {
  return { resume: { sections: [{ heading: "Experience", statements: [...statements] }] } };
}

describe("validator probe corpus (P05.1)", () => {
  it("has one claims set per source named in the rows", () => {
    const rowSources = new Set(FIXTURE.rows.map((row) => row.source));
    for (const source of rowSources) expect(FIXTURE.sources[source], `sources.${source}`).toBeDefined();
  });

  for (const source of Object.keys(FIXTURE.sources)) {
    describe(source, () => {
      const claims = claimsFor(source);
      const rows = FIXTURE.rows.filter((row) => row.source === source);
      it(`pins ${rows.length} rows`, () => expect(rows.length).toBeGreaterThan(0));

      for (const row of rows) {
        it(`#${row.index} ${row.name}`, () => {
          const result = validateDraft({ draft: draftOf(row.statements), claims, postingText: "", coverLetterRequested: false });
          const got = result.ok ? "PASS" : "REFUSE";
          expect(got, `verdict for: ${row.statements.join(" ")}`).toBe(row.verdict);
          const gotRules = [...new Set(result.refusals.map((refusal) => refusal.rule))].sort();
          const wantRules = [...new Set(row.refusals.map((refusal) => refusal.rule))].sort();
          expect(gotRules, `refusal rules for: ${row.statements.join(" ")}`).toEqual(wantRules);
        });
      }
    });
  }
});
