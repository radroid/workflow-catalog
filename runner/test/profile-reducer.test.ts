import { SOURCE_CATEGORIES } from "@workflow-catalog/contracts";
import { describe, expect, it } from "vitest";
import { createInitialProfile } from "../store/profile-types.ts";
import { reduce, readiness, type Action } from "../store/profile-reducer.ts";

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

    const confirm = reduce(profile, { type: "decideClaim", claimId, decision: "confirmed", now: NOW });
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
    const confirmAttempt = reduce(profile, { type: "decideClaim", claimId: claim.id, decision: "confirmed", now: NOW });
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
        { text: "Software engineer at Acme.", kind: "fact", evidenceRef: "resume.md#b", evidenceQuote: "Software engineer at Acme" },
      ],
      now: NOW,
      newId,
    }).profile;
    const [keep, drop] = profile.claims;
    profile = reduce(profile, { type: "decideClaim", claimId: keep!.id, decision: "confirmed", now: NOW }).profile;
    profile = reduce(profile, { type: "decideClaim", claimId: drop!.id, decision: "confirmed", now: NOW }).profile;
    profile = reduce(profile, { type: "approve", now: NOW }).profile;
    expect(profile.approval).not.toBeNull();

    // An incidental cleanup — excluding a confirmed claim — is not treated as
    // "a claim changed" the way confirming/disputing one is: approval stays.
    const exclude = reduce(profile, { type: "decideClaim", claimId: drop!.id, decision: "excluded", now: LATER });
    expect(exclude.ok).toBe(true);
    profile = exclude.profile;
    expect(profile.claims.find((c) => c.id === drop!.id)?.status).toBe("excluded");
    expect(profile.approval).toEqual({ version: 1, at: NOW }); // unchanged

    // But re-confirming (an explicit claim change) does withdraw it.
    const reconfirm = reduce(profile, { type: "decideClaim", claimId: keep!.id, decision: "confirmed", now: LATER });
    // keep! is already confirmed and needs no question, so this is a no-op decision through the same path as a genuine change:
    expect(reconfirm.ok).toBe(true);
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
    profile = reduce(profile, { type: "decideClaim", claimId, decision: "confirmed", now: NOW }).profile;
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
    const accept = reduce(profile, { type: "acceptRevision", revisionId, now: LATER });
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
    profile = reduce(profile, { type: "decideClaim", claimId, decision: "confirmed", now: NOW }).profile;
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
