import type { Claim, ClaimKind, SourceStatus } from "@workflow-catalog/contracts";
import { draftQuestion, needsQuestion } from "./profile-questions.ts";
import {
  isSourcesComplete,
  SOURCE_CATEGORY_LABELS,
  unaccountedCategories,
  type OnboardingProfile,
  type SourceCategory,
  type StatementKind,
} from "./profile-types.ts";

/**
 * The pure state machine behind onboarding and the career profile: `(state,
 * action) => { profile, ok, message }`, no I/O and no model, mirroring
 * `docs/spec/visuals/index.html`'s `workflowInstance.reduce` (the behaviour
 * spec) but built on the real `@workflow-catalog/contracts` shapes instead
 * of the walkthrough's throwaway prototype fields. `profile.ts` wraps this
 * with persistence; `test/profile-reducer.test.ts` drives it directly to
 * reproduce the six walkthrough scenarios with no model, per the packet's
 * acceptance criteria.
 */

export interface ExtractedClaimInput {
  readonly text: string;
  readonly kind: ClaimKind;
  readonly evidenceRef: string;
  readonly evidenceQuote: string;
}

export type ClaimDecision = "confirmed" | "disputed" | "excluded";

export type Action =
  | { readonly type: "accountSource"; readonly category: SourceCategory; readonly status: SourceStatus; readonly note?: string }
  | {
      readonly type: "extractClaims";
      readonly category: SourceCategory;
      readonly extracted: readonly ExtractedClaimInput[];
      readonly now: string;
      readonly newId: () => string;
    }
  | {
      readonly type: "decideClaim";
      readonly claimId: string;
      readonly decision: ClaimDecision;
      readonly now: string;
      readonly newId: () => string;
      readonly question?: string;
    }
  | {
      readonly type: "answerQuestion";
      readonly claimId: string;
      readonly hasEvidence: boolean;
      readonly statement?: string;
      readonly now: string;
      readonly newId: () => string;
    }
  | { readonly type: "approve"; readonly now: string }
  | { readonly type: "editClaimText"; readonly claimId: string; readonly text: string; readonly now: string; readonly newId: () => string }
  | {
      readonly type: "editStatementText";
      readonly kind: StatementKind;
      readonly statementId: string;
      readonly text: string;
      readonly now: string;
      readonly newId: () => string;
    }
  | { readonly type: "acceptRevision"; readonly revisionId: string; readonly now: string }
  | { readonly type: "rejectRevision"; readonly revisionId: string; readonly now: string };

export interface ReduceResult {
  readonly profile: OnboardingProfile;
  readonly ok: boolean;
  readonly message: string;
}

export interface Readiness {
  readonly sourcesAccounted: boolean;
  readonly unaccounted: readonly SourceCategory[];
  readonly claimsSettled: boolean;
  readonly pendingClaims: readonly Claim[];
  readonly hasConfirmedClaims: boolean;
  readonly approved: boolean;
  /** Sources accounted, claims settled, at least one confirmed claim — everything the "approve" action itself requires. Does not include `approved`: that would make approving impossible (the one action that sets it could never pass its own gate). */
  readonly readyToApprove: boolean;
  /** `readyToApprove && approved` — generation is unlocked only here. */
  readonly ready: boolean;
  /** One exact string per currently-failing condition, fixed order: sources, claims, approval. Empty when ready. */
  readonly reasons: readonly string[];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "needs"/"need" agreeing with `plural`'s own singular/plural noun choice — `plural(1, "claim")` is "1 claim", which takes "needs", not "need". */
function pluralVerb(n: number, verb: string): string {
  return n === 1 ? `${verb}s` : verb;
}

/** First 8 characters of a UUID: readiness reasons are for a person to read, not to address a specific record by (`Readiness.pendingClaims` already carries the full `Claim`s for that). */
function shortId(id: string): string {
  return id.slice(0, 8);
}

export function readiness(profile: OnboardingProfile): Readiness {
  const unaccounted = unaccountedCategories(profile.sources);
  const pendingClaims = profile.claims.filter((claim) => claim.status === "candidate" || claim.status === "disputed");
  const hasConfirmedClaims = profile.claims.some((claim) => claim.status === "confirmed");
  const sourcesAccounted = unaccounted.length === 0;
  const claimsSettled = pendingClaims.length === 0;
  const approved = profile.approval !== null;

  const reasons: string[] = [];
  if (!sourcesAccounted) {
    reasons.push(
      `Not ready: ${plural(unaccounted.length, "source")} unaccounted for (${unaccounted.map((category) => SOURCE_CATEGORY_LABELS[category]).join(", ")}). Mark each provided, unavailable, or not applicable.`,
    );
  }
  if (!claimsSettled) {
    reasons.push(
      `Not ready: ${plural(pendingClaims.length, "claim")} still ${pluralVerb(pendingClaims.length, "need")} a decision (${pendingClaims.map((claim) => shortId(claim.id)).join(", ")}).`,
    );
  } else if (profile.claims.length === 0) {
    reasons.push("Not ready: no claims yet. Extract claims from a provided source first.");
  } else if (!hasConfirmedClaims) {
    reasons.push("Not ready: every claim was excluded. There is nothing to write from.");
  }

  const readyToApprove = sourcesAccounted && claimsSettled && hasConfirmedClaims && profile.claims.length > 0;

  // Listed last and never part of readyToApprove: "not approved yet" describes
  // the profile's current state, but it can never be why approve() itself
  // refuses — that would make approving permanently impossible.
  if (!approved) {
    reasons.push("Not ready: the career profile has not been approved yet.");
  }

  const ready = readyToApprove && approved;
  return { sourcesAccounted, unaccounted, claimsSettled, pendingClaims, hasConfirmedClaims, approved, readyToApprove, ready, reasons };
}

const CLAIM_EDIT_PREFIX = "claim-edit:";

/** `revisions[].summary` encoding for a proposed claim-text edit: the only kind of revision this reducer produces today. A future revision kind picks its own prefix. */
export function encodeClaimEditSummary(claimId: string, text: string): string {
  return `${CLAIM_EDIT_PREFIX}${claimId}\n${text}`;
}

export function decodeClaimEditSummary(summary: string): { readonly claimId: string; readonly text: string } | undefined {
  if (!summary.startsWith(CLAIM_EDIT_PREFIX)) return undefined;
  const rest = summary.slice(CLAIM_EDIT_PREFIX.length);
  const newline = rest.indexOf("\n");
  if (newline === -1) return undefined;
  const claimId = rest.slice(0, newline);
  const text = rest.slice(newline + 1);
  if (!claimId || !text) return undefined;
  return { claimId, text };
}

const STATEMENT_EDIT_PREFIX = "statement-edit:";

/** `revisions[].summary` encoding for a proposed boundary/preference/presentation edit — the statement-level counterpart of `encodeClaimEditSummary`, for the same reason (F5: an edit after approval proposes a revision instead of changing it outright). */
export function encodeStatementEditSummary(kind: StatementKind, statementId: string, text: string): string {
  return `${STATEMENT_EDIT_PREFIX}${kind}\n${statementId}\n${text}`;
}

export function decodeStatementEditSummary(summary: string): { readonly kind: StatementKind; readonly statementId: string; readonly text: string } | undefined {
  if (!summary.startsWith(STATEMENT_EDIT_PREFIX)) return undefined;
  const rest = summary.slice(STATEMENT_EDIT_PREFIX.length);
  const firstNewline = rest.indexOf("\n");
  if (firstNewline === -1) return undefined;
  const kind = rest.slice(0, firstNewline);
  if (kind !== "boundary" && kind !== "preference" && kind !== "presentation") return undefined;
  const rest2 = rest.slice(firstNewline + 1);
  const secondNewline = rest2.indexOf("\n");
  if (secondNewline === -1) return undefined;
  const statementId = rest2.slice(0, secondNewline);
  const text = rest2.slice(secondNewline + 1);
  if (!statementId || !text) return undefined;
  return { kind, statementId, text };
}

const WITHDRAWAL_PREFIX = "withdrawal:";

/**
 * `revisions[].summary` encoding for an approval-withdrawal marker: not a
 * proposed edit, but a record that `version` was once issued and must never
 * be handed out again (R1: version numbers are never reused, even across a
 * withdraw/re-approve cycle). `status: "accepted"` and `resultingVersion`
 * are reused fields — not semantically "a revision was accepted" — purely
 * so `highestVersionUsed` (which scans exactly those two things) sees it;
 * the `withdrawal:` prefix is what actually distinguishes it from a real
 * accepted claim/statement-edit revision. `careerProfileRevisionSchema`
 * (`@workflow-catalog/contracts`) is a closed enum with no "withdrawn"
 * status, and P03 does not touch contracts, so this reuses what the schema
 * already allows rather than adding a new status value.
 */
function encodeWithdrawalSummary(version: number, reason: string): string {
  return `${WITHDRAWAL_PREFIX}${version}\n${reason}`;
}

export function decodeWithdrawalSummary(summary: string): { readonly version: number; readonly reason: string } | undefined {
  if (!summary.startsWith(WITHDRAWAL_PREFIX)) return undefined;
  const rest = summary.slice(WITHDRAWAL_PREFIX.length);
  const newline = rest.indexOf("\n");
  if (newline === -1) return undefined;
  const version = Number(rest.slice(0, newline));
  const reason = rest.slice(newline + 1);
  if (!Number.isInteger(version) || version <= 0 || !reason) return undefined;
  return { version, reason };
}

/** The highest profile version ever issued: the current approval (if any) and every `revisions[].resultingVersion` recorded so far — accepted claim/statement edits and withdrawal markers alike. `approve`/`acceptRevision` both bump from this, never from `profile.approval?.version` alone, so a version is never reissued after a withdrawal (R1). */
function highestVersionUsed(profile: OnboardingProfile): number {
  let max = profile.approval?.version ?? 0;
  for (const revision of profile.revisions) {
    if (revision.resultingVersion !== undefined && revision.resultingVersion > max) max = revision.resultingVersion;
  }
  return max;
}

/** Withdraws approval, if any (a no-op otherwise), recording a withdrawal marker so the retired version is never reused. The walkthrough withdraws on any claim change that isn't an exclusion (R2); `decideClaim`'s "disputed" and "confirmed" branches and `answerQuestion`'s evidence branch all call this. */
function withdrawApproval(profile: OnboardingProfile, now: string, newId: () => string, reason: string): OnboardingProfile {
  if (profile.approval === null) return profile;
  const marker = {
    id: newId(),
    summary: encodeWithdrawalSummary(profile.approval.version, reason),
    proposedAt: now,
    status: "accepted" as const,
    resultingVersion: profile.approval.version,
    decidedAt: now,
  };
  return { ...profile, approval: null, revisions: [...profile.revisions, marker] };
}

function ok(profile: OnboardingProfile, message: string): ReduceResult {
  return { profile, ok: true, message };
}

function refuse(profile: OnboardingProfile, message: string): ReduceResult {
  return { profile, ok: false, message };
}

function findClaim(profile: OnboardingProfile, claimId: string): Claim | undefined {
  return profile.claims.find((claim) => claim.id === claimId);
}

function replaceClaim(profile: OnboardingProfile, claimId: string, update: (claim: Claim) => Claim): OnboardingProfile {
  return { ...profile, claims: profile.claims.map((claim) => (claim.id === claimId ? update(claim) : claim)) };
}

export function reduce(profile: OnboardingProfile, action: Action): ReduceResult {
  switch (action.type) {
    case "accountSource": {
      const entry = action.note !== undefined ? { status: action.status, note: action.note } : { status: action.status };
      const next: OnboardingProfile = { ...profile, sources: { ...profile.sources, [action.category]: entry } };
      return ok(
        next,
        action.status === "provided"
          ? `${action.category} marked provided. Extract claims from it when ready.`
          : `${action.category} marked ${action.status.replace("_", " ")}. That still counts as accounted for; nothing is invented to fill the gap.`,
      );
    }

    case "extractClaims": {
      if (profile.sources[action.category]?.status !== "provided") {
        return refuse(profile, `Nothing to extract: ${action.category} is not marked provided.`);
      }
      const existingKeys = new Set(profile.claims.map((claim) => `${claim.source}\u0000${claim.evidence.ref}\u0000${claim.evidence.quote}`));
      const added: Claim[] = [];
      for (const item of action.extracted) {
        const key = `${action.category}\u0000${item.evidenceRef}\u0000${item.evidenceQuote}`;
        if (existingKeys.has(key)) continue; // idempotent per (source, evidence): re-extracting the same content adds nothing new.
        existingKeys.add(key);
        const draftClaim = { text: item.text, kind: item.kind };
        const claim: Claim = {
          id: action.newId(),
          text: item.text,
          kind: item.kind,
          status: "candidate",
          source: action.category,
          evidence: { kind: "passage", ref: item.evidenceRef, quote: item.evidenceQuote },
          // follow-up-questions/SKILL.md's mechanical rule, applied at extraction time rather than
          // waiting for a confirm attempt: a metric/title/date/always-ask-word claim surfaces its
          // question immediately, still `status: "candidate"` — claim-extraction/SKILL.md's own
          // contract ("extraction never confirms, disputes, or excludes") only constrains `status`.
          ...(needsQuestion(draftClaim) ? { question: draftQuestion(draftClaim) } : {}),
        };
        added.push(claim);
      }
      const next: OnboardingProfile = { ...profile, claims: [...profile.claims, ...added] };
      return ok(
        next,
        added.length > 0
          ? `${plural(added.length, "candidate claim")} extracted from ${action.category}. Each stays a candidate until confirmed, disputed, or excluded.`
          : `Extraction from ${action.category} is idempotent: no new claims, nothing duplicated.`,
      );
    }

    case "decideClaim": {
      const claim = findClaim(profile, action.claimId);
      if (!claim) return refuse(profile, `No claim ${action.claimId} yet — extract first.`);

      if (action.decision === "confirmed" && needsQuestion(claim) && claim.answeredAt === undefined) {
        const question = action.question ?? claim.question ?? draftQuestion(claim);
        const next = replaceClaim(profile, claim.id, (c) => ({ ...c, status: "disputed", question }));
        return ok(next, `${claim.id} is a ${claim.kind} claim. Before it can be confirmed: "${question}"`);
      }

      if (action.decision === "disputed") {
        const question = action.question ?? claim.question ?? draftQuestion(claim);
        let next = replaceClaim(profile, claim.id, (c) => ({ ...c, status: "disputed", question }));
        let message = `${claim.id} needs a decision: "${question}"`;
        if (next.approval !== null) {
          next = withdrawApproval(next, action.now, action.newId, `${claim.id} disputed`);
          message += " Profile approval withdrawn (a claim changed).";
        }
        return ok(next, message);
      }

      const nextClaim: Claim =
        action.decision === "excluded"
          ? { ...claim, status: "excluded" }
          : { ...claim, status: "confirmed" };
      let next = replaceClaim(profile, claim.id, () => nextClaim);
      let message = action.decision === "excluded" ? `${claim.id} excluded. It never appears in a generated document.` : `${claim.id} confirmed.`;
      if (next.approval !== null && action.decision !== "excluded") {
        next = withdrawApproval(next, action.now, action.newId, `${claim.id} changed`);
        message += " Profile approval withdrawn (a claim changed).";
      }
      return ok(next, message);
    }

    case "answerQuestion": {
      const claim = findClaim(profile, action.claimId);
      if (!claim || claim.status !== "disputed") return refuse(profile, "There is no open question to answer.");

      if (action.hasEvidence) {
        const statement = (action.statement ?? "").trim() || "Confirmed by the person, without further detail.";
        const supersededSummary = `answer-evidence:${claim.id}\nsuperseded ${claim.evidence.kind} evidence "${claim.evidence.quote}" (${claim.evidence.ref}) with the person's statement`;
        const versionAtDecision = profile.approval?.version;
        let next = replaceClaim(profile, claim.id, (c) => ({
          ...c,
          status: "confirmed",
          answeredAt: action.now,
          evidence: { kind: "statement", ref: `claim:${claim.id}#answer`, quote: statement },
        }));
        let message = `${claim.id} confirmed; the evidence is recorded as your own statement, not as an external fact.`;
        if (next.approval !== null) {
          next = withdrawApproval(next, action.now, action.newId, `${claim.id} changed`);
          message += " Profile approval withdrawn (a claim changed).";
        }
        return ok(
          {
            ...next,
            revisions: [...next.revisions, { id: action.newId(), summary: supersededSummary, proposedAt: action.now, status: "accepted", resultingVersion: versionAtDecision, decidedAt: action.now }],
          },
          message,
        );
      }

      const next = replaceClaim(profile, claim.id, (c) => ({ ...c, status: "excluded", answeredAt: action.now }));
      return ok(next, `${claim.id} excluded (no evidence). It will not appear in a generated document.`);
    }

    case "approve": {
      const r = readiness(profile);
      if (!r.readyToApprove) {
        const blocking = r.reasons.find((reason) => !reason.includes("has not been approved yet"));
        return refuse(profile, blocking ?? "Not ready.");
      }
      const version = highestVersionUsed(profile) + 1;
      const next: OnboardingProfile = { ...profile, approval: { version, at: action.now } };
      return ok(next, `Career profile v${version} approved. Generation is now unlocked.`);
    }

    case "editClaimText": {
      const claim = findClaim(profile, action.claimId);
      if (!claim || claim.status !== "confirmed") return refuse(profile, "Only a confirmed claim can be edited.");

      if (profile.approval === null) {
        const next = replaceClaim(profile, claim.id, (c) => ({ ...c, text: action.text }));
        return ok(next, `${claim.id} edited. The profile is not approved yet, so no revision is needed.`);
      }

      const revision = {
        id: action.newId(),
        summary: encodeClaimEditSummary(claim.id, action.text),
        proposedAt: action.now,
        status: "proposed" as const,
      };
      const next: OnboardingProfile = { ...profile, revisions: [...profile.revisions, revision] };
      return ok(next, `A revision to ${claim.id} is proposed. Profile v${profile.approval.version} stays in force until the revision is accepted.`);
    }

    case "editStatementText": {
      const field = action.kind === "boundary" ? "boundaries" : action.kind === "preference" ? "preferences" : "presentation";
      const list = profile[field];
      const statement = list.find((s) => s.id === action.statementId);
      if (!statement) return refuse(profile, `No ${action.kind} ${action.statementId} to edit.`);

      if (profile.approval === null) {
        const next: OnboardingProfile = { ...profile, [field]: list.map((s) => (s.id === statement.id ? { ...s, text: action.text } : s)) };
        return ok(next, `${statement.id} edited. The profile is not approved yet, so no revision is needed.`);
      }

      const revision = {
        id: action.newId(),
        summary: encodeStatementEditSummary(action.kind, statement.id, action.text),
        proposedAt: action.now,
        status: "proposed" as const,
      };
      const next: OnboardingProfile = { ...profile, revisions: [...profile.revisions, revision] };
      return ok(next, `A revision to this ${action.kind} is proposed. Profile v${profile.approval.version} stays in force until the revision is accepted.`);
    }

    case "acceptRevision": {
      if (profile.approval === null) return refuse(profile, "The career profile is not approved; there is nothing to accept a revision against.");
      const revision = profile.revisions.find((rev) => rev.id === action.revisionId && rev.status === "proposed");
      if (!revision) return refuse(profile, "No matching proposed revision.");

      const claimEdit = decodeClaimEditSummary(revision.summary);
      const statementEdit = claimEdit ? undefined : decodeStatementEditSummary(revision.summary);
      if (!claimEdit && !statementEdit) return refuse(profile, "This revision cannot be applied automatically.");

      let next: OnboardingProfile;
      if (claimEdit) {
        const claim = findClaim(profile, claimEdit.claimId);
        if (!claim) return refuse(profile, `Revision refers to a claim that no longer exists: ${claimEdit.claimId}.`);
        next = replaceClaim(profile, claim.id, (c) => ({ ...c, text: claimEdit.text }));
      } else {
        const edit = statementEdit!;
        const field = edit.kind === "boundary" ? "boundaries" : edit.kind === "preference" ? "preferences" : "presentation";
        const list = profile[field];
        if (!list.some((s) => s.id === edit.statementId)) {
          return refuse(profile, `Revision refers to a ${edit.kind} that no longer exists: ${edit.statementId}.`);
        }
        next = { ...profile, [field]: list.map((s) => (s.id === edit.statementId ? { ...s, text: edit.text } : s)) };
      }

      const version = highestVersionUsed(profile) + 1;
      next = {
        ...next,
        approval: { version, at: action.now },
        revisions: next.revisions.map((rev) => (rev.id === revision.id ? { ...rev, status: "accepted", resultingVersion: version, decidedAt: action.now } : rev)),
      };
      return ok(next, `Profile is now v${version}. Documents prepared from the previous version keep saying which version they used.`);
    }

    case "rejectRevision": {
      const revision = profile.revisions.find((rev) => rev.id === action.revisionId && rev.status === "proposed");
      if (!revision) return refuse(profile, "No matching proposed revision.");
      const next: OnboardingProfile = {
        ...profile,
        revisions: profile.revisions.map((rev) => (rev.id === revision.id ? { ...rev, status: "rejected", decidedAt: action.now } : rev)),
      };
      return ok(next, "Revision rejected. The claim keeps its current text.");
    }

    default: {
      const _exhaustive: never = action;
      return refuse(profile, `Unknown action: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export { isSourcesComplete };
