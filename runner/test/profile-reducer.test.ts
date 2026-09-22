import { SOURCE_CATEGORIES } from "@workflow-catalog/contracts";
import { describe, expect, it } from "vitest";
import { createInitialProfile } from "../store/profile-types.ts";
import { decodeWithdrawalSummary, reduce, readiness, type Action } from "../store/profile-reducer.ts";

/**
 * The pure reducer, driven directly with no I/O and no model — the packet's
 * acceptance criterion's "six walkthrough scenarios". Each scenario below
 * reproduces the onboarding/career-profile-relevant slice of one of
 * `docs/spec/visuals/index.html`'s six guided walkthroughs (SCENARIOS[0..5]);
 * the rest of each walkthrough (job matching, tab groups, scheduling) is
 * other packets' territory.
 */

function idGen(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

/** Accounts "resume" as provided and every other category as not applicable — readiness.sourcesAccounted needs all seven, not just the one a scenario cares about. */
function accountResumeAndRestNotApplicable(profile: ReturnType<typeof createInitialProfile>): ReturnType<typeof createInitialProfile> {
  let next = profile;
  for (const category of SOURCE_CATEGORIES) {
    next = reduce(next, { type: "accountSource", category, status: category === "resume" ? "provided" : "not_applicable" }).profile;
  }
  return next;
}

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";

describe("profile-reducer: 1 - First application (happy path)", () => {
  it("accounts every source, extracts, confirms every claim, and approves — readiness flips only after approval", () => {
    const newId = idGen("id");
    let profile = createInitialProfile(newId);

    for (const category of SOURCE_CATEGORIES) {
      const action: Action = { type: "accountSource", category, status: category === "resume" ? "provided" : "not_applicable" };
      const result = reduce(profile, action);
      expect(result.ok).toBe(true);
      profile = result.profile;
    }
    expect(readiness(profile).sourcesAccounted).toBe(true);
    expect(readiness(profile).ready).toBe(false); // no claims yet

    const extract = reduce(profile, {
      type: "extractClaims",
      category: "resume",
      extracted: [{ text: "B.S. Computer Science, Fernwood University, 2019.", kind: "credential", evidenceRef: "resume.md#education", evidenceQuote: "B.S. Computer Science, Fernwood University, 2019" }],
      now: NOW,
      newId,
    });
    expect(extract.ok).toBe(true);
    profile = extract.profile;
    expect(profile.claims).toHaveLength(1);
    const claimId = profile.claims[0]!.id;

    const confirm = reduce(profile, { type: "decideClaim", claimId, decision: "confirmed", now: NOW, newId });
    expect(confirm.ok).toBe(true);
    profile = confirm.profile;
    expect(profile.claims[0]!.status).toBe("confirmed");

    // Every condition but approval is already satisfied — ready still reads
    // false until the profile is actually approved.
    const beforeApproval = readiness(profile);
    expect(beforeApproval.sourcesAccounted).toBe(true);
    expect(beforeApproval.claimsSettled).toBe(true);
    expect(beforeApproval.hasConfirmedClaims).toBe(true);
    expect(beforeApproval.approved).toBe(false);
    expect(beforeApproval.ready).toBe(false);

    const approve = reduce(profile, { type: "approve", now: NOW });
    expect(approve.ok).toBe(true);
    profile = approve.profile;
    expect(profile.approval).toEqual({ version: 1, at: NOW });
    expect(readiness(profile).ready).toBe(true);
  });
});

describe("profile-reducer: 2 - Too early", () => {
  it("refuses approve() before sources are accounted for, with the exact reason", () => {
    const newId = idGen("id");
    const profile = createInitialProfile(newId);

    const result = reduce(profile, { type: "approve", now: NOW });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Not ready: 7 sources unaccounted for/);
    expect(result.profile).toBe(profile); // refused: state unchanged
  });

  it("readiness names each failing condition in order: sources, then claims, then approval", () => {
    const newId = idGen("id");
    let profile = createInitialProfile(newId);
    for (const category of SOURCE_CATEGORIES) {
      profile = reduce(profile, { type: "accountSource", category, status: "not_applicable" }).profile;
    }
    const r = readiness(profile);
    expect(r.reasons).toEqual(["Not ready: no claims yet. Extract claims from a provided source first.", "Not ready: the career profile has not been approved yet."]);
  });
});

describe("profile-reducer: 3 - The shaky metric", () => {
  it("a metric always needs a question; without evidence it moves to excluded, never a document", () => {
    const newId = idGen("id");
    let profile = createInitialProfile(newId);
    profile = reduce(profile, { type: "accountSource", category: "resume", status: "provided" }).profile;

    const extract = reduce(profile, {
      type: "extractClaims",
      category: "resume",
      extracted: [{ text: "Cut deploy time 30% faster.", kind: "metric", evidenceRef: "resume.md#role", evidenceQuote: "30% faster" }],
      now: NOW,
      newId,
    });
    profile = extract.profile;
    const claim = profile.claims[0]!;
    expect(claim.status).toBe("candidate");
    expect(claim.question).toBeDefined(); // the metric always-ask rule fires at extraction time

    // Confirming a claim that needsQuestion and hasn't been answered redirects to disputed.
    const confirmAttempt = reduce(profile, { type: "decideClaim", claimId: claim.id, decision: "confirmed", now: NOW, newId });
    expect(confirmAttempt.ok).toBe(true);
    profile = confirmAttempt.profile;
    expect(profile.claims[0]!.status).toBe("disputed");

    // The friend cannot back the metric up: answerQuestion(hasEvidence: false) excludes it.
    const answer = reduce(profile, { type: "answerQuestion", claimId: claim.id, hasEvidence: false, now: LATER, newId });
    expect(answer.ok).toBe(true);
    profile = answer.profile;
    expect(profile.claims[0]!.status).toBe("excluded");
    expect(profile.claims[0]!.answeredAt).toBe(LATER);
  });
});

describe("profile-reducer: 4 - A closed tab is not an application", () => {
  it("excluding a claim never withdraws approval, unlike confirming or disputing a claim change", () => {
    const newId = idGen("id");
    let profile = createInitialProfile(newId);
    profile = accountResumeAndRestNotApplicable(profile);
    profile = reduce(profile, {
      type: "extractClaims",
      category: "resume",
      extracted: [
        { text: "B.S. Computer Science.", kind: "credential", evidenceRef: "resume.md#a", evidenceQuote: "B.S." },
        { text: "Software engineer at Northwind Labs.", kind: "fact", evidenceRef: "resume.md#b", evidenceQuote: "Software engineer at Northwind Labs" },
      ],
      now: NOW,
      newId,
    }).profile;
    const [keep, drop] = profile.claims;
    profile = reduce(profile, { type: "decideClaim", claimId: keep!.id, decision: "confirmed", now: NOW, newId }).profile;
    profile = reduce(profile, { type: "decideClaim", claimId: drop!.id, decision: "confirmed", now: NOW, newId }).profile;
    profile = reduce(profile, { type: "approve", now: NOW }).profile;
    expect(profile.approval).not.toBeNull();

    // An incidental cleanup — excluding a confirmed claim — is not treated as
    // "a claim changed" the way confirming/disputing one is: approval stays.
    const exclude = reduce(profile, { type: "decideClaim", claimId: drop!.id, decision: "excluded", now: LATER, newId });
    expect(exclude.ok).toBe(true);
    profile = exclude.profile;
    expect(profile.claims.find((c) => c.id === drop!.id)?.status).toBe("excluded");
    expect(profile.approval).toEqual({ version: 1, at: NOW }); // unchanged

    // But re-confirming (an explicit claim change) does withdraw it.
    const reconfirm = reduce(profile, { type: "decideClaim", claimId: keep!.id, decision: "confirmed", now: LATER, newId });
    // keep! is already confirmed and needs no question, so this is a no-op decision through the same path as a genuine change:
    expect(reconfirm.ok).toBe(true);
    expect(reconfirm.profile.approval).toBeNull(); // R4 mutation #1: dropping the withdrawal on confirm must fail here.
    expect(reconfirm.message).toMatch(/withdrawn/);
  });
});

describe("profile-reducer: 5 - Scheduled prep runs twice", () => {
  it("re-extracting the same (source, evidence) content is idempotent: the retry adds nothing new", () => {
    const newId = idGen("id");
    let profile = createInitialProfile(newId);
    profile = reduce(profile, { type: "accountSource", category: "resume", status: "provided" }).profile;

    const extracted = [{ text: "Led the team.", kind: "fact" as const, evidenceRef: "resume.md#a", evidenceQuote: "Led the team" }];
    const first = reduce(profile, { type: "extractClaims", category: "resume", extracted, now: NOW, newId });
    expect(first.ok).toBe(true);
    profile = first.profile;
    expect(profile.claims).toHaveLength(1);

    // The laptop slept through the schedule; the run fires again with the same content.
    const retry = reduce(profile, { type: "extractClaims", category: "resume", extracted, now: LATER, newId });
    expect(retry.ok).toBe(true);
    expect(retry.message).toMatch(/idempotent/);
    profile = retry.profile;
    expect(profile.claims).toHaveLength(1); // still exactly one — no duplicate
  });
});

describe("profile-reducer: 6 - Editing an approved fact", () => {
  it("editing a confirmed claim after approval proposes a revision; v1 stays in force until accepted", () => {
    const newId = idGen("id");
    let profile = createInitialProfile(newId);
    profile = accountResumeAndRestNotApplicable(profile);
    profile = reduce(profile, {
      type: "extractClaims",
      category: "resume",
      extracted: [{ text: "Worked on the payments team.", kind: "fact", evidenceRef: "resume.md#a", evidenceQuote: "Worked on the payments team" }],
      now: NOW,
      newId,
    }).profile;
    const claimId = profile.claims[0]!.id;
    profile = reduce(profile, { type: "decideClaim", claimId, decision: "confirmed", now: NOW, newId }).profile;
    profile = reduce(profile, { type: "approve", now: NOW }).profile;
    expect(profile.approval).toEqual({ version: 1, at: NOW });

    const edit = reduce(profile, { type: "editClaimText", claimId, text: "Worked on the core payments team.", now: LATER, newId });
    expect(edit.ok).toBe(true);
    profile = edit.profile;
    // v1 stays in force: the claim's own text is unchanged, approval untouched.
    expect(profile.claims[0]!.text).toBe("Worked on the payments team.");
    expect(profile.approval).toEqual({ version: 1, at: NOW });
    expect(profile.revisions).toHaveLength(1);
    expect(profile.revisions[0]!.status).toBe("proposed");

    const revisionId = profile.revisions[0]!.id;
    const accept = reduce(profile, { type: "acceptRevision", revisionId, now: LATER, newId });
    expect(accept.ok).toBe(true);
    profile = accept.profile;
    expect(profile.claims[0]!.text).toBe("Worked on the core payments team.");
    expect(profile.approval).toEqual({ version: 2, at: LATER });
    expect(profile.revisions[0]!.status).toBe("accepted");
    expect(profile.revisions[0]!.resultingVersion).toBe(2);
  });

  it("rejecting a proposed revision keeps the claim's current text", () => {
    const newId = idGen("id");
    let profile = createInitialProfile(newId);
    profile = accountResumeAndRestNotApplicable(profile);
    profile = reduce(profile, {
      type: "extractClaims",
      category: "resume",
      extracted: [{ text: "Worked on the payments team.", kind: "fact", evidenceRef: "resume.md#a", evidenceQuote: "Worked on the payments team" }],
      now: NOW,
      newId,
    }).profile;
    const claimId = profile.claims[0]!.id;
    profile = reduce(profile, { type: "decideClaim", claimId, decision: "confirmed", now: NOW, newId }).profile;
    profile = reduce(profile, { type: "approve", now: NOW }).profile;
    profile = reduce(profile, { type: "editClaimText", claimId, text: "Something else entirely.", now: LATER, newId }).profile;
    const revisionId = profile.revisions[0]!.id;

    const reject = reduce(profile, { type: "rejectRevision", revisionId, now: LATER });
    expect(reject.ok).toBe(true);
    profile = reject.profile;
    expect(profile.claims[0]!.text).toBe("Worked on the payments team.");
    expect(profile.revisions[0]!.status).toBe("rejected");
  });
});

/** One confirmed claim, resume-only, ready to approve — the common setup for the R1/R2 regression tests below. */
function readyToApproveProfile(newId: () => string): { profile: ReturnType<typeof createInitialProfile>; claimId: string } {
  let profile = createInitialProfile(newId);
  profile = accountResumeAndRestNotApplicable(profile);
  profile = reduce(profile, {
    type: "extractClaims",
    category: "resume",
    extracted: [{ text: "Worked on the payments team.", kind: "fact", evidenceRef: "resume.md#a", evidenceQuote: "Worked on the payments team" }],
    now: NOW,
    newId,
  }).profile;
  const claimId = profile.claims[0]!.id;
  profile = reduce(profile, { type: "decideClaim", claimId, decision: "confirmed", now: NOW, newId }).profile;
  return { profile, claimId };
}

describe("profile-reducer: R1 — approval version numbers are never reused", () => {
  it("re-confirming a claim withdraws v1; approving again produces v2, never v1 again", () => {
    const newId = idGen("id");
    const { profile: initialProfile, claimId } = readyToApproveProfile(newId);
    let profile = initialProfile;
    profile = reduce(profile, { type: "approve", now: NOW }).profile;
    expect(profile.approval).toEqual({ version: 1, at: NOW });

    // Re-confirming an already-confirmed claim is still "a claim changed" (scenario 4) — withdraws.
    const reconfirm = reduce(profile, { type: "decideClaim", claimId, decision: "confirmed", now: LATER, newId });
    expect(reconfirm.ok).toBe(true);
    profile = reconfirm.profile;
    expect(profile.approval).toBeNull();
    // The withdrawal itself is recorded, so the retired version is never handed out again.
    const withdrawal = profile.revisions.find((r) => decodeWithdrawalSummary(r.summary)?.version === 1);
    expect(withdrawal).toBeDefined();
    expect(withdrawal!.resultingVersion).toBe(1);

    const approveAgain = reduce(profile, { type: "approve", now: LATER });
    expect(approveAgain.ok).toBe(true);
    profile = approveAgain.profile;
    expect(profile.approval).toEqual({ version: 2, at: LATER }); // not v1 again
  });

  it("acceptRevision refuses once approval has been withdrawn — accepting a stale revision can never re-approve on its own", () => {
    const newId = idGen("id");
    const { profile: initialProfile, claimId } = readyToApproveProfile(newId);
    let profile = initialProfile;
    profile = reduce(profile, {
      type: "extractClaims",
      category: "resume",
      extracted: [{ text: "Owned the on-call rotation.", kind: "fact", evidenceRef: "resume.md#b", evidenceQuote: "Owned the on-call rotation" }],
      now: NOW,
      newId,
    }).profile;
    const claimBId = profile.claims[1]!.id;
    profile = reduce(profile, { type: "decideClaim", claimId: claimBId, decision: "confirmed", now: NOW, newId }).profile;
    profile = reduce(profile, { type: "approve", now: NOW }).profile;
    expect(profile.approval).toEqual({ version: 1, at: NOW });

    // Propose a revision to claim A — v1 stays in force, nothing withdrawn yet.
    const editA = reduce(profile, { type: "editClaimText", claimId, text: "Worked on the core payments team.", now: LATER, newId });
    expect(editA.ok).toBe(true);
    profile = editA.profile;
    expect(profile.approval).toEqual({ version: 1, at: NOW });
    const revisionAId = profile.revisions.find((r) => r.status === "proposed")!.id;

    // Confirming claim B again withdraws v1 (a claim changed).
    const reconfirmB = reduce(profile, { type: "decideClaim", claimId: claimBId, decision: "confirmed", now: LATER, newId });
    expect(reconfirmB.ok).toBe(true);
    profile = reconfirmB.profile;
    expect(profile.approval).toBeNull();

    // Accepting A's now-stale revision must refuse, not silently re-approve at v1.
    const accept = reduce(profile, { type: "acceptRevision", revisionId: revisionAId, now: LATER, newId });
    expect(accept.ok).toBe(false);
    expect(accept.profile.approval).toBeNull();
    expect(accept.profile).toBe(profile); // refused: state unchanged
    expect(readiness(accept.profile).ready).toBe(false);
  });
});

describe("profile-reducer: R2 — any claim change but exclusion withdraws approval; statement edits become revisions too", () => {
  it("disputing an approved, confirmed claim withdraws approval", () => {
    const newId = idGen("id");
    const { profile: initialProfile, claimId } = readyToApproveProfile(newId);
    let profile = initialProfile;
    profile = reduce(profile, { type: "approve", now: NOW }).profile;
    expect(profile.approval).not.toBeNull();

    const dispute = reduce(profile, { type: "decideClaim", claimId, decision: "disputed", now: LATER, newId, question: "Can you say more?" });
    expect(dispute.ok).toBe(true);
    profile = dispute.profile;
    expect(profile.claims[0]!.status).toBe("disputed");
    expect(profile.approval).toBeNull();
    expect(dispute.message).toMatch(/withdrawn/);
  });

  it("answering with evidence, on an approved profile, withdraws approval and records the new evidence as {kind: statement}, not the superseded passage", () => {
    const newId = idGen("id");
    const { profile: seeded, claimId } = readyToApproveProfile(newId);
    let profile = reduce(seeded, { type: "approve", now: NOW }).profile;
    expect(profile.approval).toEqual({ version: 1, at: NOW });

    // A source re-extracted after approval can add a fresh candidate without
    // withdrawing approval (test/profile-store.test.ts covers this directly
    // at the store layer); a metric always needs a question, so confirming
    // it redirects to disputed without touching approval either — the
    // redirect is not itself "a claim changed", only an actual decision is.
    profile = reduce(profile, {
      type: "extractClaims",
      category: "resume",
      extracted: [{ text: "Cut deploy time in half.", kind: "metric", evidenceRef: "resume.md#b", evidenceQuote: "Cut deploy time in half" }],
      now: NOW,
      newId,
    }).profile;
    const metricClaimId = profile.claims[1]!.id;
    profile = reduce(profile, { type: "decideClaim", claimId: metricClaimId, decision: "confirmed", now: NOW, newId }).profile;
    expect(profile.claims[1]!.status).toBe("disputed");
    expect(profile.approval).toEqual({ version: 1, at: NOW }); // still untouched

    const answer = reduce(profile, { type: "answerQuestion", claimId: metricClaimId, hasEvidence: true, statement: "I ran this migration myself.", now: LATER, newId });
    expect(answer.ok).toBe(true);
    profile = answer.profile;
    expect(profile.claims[1]!.status).toBe("confirmed");
    expect(profile.claims[1]!.evidence).toEqual({ kind: "statement", ref: `claim:${metricClaimId}#answer`, quote: "I ran this migration myself." });
    expect(profile.approval).toBeNull(); // withdrawn — the evidence itself changed
    expect(answer.message).toMatch(/withdrawn/);
    void claimId; // the first (unrelated) confirmed claim, untouched by this scenario
  });

  it("editing a boundary after approval proposes a revision instead of applying directly; accepting it bumps the version", () => {
    const newId = idGen("id");
    let { profile } = readyToApproveProfile(newId);
    profile = reduce(profile, { type: "approve", now: NOW }).profile;
    const boundaryId = profile.boundaries[0]!.id;
    const originalText = profile.boundaries[0]!.text;

    const edit = reduce(profile, {
      type: "editStatementText",
      kind: "boundary",
      statementId: boundaryId,
      text: "Do not invent metrics, credentials, responsibilities, or scope.",
      now: LATER,
      newId,
    });
    expect(edit.ok).toBe(true);
    profile = edit.profile;
    // Not applied outright: the boundary's text is unchanged, v1 still in force.
    expect(profile.boundaries[0]!.text).toBe(originalText);
    expect(profile.approval).toEqual({ version: 1, at: NOW });
    const revision = profile.revisions.find((r) => r.status === "proposed");
    expect(revision).toBeDefined();

    const accept = reduce(profile, { type: "acceptRevision", revisionId: revision!.id, now: LATER, newId });
    expect(accept.ok).toBe(true);
    profile = accept.profile;
    expect(profile.boundaries[0]!.text).toBe("Do not invent metrics, credentials, responsibilities, or scope.");
    expect(profile.approval).toEqual({ version: 2, at: LATER });
  });

  it("editing a boundary before approval applies directly — no revision needed", () => {
    const newId = idGen("id");
    const profile = createInitialProfile(newId);
    const boundaryId = profile.boundaries[0]!.id;

    const edit = reduce(profile, { type: "editStatementText", kind: "boundary", statementId: boundaryId, text: "Never invent a metric.", now: NOW, newId });
    expect(edit.ok).toBe(true);
    expect(edit.profile.boundaries[0]!.text).toBe("Never invent a metric.");
    expect(edit.profile.revisions).toHaveLength(0);
  });
});
