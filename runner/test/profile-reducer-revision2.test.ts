import { randomUUID } from "node:crypto";
import { SOURCE_CATEGORIES } from "@workflow-catalog/contracts";
import { describe, expect, it } from "vitest";
import {
  currentWithdrawal,
  decodeWithdrawalSummary,
  NO_DETAIL_STATEMENT,
  pendingRevisions,
  questionNotes,
  readiness,
  reduce,
  type Action,
} from "../store/profile-reducer.ts";
import { createInitialProfile, type OnboardingProfile } from "../store/profile-types.ts";

/**
 * P03 revision 2: the reducer behaviour the round-2 review asked for.
 * D10 (notes on an open question), D11 (withdrawal applies pending
 * revisions), D15 (an edit that adds an always-ask item re-opens a question),
 * UI issue 2 (messages name claims by their words, never an id), UI issue 4
 * (no claims is not "every claim decided"), and VN3 (the superseded evidence
 * keeps its ref). Ids are real UUIDs here so a leaked id is detectable.
 */

const NOW = "2026-09-22T09:00:00.000Z";
const LATER = "2026-09-22T10:30:00.000Z";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SHORT_ID = /\b[0-9a-f]{8}\b/i;
const RAW_KEYS = /previousCoverLetters|portfolioSite|socialProfiles|workSamples|targetRolesAndPreferences|not_applicable/;

function apply(profile: OnboardingProfile, action: Action): OnboardingProfile {
  const result = reduce(profile, action);
  expect(result.ok, result.message).toBe(true);
  return result.profile;
}

function accounted(): OnboardingProfile {
  let profile = createInitialProfile(randomUUID);
  for (const category of SOURCE_CATEGORIES) {
    profile = apply(profile, { type: "accountSource", category, status: category === "resume" ? "provided" : "not_applicable" });
  }
  return profile;
}

function withClaims(profile: OnboardingProfile, texts: ReadonlyArray<{ text: string; kind?: "fact" | "metric" | "credential" }>): OnboardingProfile {
  return apply(profile, {
    type: "extractClaims",
    category: "resume",
    extracted: texts.map((item, index) => ({ text: item.text, kind: item.kind ?? "fact", evidenceRef: `resume.md#${index}`, evidenceQuote: item.text })),
    now: NOW,
    newId: randomUUID,
  });
}

/** Two confirmed fact claims (Harbor, Ledgerkit), approved as v1. */
function approvedProfile(): OnboardingProfile {
  let profile = withClaims(accounted(), [{ text: "Worked on the Harbor deployment pipeline." }, { text: "Contributed to Ledgerkit." }]);
  for (const claim of profile.claims) profile = apply(profile, { type: "decideClaim", claimId: claim.id, decision: "confirmed", now: NOW, newId: randomUUID });
  return apply(profile, { type: "approve", now: NOW });
}

describe("UI issue 4: readiness with no claims", () => {
  it("zero claims is not 'every claim decided'", () => {
    const r = readiness(accounted());
    expect(r.claimsSettled).toBe(false);
    expect(r.pendingClaims).toEqual([]);
    expect(r.reasons).toContain("Not ready: no claims yet. Extract claims from a provided source first.");
  });

  it("names pending claims by their words, never by id", () => {
    const profile = withClaims(accounted(), [{ text: "Cut the Harbor release time from a day to under an hour.", kind: "metric" }]);
    const reason = readiness(profile).reasons.find((line) => line.includes("decision"))!;
    expect(reason).toBe("Not ready: 1 claim still needs a decision (“Cut the Harbor release time from a day…”).");
    expect(reason).not.toMatch(SHORT_ID);
  });
});

describe("UI issue 2: messages name claims and sources for a person", () => {
  it("no reducer message carries a UUID, a short id, or a raw category key", () => {
    let profile = createInitialProfile(randomUUID);
    const messages: string[] = [];
    const run = (action: Action) => {
      const result = reduce(profile, action);
      messages.push(result.message);
      profile = result.profile;
      return result;
    };
    for (const category of SOURCE_CATEGORIES) run({ type: "accountSource", category, status: category === "resume" ? "provided" : "not_applicable", note: "Not part of my search." });
    run({ type: "extractClaims", category: "resume", extracted: [{ text: "Led the payments team at Northwind Labs.", kind: "fact", evidenceRef: "resume.md#a", evidenceQuote: "Led the payments team" }, { text: "B.S. Computer Science, Fernwood University.", kind: "credential", evidenceRef: "resume.md#b", evidenceQuote: "B.S. Computer Science" }], now: NOW, newId: randomUUID });
    const [led, degree] = profile.claims;
    run({ type: "decideClaim", claimId: led!.id, decision: "confirmed", now: NOW, newId: randomUUID });
    run({ type: "recordQuestionNote", claimId: led!.id, note: "It was a team of four.", now: NOW, newId: randomUUID });
    run({ type: "answerQuestion", claimId: led!.id, hasEvidence: true, now: NOW, newId: randomUUID });
    run({ type: "decideClaim", claimId: degree!.id, decision: "confirmed", now: NOW, newId: randomUUID });
    run({ type: "approve", now: NOW });
    run({ type: "editClaimText", claimId: degree!.id, text: "B.S. Computer Science, Fernwood University, 2019.", now: LATER, newId: randomUUID });
    const revision = pendingRevisions(profile)[0]!;
    run({ type: "rejectRevision", revisionId: revision.id, now: LATER });
    run({ type: "editStatementText", kind: "boundary", statementId: profile.boundaries[0]!.id, text: "Never invent a metric.", now: LATER, newId: randomUUID });
    run({ type: "rejectRevision", revisionId: pendingRevisions(profile)[0]!.id, now: LATER });
    run({ type: "addStatement", kind: "preference", text: "Remote-first roles.", now: LATER, newId: randomUUID });
    run({ type: "decideClaim", claimId: randomUUID(), decision: "confirmed", now: LATER, newId: randomUUID });

    expect(messages.length).toBeGreaterThan(10);
    for (const message of messages) {
      expect(message).not.toMatch(UUID);
      expect(message).not.toMatch(SHORT_ID);
      expect(message).not.toMatch(RAW_KEYS);
      expect(message).not.toContain("(s)");
    }
    expect(messages).toContain("Previous cover letters marked not applicable, with your reason kept. That still counts as accounted for; nothing is invented to fill the gap.");
    expect(messages).toContain("“Led the payments team at Northwind Labs.” confirmed. You confirmed it without adding detail.");
    expect(messages).toContain("Revision rejected. The boundary keeps its current text.");
  });

  it("confirming a question without detail records a plain statement, not a placeholder in quotes (UI issue 2)", () => {
    let profile = withClaims(accounted(), [{ text: "Cut the Harbor release time from a day to under an hour.", kind: "metric" }]);
    const claim = profile.claims[0]!;
    profile = apply(profile, { type: "decideClaim", claimId: claim.id, decision: "confirmed", now: NOW, newId: randomUUID });
    const answer = reduce(profile, { type: "answerQuestion", claimId: claim.id, hasEvidence: true, now: LATER, newId: randomUUID });
    expect(answer.message).toBe("“Cut the Harbor release time from a day to under an hour.” confirmed. You confirmed it without adding detail.");
    expect(answer.profile.claims[0]!.evidence).toEqual({ kind: "statement", ref: `claim:${claim.id}#answer-without-detail`, quote: NO_DETAIL_STATEMENT });
  });
});

describe("VN3: the superseded evidence is kept with its ref", () => {
  it("answering a question keeps the old passage's kind, quote and ref in revisions[]", () => {
    let profile = withClaims(accounted(), [{ text: "Cut the Harbor release time from a day to under an hour.", kind: "metric" }]);
    const claim = profile.claims[0]!;
    profile = apply(profile, { type: "decideClaim", claimId: claim.id, decision: "confirmed", now: NOW, newId: randomUUID });
    profile = apply(profile, { type: "answerQuestion", claimId: claim.id, hasEvidence: true, statement: "From the Harbor deploy dashboard.", now: LATER, newId: randomUUID });
    const record = profile.revisions.find((rev) => rev.summary.startsWith(`answer-evidence:${claim.id}`));
    expect(record?.summary).toBe(`answer-evidence:${claim.id}\nsuperseded passage evidence "Cut the Harbor release time from a day to under an hour." (resume.md#0) with the person's statement`);
    expect(record?.status).toBe("accepted");
  });
});

describe("D10: a note on an open question leaves the claim open", () => {
  it("records the note, keeps the claim disputed with its question, and shows it through questionNotes", () => {
    let profile = withClaims(accounted(), [{ text: "Cut the Harbor release time from a day to under an hour.", kind: "metric" }]);
    const claim = profile.claims[0]!;
    profile = apply(profile, { type: "decideClaim", claimId: claim.id, decision: "disputed", now: NOW, newId: randomUUID, question: "Measured against what?" });
    for (const note of ["No, I can't back that number up.", "exclude", "what do you mean?"]) {
      const result = reduce(profile, { type: "recordQuestionNote", claimId: claim.id, note, now: LATER, newId: randomUUID });
      expect(result.ok).toBe(true);
      expect(result.message).toContain("The question stays open");
      profile = result.profile;
    }
    expect(profile.claims[0]!.status).toBe("disputed");
    expect(profile.claims[0]!.question).toBe("Measured against what?");
    expect(questionNotes(profile)[claim.id]?.map((note) => note.text)).toEqual(["No, I can't back that number up.", "exclude", "what do you mean?"]);
  });

  it("refuses a note on a claim with no open question", () => {
    const profile = withClaims(accounted(), [{ text: "Contributed to Ledgerkit." }]);
    const result = reduce(profile, { type: "recordQuestionNote", claimId: profile.claims[0]!.id, note: "Some words.", now: NOW, newId: randomUUID });
    expect(result.ok).toBe(false);
    expect(result.profile).toBe(profile);
  });
});

describe("D11: withdrawing approval applies its pending revisions", () => {
  it("applies a pending claim edit and a pending boundary edit to the draft, records them accepted, and names them in the withdrawal", () => {
    let profile = approvedProfile();
    const [harbor, ledgerkit] = profile.claims;
    profile = apply(profile, { type: "editClaimText", claimId: harbor!.id, text: "Rebuilt the Harbor deployment pipeline.", now: LATER, newId: randomUUID });
    profile = apply(profile, { type: "editStatementText", kind: "boundary", statementId: profile.boundaries[0]!.id, text: "Never invent a metric or a credential.", now: LATER, newId: randomUUID });
    expect(pendingRevisions(profile)).toHaveLength(2);
    expect(profile.claims[0]!.text).toBe("Worked on the Harbor deployment pipeline."); // v1 still in force

    const dispute = reduce(profile, { type: "decideClaim", claimId: ledgerkit!.id, decision: "disputed", now: LATER, newId: randomUUID, question: "Which part?" });
    expect(dispute.ok).toBe(true);
    profile = dispute.profile;
    expect(dispute.message).toBe("“Contributed to Ledgerkit.” now has an open question: Which part? Approval of version 1 is withdrawn: answer the open question, then approve again.");

    expect(profile.approval).toBeNull();
    expect(pendingRevisions(profile)).toEqual([]);
    expect(profile.revisions.filter((rev) => rev.status === "proposed")).toEqual([]);
    expect(profile.claims.find((c) => c.id === harbor!.id)?.text).toBe("Rebuilt the Harbor deployment pipeline.");
    expect(profile.boundaries[0]!.text).toBe("Never invent a metric or a credential.");

    const withdrawal = currentWithdrawal(profile);
    expect(withdrawal).toEqual({
      version: 1,
      at: LATER,
      cause: { kind: "claim", change: "disputed", claimText: "Contributed to Ledgerkit." },
      applied: [
        { target: "claim", text: "Rebuilt the Harbor deployment pipeline." },
        { target: "boundary", text: "Never invent a metric or a credential." },
      ],
    });
    const marker = profile.revisions.find((rev) => decodeWithdrawalSummary(rev.summary));
    expect(decodeWithdrawalSummary(marker!.summary)?.applied).toHaveLength(2);
  });

  it("offers nothing to accept or reject afterwards, and approving again gives version 2", () => {
    let profile = approvedProfile();
    const [harbor, ledgerkit] = profile.claims;
    profile = apply(profile, { type: "editClaimText", claimId: harbor!.id, text: "Rebuilt the Harbor deployment pipeline.", now: LATER, newId: randomUUID });
    const revisionId = pendingRevisions(profile)[0]!.id;
    profile = apply(profile, { type: "decideClaim", claimId: ledgerkit!.id, decision: "confirmed", now: LATER, newId: randomUUID });
    const accept = reduce(profile, { type: "acceptRevision", revisionId, now: LATER, newId: randomUUID });
    expect(accept.ok).toBe(false);
    expect(accept.profile).toBe(profile);
    const approve = reduce(profile, { type: "approve", now: LATER });
    expect(approve.profile.approval).toEqual({ version: 2, at: LATER });
    expect(currentWithdrawal(approve.profile)).toBeNull();
  });

  it("adding a statement to an approved profile withdraws approval and names the statement", () => {
    const profile = approvedProfile();
    const result = reduce(profile, { type: "addStatement", kind: "preference", text: "Remote-first roles.", now: LATER, newId: randomUUID });
    expect(result.profile.approval).toBeNull();
    expect(currentWithdrawal(result.profile)?.cause).toEqual({ kind: "statement", change: "added", statementKind: "preference", statementText: "Remote-first roles." });
    expect(result.message).toBe("Your preference is recorded. Approval of version 1 is withdrawn: review the change, then approve again.");
  });
});

describe("D15 (VN7): an edit that adds an always-ask item re-opens the question", () => {
  it("unapproved: adding a number to a confirmed fact makes it disputed with a fresh question", () => {
    let profile = withClaims(accounted(), [{ text: "Worked on the Harbor deployment pipeline." }]);
    const claim = profile.claims[0]!;
    profile = apply(profile, { type: "decideClaim", claimId: claim.id, decision: "confirmed", now: NOW, newId: randomUUID });
    const edit = reduce(profile, { type: "editClaimText", claimId: claim.id, text: "Worked on the Harbor deployment pipeline, used by 40 teams.", now: LATER, newId: randomUUID });
    expect(edit.ok).toBe(true);
    const edited = edit.profile.claims[0]!;
    expect(edited.status).toBe("disputed");
    expect(edited.question).toContain("Worked on the Harbor deployment pipeline, used by 40 teams.");
    expect(edited.answeredAt).toBeUndefined();
    expect(edit.message).toBe("“Worked on the Harbor deployment pipeline, used by 40 teams.” changed what it claims, so it needs your answer again before it can be confirmed.");
  });

  it("unapproved: rewording that adds no always-ask item keeps it confirmed", () => {
    let profile = withClaims(accounted(), [{ text: "Worked on the Harbor deployment pipeline." }]);
    const claim = profile.claims[0]!;
    profile = apply(profile, { type: "decideClaim", claimId: claim.id, decision: "confirmed", now: NOW, newId: randomUUID });
    const edit = reduce(profile, { type: "editClaimText", claimId: claim.id, text: "Worked on Harbor's deployment pipeline.", now: LATER, newId: randomUUID });
    expect(edit.profile.claims[0]!.status).toBe("confirmed");
  });

  it("approved: the edit is a proposed revision, and accepting it re-opens the question and withdraws approval (D11)", () => {
    let profile = approvedProfile();
    const [harbor, ledgerkit] = profile.claims;
    profile = apply(profile, { type: "editClaimText", claimId: ledgerkit!.id, text: "Maintainer of Ledgerkit.", now: LATER, newId: randomUUID });
    profile = apply(profile, { type: "editClaimText", claimId: harbor!.id, text: "Rebuilt the Harbor deployment pipeline.", now: LATER, newId: randomUUID });
    expect(profile.approval?.version).toBe(1);
    expect(profile.claims.find((c) => c.id === ledgerkit!.id)?.status).toBe("confirmed"); // still v1's text and status
    const [ledgerkitRevision] = pendingRevisions(profile);

    const accept = reduce(profile, { type: "acceptRevision", revisionId: ledgerkitRevision!.id, now: LATER, newId: randomUUID });
    expect(accept.ok).toBe(true);
    profile = accept.profile;
    const reopened = profile.claims.find((c) => c.id === ledgerkit!.id)!;
    expect(reopened.text).toBe("Maintainer of Ledgerkit.");
    expect(reopened.status).toBe("disputed");
    expect(reopened.question).toBeDefined();
    expect(profile.approval).toBeNull();
    expect(accept.message).toBe("Accepted. “Maintainer of Ledgerkit.” now needs your answer to a question before it can be confirmed, so approval of version 1 is withdrawn. Answer it on the Onboarding page, then approve again.");
    // The other pending revision was applied with the withdrawal (D11).
    expect(profile.claims.find((c) => c.id === harbor!.id)?.text).toBe("Rebuilt the Harbor deployment pipeline.");
    expect(pendingRevisions(profile)).toEqual([]);
    expect(currentWithdrawal(profile)?.cause).toEqual({ kind: "claim", change: "reopened", claimText: "Maintainer of Ledgerkit." });
  });
});
