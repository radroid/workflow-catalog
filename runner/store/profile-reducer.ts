import type { Claim, ClaimEvidence, ClaimKind, SourceStatus } from "@workflow-catalog/contracts";
import { draftQuestion, editAddsAlwaysAskItem, needsQuestion } from "./profile-questions.ts";
import {
  isSourcesComplete,
  SOURCE_CATEGORY_LABELS,
  statementField,
  unaccountedCategories,
  type CareerProfileRevision,
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
 *
 * Messages are for a person to read (P03 revision 2, UI critic issue 2): a
 * claim is named by its own words, a source by its label, and never by an id
 * or an internal key.
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
  | { readonly type: "recordQuestionNote"; readonly claimId: string; readonly note: string; readonly now: string; readonly newId: () => string }
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
  | { readonly type: "addStatement"; readonly kind: StatementKind; readonly text: string; readonly now: string; readonly newId: () => string }
  | { readonly type: "acceptRevision"; readonly revisionId: string; readonly now: string; readonly newId: () => string }
  | { readonly type: "rejectRevision"; readonly revisionId: string; readonly now: string };

export interface ReduceResult {
  readonly profile: OnboardingProfile;
  readonly ok: boolean;
  readonly message: string;
}

export interface Readiness {
  readonly sourcesAccounted: boolean;
  readonly unaccounted: readonly SourceCategory[];
  /** At least one claim, and none still candidate or disputed (the walkthrough's rule: with no claims yet, nothing has been decided). */
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

/**
 * A claim named by its own words for a person to read, on one line and cut
 * short: “Cut report processing time by 30%”. Messages, readiness reasons and
 * career-profile.md's notes use this instead of the claim's id.
 */
export function quoteClaim(text: string, max = 60): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return `“${oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine}”`;
}

/**
 * Text as the profile stores it: line endings normalised, no whitespace at
 * the end of a line, no blank lines, trimmed. career-profile.md renders a
 * multi-line text as indented continuation lines, and a blank or
 * space-ended line cannot survive a person's editor, so text is kept in the
 * one shape that round-trips (D5, D9).
 */
export function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .filter((line) => line.trim().length > 0)
    .join("\n")
    .trim();
}

const STATEMENT_LABELS: Record<StatementKind, string> = { boundary: "boundary", preference: "preference", presentation: "presentation note" };

export function statementLabel(kind: StatementKind): string {
  return STATEMENT_LABELS[kind];
}

function pendingClaimsReason(pendingClaims: readonly Claim[]): string {
  const named = pendingClaims.slice(0, 3).map((claim) => quoteClaim(claim.text, 40));
  const more = pendingClaims.length > 3 ? `, and ${pendingClaims.length - 3} more` : "";
  return `Not ready: ${plural(pendingClaims.length, "claim")} still ${pluralVerb(pendingClaims.length, "need")} a decision (${named.join(", ")}${more}).`;
}

export function readiness(profile: OnboardingProfile): Readiness {
  const unaccounted = unaccountedCategories(profile.sources);
  const pendingClaims = profile.claims.filter((claim) => claim.status === "candidate" || claim.status === "disputed");
  const hasConfirmedClaims = profile.claims.some((claim) => claim.status === "confirmed");
  const sourcesAccounted = unaccounted.length === 0;
  const claimsSettled = profile.claims.length > 0 && pendingClaims.length === 0;
  const approved = profile.approval !== null;

  const reasons: string[] = [];
  if (!sourcesAccounted) {
    reasons.push(
      `Not ready: ${plural(unaccounted.length, "source")} unaccounted for (${unaccounted.map((category) => SOURCE_CATEGORY_LABELS[category]).join(", ")}). Mark each provided, unavailable, or not applicable.`,
    );
  }
  if (pendingClaims.length > 0) {
    reasons.push(pendingClaimsReason(pendingClaims));
  } else if (profile.claims.length === 0) {
    reasons.push("Not ready: no claims yet. Extract claims from a provided source first.");
  } else if (!hasConfirmedClaims) {
    reasons.push("Not ready: every claim was excluded. There is nothing to write from.");
  }

  const readyToApprove = sourcesAccounted && claimsSettled && hasConfirmedClaims;

  // Listed last and never part of readyToApprove: "not approved yet" describes
  // the profile's current state, but it can never be why approve() itself
  // refuses — that would make approving permanently impossible.
  if (!approved) {
    reasons.push("Not ready: the career profile has not been approved yet.");
  }

  const ready = readyToApprove && approved;
  return { sourcesAccounted, unaccounted, claimsSettled, pendingClaims, hasConfirmedClaims, approved, readyToApprove, ready, reasons };
}

// ---------------------------------------------------------------------------
// revisions[] summary encodings. `careerProfileRevisionSchema` (contracts,
// closed to P03) has only id/summary/proposedAt/status/resultingVersion/
// decidedAt, so each kind of record P03 keeps there is told apart by a prefix
// on `summary` (VN9: accepted as is, logged as a contracts follow-up).
// ---------------------------------------------------------------------------

const CLAIM_EDIT_PREFIX = "claim-edit:";

/** `revisions[].summary` encoding for a proposed claim-text edit. */
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

/** `revisions[].summary` encoding for a proposed boundary/preference/presentation edit — the statement-level counterpart of `encodeClaimEditSummary` (F5: an edit after approval proposes a revision instead of changing it outright). */
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

/** Why approval was withdrawn: which claim or statement changed, and how. */
export type WithdrawalCause =
  | { readonly kind: "claim"; readonly claimId: string; readonly change: "disputed" | "confirmed" | "answered" | "reopened" }
  | { readonly kind: "statement"; readonly statementKind: StatementKind; readonly statementId: string; readonly change: "added" };

const WITHDRAWAL_PREFIX = "withdrawal:";
const APPLIED_PREFIX = "applied:";
const CLAIM_CHANGES = new Set(["disputed", "confirmed", "answered", "reopened"]);

/**
 * `revisions[].summary` encoding for an approval-withdrawal marker: a record
 * that `version` was issued and must never be handed out again (R1), what
 * changed (the cause line), and which pending revisions were applied to the
 * draft when it happened (D11, the `applied:` line). `status: "accepted"`
 * and `resultingVersion` are reused fields so `highestVersionUsed` sees the
 * version; the `withdrawal:` prefix is what tells it apart.
 *
 *     withdrawal:<version>
 *     claim:<claimId>:<disputed|confirmed|answered|reopened>   or   statement:<kind>:<statementId>:added
 *     applied:<revisionId>,<revisionId>                          (only when some were applied)
 */
function encodeWithdrawalSummary(version: number, cause: WithdrawalCause, applied: readonly string[]): string {
  const causeLine = cause.kind === "claim" ? `claim:${cause.claimId}:${cause.change}` : `statement:${cause.statementKind}:${cause.statementId}:${cause.change}`;
  return [`${WITHDRAWAL_PREFIX}${version}`, causeLine, ...(applied.length > 0 ? [`${APPLIED_PREFIX}${applied.join(",")}`] : [])].join("\n");
}

function decodeCause(line: string): WithdrawalCause | undefined {
  const parts = line.split(":");
  if (parts[0] === "claim" && parts.length === 3 && parts[1] && CLAIM_CHANGES.has(parts[2]!)) {
    return { kind: "claim", claimId: parts[1], change: parts[2] as "disputed" | "confirmed" | "answered" | "reopened" };
  }
  if (parts[0] === "statement" && parts.length === 4 && parts[3] === "added" && parts[2]) {
    const statementKind = parts[1];
    if (statementKind === "boundary" || statementKind === "preference" || statementKind === "presentation") {
      return { kind: "statement", statementKind, statementId: parts[2], change: "added" };
    }
  }
  return undefined;
}

export function decodeWithdrawalSummary(
  summary: string,
): { readonly version: number; readonly cause: WithdrawalCause | undefined; readonly applied: readonly string[] } | undefined {
  if (!summary.startsWith(WITHDRAWAL_PREFIX)) return undefined;
  const lines = summary.slice(WITHDRAWAL_PREFIX.length).split("\n");
  const version = Number(lines[0]);
  if (!Number.isInteger(version) || version <= 0 || lines.length < 2 || !lines[1]) return undefined;
  const appliedLine = lines.find((line) => line.startsWith(APPLIED_PREFIX));
  const applied = appliedLine ? appliedLine.slice(APPLIED_PREFIX.length).split(",").filter(Boolean) : [];
  return { version, cause: decodeCause(lines[1]), applied };
}

const QUESTION_NOTE_PREFIX = "question-note:";

/** D10: the person's reply to a follow-up question that chose neither Confirm nor Exclude, kept as a note on the question. */
function encodeQuestionNote(claimId: string, note: string): string {
  return `${QUESTION_NOTE_PREFIX}${claimId}\n${note}`;
}

export function decodeQuestionNote(summary: string): { readonly claimId: string; readonly note: string } | undefined {
  if (!summary.startsWith(QUESTION_NOTE_PREFIX)) return undefined;
  const rest = summary.slice(QUESTION_NOTE_PREFIX.length);
  const newline = rest.indexOf("\n");
  if (newline <= 0) return undefined;
  const note = rest.slice(newline + 1);
  return note ? { claimId: rest.slice(0, newline), note } : undefined;
}

const ANSWER_EVIDENCE_PREFIX = "answer-evidence:";

/** The superseded evidence kept when an answer replaces it (spec §5: "the superseded passage stays in revisions[]"), with its ref as well as its quote. */
function encodeSupersededEvidence(claimId: string, evidence: ClaimEvidence): string {
  return `${ANSWER_EVIDENCE_PREFIX}${claimId}\nsuperseded ${evidence.kind} evidence "${evidence.quote}" (${evidence.ref}) with the person's statement`;
}

/** The statement recorded when the person confirms a claim's question without typing any detail. The evidence's ref ends in this suffix so both pages and career-profile.md can say so plainly. */
export const NO_DETAIL_STATEMENT = "Confirmed without adding detail.";
export const NO_DETAIL_REF_SUFFIX = "#answer-without-detail";

export function isNoDetailStatement(evidence: ClaimEvidence): boolean {
  return evidence.kind === "statement" && evidence.ref.endsWith(NO_DETAIL_REF_SUFFIX);
}

/** The highest profile version ever issued: the current approval (if any) and every `revisions[].resultingVersion` recorded so far — accepted claim/statement edits and withdrawal markers alike. `approve`/`acceptRevision` both bump from this, never from `profile.approval?.version` alone, so a version is never reissued after a withdrawal (R1). */
function highestVersionUsed(profile: OnboardingProfile): number {
  let max = profile.approval?.version ?? 0;
  for (const revision of profile.revisions) {
    if (revision.resultingVersion !== undefined && revision.resultingVersion > max) max = revision.resultingVersion;
  }
  return max;
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

function markRevision(profile: OnboardingProfile, revisionId: string, status: "accepted" | "rejected", now: string, resultingVersion?: number): OnboardingProfile {
  return {
    ...profile,
    revisions: profile.revisions.map((rev) => {
      if (rev.id !== revisionId) return rev;
      const decided: CareerProfileRevision = { ...rev, status, decidedAt: now };
      return resultingVersion === undefined ? decided : { ...decided, resultingVersion };
    }),
  };
}

/**
 * Sets a claim's text. D15 (P03 revision 2): a confirmed claim whose edit
 * adds an always-ask item (`editAddsAlwaysAskItem`) goes back to disputed
 * with a fresh question, so it cannot stay confirmed on evidence for other
 * words. An open claim whose question was the mechanical draft for its old
 * text gets the draft for the new text; one that now needs a question and has
 * none gets one.
 */
function setClaimText(profile: OnboardingProfile, claim: Claim, rawText: string): { readonly profile: OnboardingProfile; readonly reopened: boolean } {
  const text = cleanText(rawText);
  if (claim.status === "confirmed" && editAddsAlwaysAskItem(claim.kind, claim.text, text)) {
    // Built field by field so the old `answeredAt` is dropped: the new words haven't been answered for.
    const reopened: Claim = { id: claim.id, text, kind: claim.kind, status: "disputed", source: claim.source, evidence: claim.evidence, question: draftQuestion({ kind: claim.kind, text }) };
    return { profile: replaceClaim(profile, claim.id, () => reopened), reopened: true };
  }
  if (claim.status === "candidate" || claim.status === "disputed") {
    const mechanical = claim.question !== undefined && claim.question === draftQuestion(claim);
    const wantsQuestion = claim.question === undefined && needsQuestion({ kind: claim.kind, text });
    if (mechanical || wantsQuestion) {
      return { profile: replaceClaim(profile, claim.id, (c) => ({ ...c, text, question: draftQuestion({ kind: c.kind, text }) })), reopened: false };
    }
  }
  return { profile: replaceClaim(profile, claim.id, (c) => ({ ...c, text })), reopened: false };
}

/** Applies one proposed revision's content to the profile. Undefined when its claim or statement no longer exists. */
function applyRevisionContent(profile: OnboardingProfile, revision: CareerProfileRevision): { readonly profile: OnboardingProfile; readonly reopened: boolean } | undefined {
  const claimEdit = decodeClaimEditSummary(revision.summary);
  if (claimEdit) {
    const claim = findClaim(profile, claimEdit.claimId);
    return claim ? setClaimText(profile, claim, claimEdit.text) : undefined;
  }
  const statementEdit = decodeStatementEditSummary(revision.summary);
  if (statementEdit) {
    const field = statementField(statementEdit.kind);
    if (!profile[field].some((s) => s.id === statementEdit.statementId)) return undefined;
    const text = cleanText(statementEdit.text);
    return { profile: { ...profile, [field]: profile[field].map((s) => (s.id === statementEdit.statementId ? { ...s, text } : s)) }, reopened: false };
  }
  return undefined;
}

/**
 * Withdraws approval, if any (a no-op otherwise). The walkthrough withdraws
 * on any claim change that isn't an exclusion (R2).
 *
 * D11 (P03 revision 2): nothing is in force while the profile is unapproved,
 * so its pending revisions no longer have anything to protect. They are
 * applied to the draft and recorded as accepted, with this withdrawal as the
 * reason (its marker lists them), instead of being dropped — the
 * walkthrough's end state (no pending revision after a withdrawal) without
 * losing the person's edit. A revision whose claim or statement is gone is
 * recorded as rejected. The marker also records the retired version, so it is
 * never handed out again (R1).
 */
function withdrawApproval(profile: OnboardingProfile, now: string, newId: () => string, cause: WithdrawalCause): OnboardingProfile {
  if (profile.approval === null) return profile;
  let next = profile;
  const applied: string[] = [];
  for (const revision of profile.revisions.filter((rev) => rev.status === "proposed")) {
    const result = applyRevisionContent(next, revision);
    if (result) {
      next = markRevision(result.profile, revision.id, "accepted", now);
      applied.push(revision.id);
    } else {
      next = markRevision(next, revision.id, "rejected", now);
    }
  }
  const marker: CareerProfileRevision = {
    id: newId(),
    summary: encodeWithdrawalSummary(profile.approval.version, cause, applied),
    proposedAt: now,
    status: "accepted",
    resultingVersion: profile.approval.version,
    decidedAt: now,
  };
  return { ...next, approval: null, revisions: [...next.revisions, marker] };
}

/** The sentence a message ends with when an action withdrew approval of `version`. */
function withdrawnNote(version: number, next: OnboardingProfile): string {
  const pending = readiness(next).pendingClaims.length;
  return pending > 0
    ? ` Approval of version ${version} is withdrawn: answer the open question, then approve again.`
    : ` Approval of version ${version} is withdrawn: review the change, then approve again.`;
}

function sourceStatusLabel(status: SourceStatus): string {
  return status === "not_applicable" ? "not applicable" : status;
}

export function reduce(profile: OnboardingProfile, action: Action): ReduceResult {
  switch (action.type) {
    case "accountSource": {
      const note = action.note === undefined ? "" : cleanText(action.note);
      const entry = note ? { status: action.status, note } : { status: action.status };
      const next: OnboardingProfile = { ...profile, sources: { ...profile.sources, [action.category]: entry } };
      const label = SOURCE_CATEGORY_LABELS[action.category];
      if (action.status === "provided") return ok(next, `${label} marked provided. Paste or upload its text, then extract claims from it.`);
      return ok(
        next,
        `${label} marked ${sourceStatusLabel(action.status)}${note ? ", with your reason kept" : ""}. That still counts as accounted for; nothing is invented to fill the gap.`,
      );
    }

    case "extractClaims": {
      const label = SOURCE_CATEGORY_LABELS[action.category];
      if (profile.sources[action.category]?.status !== "provided") {
        return refuse(profile, `Nothing to extract: ${label} is not marked provided.`);
      }
      const existingKeys = new Set(profile.claims.map((claim) => `${claim.source}\u0000${claim.evidence.ref}\u0000${claim.evidence.quote}`));
      const added: Claim[] = [];
      for (const item of action.extracted) {
        const key = `${action.category}\u0000${item.evidenceRef}\u0000${item.evidenceQuote}`;
        if (existingKeys.has(key)) continue; // idempotent per (source, evidence): re-extracting the same content adds nothing new.
        existingKeys.add(key);
        const text = cleanText(item.text);
        const draftClaim = { text, kind: item.kind };
        const claim: Claim = {
          id: action.newId(),
          text,
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
          ? `${plural(added.length, "candidate claim")} extracted from ${label}. Each stays a candidate until you confirm, dispute, or exclude it.`
          : `Extraction from ${label} is idempotent: no new claims, nothing duplicated.`,
      );
    }

    case "decideClaim": {
      const claim = findClaim(profile, action.claimId);
      if (!claim) return refuse(profile, "That claim does not exist. Extract claims first.");
      const label = quoteClaim(claim.text);

      if (action.decision === "confirmed" && needsQuestion(claim) && claim.answeredAt === undefined) {
        const question = action.question ?? claim.question ?? draftQuestion(claim);
        const next = replaceClaim(profile, claim.id, (c) => ({ ...c, status: "disputed", question }));
        return ok(next, `${label} is a ${claim.kind} claim, so it needs your answer before it can be confirmed: ${question}`);
      }

      if (action.decision === "disputed") {
        const question = action.question ?? claim.question ?? draftQuestion(claim);
        let next = replaceClaim(profile, claim.id, (c) => ({ ...c, status: "disputed", question }));
        let message = `${label} now has an open question: ${question}`;
        if (next.approval !== null) {
          const version = next.approval.version;
          next = withdrawApproval(next, action.now, action.newId, { kind: "claim", claimId: claim.id, change: "disputed" });
          message += withdrawnNote(version, next);
        }
        return ok(next, message);
      }

      const nextClaim: Claim = action.decision === "excluded" ? { ...claim, status: "excluded" } : { ...claim, status: "confirmed" };
      let next = replaceClaim(profile, claim.id, () => nextClaim);
      let message = action.decision === "excluded" ? `${label} excluded. It never appears in a generated document.` : `${label} confirmed.`;
      if (next.approval !== null && action.decision !== "excluded") {
        const version = next.approval.version;
        next = withdrawApproval(next, action.now, action.newId, { kind: "claim", claimId: claim.id, change: "confirmed" });
        message += withdrawnNote(version, next);
      }
      return ok(next, message);
    }

    case "answerQuestion": {
      const claim = findClaim(profile, action.claimId);
      if (!claim || claim.status !== "disputed") return refuse(profile, "There is no open question to answer for that claim.");
      const label = quoteClaim(claim.text);

      if (action.hasEvidence) {
        const detail = cleanText(action.statement ?? "");
        const evidence: ClaimEvidence = detail
          ? { kind: "statement", ref: `claim:${claim.id}#answer`, quote: detail }
          : { kind: "statement", ref: `claim:${claim.id}${NO_DETAIL_REF_SUFFIX}`, quote: NO_DETAIL_STATEMENT };
        const versionAtDecision = profile.approval?.version;
        let next = replaceClaim(profile, claim.id, (c) => ({ ...c, status: "confirmed", answeredAt: action.now, evidence }));
        let message = detail
          ? `${label} confirmed. Your answer is recorded as your own statement, not as an external fact.`
          : `${label} confirmed. You confirmed it without adding detail.`;
        const superseded: CareerProfileRevision = {
          id: action.newId(),
          summary: encodeSupersededEvidence(claim.id, claim.evidence),
          proposedAt: action.now,
          status: "accepted",
          ...(versionAtDecision !== undefined ? { resultingVersion: versionAtDecision } : {}),
          decidedAt: action.now,
        };
        next = { ...next, revisions: [...next.revisions, superseded] };
        if (next.approval !== null) {
          const version = next.approval.version;
          next = withdrawApproval(next, action.now, action.newId, { kind: "claim", claimId: claim.id, change: "answered" });
          message += withdrawnNote(version, next);
        }
        return ok(next, message);
      }

      const next = replaceClaim(profile, claim.id, (c) => ({ ...c, status: "excluded", answeredAt: action.now }));
      return ok(next, `${label} excluded, because you have no evidence for it. It will not appear in a generated document.`);
    }

    case "recordQuestionNote": {
      const claim = findClaim(profile, action.claimId);
      if (!claim || claim.status !== "disputed" || claim.question === undefined) return refuse(profile, "There is no open question to add a note to.");
      const note = cleanText(action.note);
      if (!note) return refuse(profile, "The note is empty.");
      const record: CareerProfileRevision = {
        id: action.newId(),
        summary: encodeQuestionNote(claim.id, note),
        proposedAt: action.now,
        status: "accepted",
        decidedAt: action.now,
      };
      return ok(
        { ...profile, revisions: [...profile.revisions, record] },
        `Your note on ${quoteClaim(claim.text)} is saved. The question stays open until you confirm or exclude the claim.`,
      );
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
      if (!claim) return refuse(profile, "That claim does not exist.");
      const text = cleanText(action.text);
      if (!text) return refuse(profile, "A claim's text cannot be empty.");
      if (text === claim.text) return ok(profile, `${quoteClaim(claim.text)} is unchanged.`);

      if (claim.status === "confirmed" && profile.approval !== null) {
        const revision: CareerProfileRevision = {
          id: action.newId(),
          summary: encodeClaimEditSummary(claim.id, text),
          proposedAt: action.now,
          status: "proposed",
        };
        const next: OnboardingProfile = { ...profile, revisions: [...profile.revisions, revision] };
        return ok(next, `A revision to ${quoteClaim(claim.text)} is proposed. Version ${profile.approval.version} stays in force until you accept it on the Profile page.`);
      }

      const { profile: next, reopened } = setClaimText(profile, claim, text);
      if (reopened) {
        return ok(next, `${quoteClaim(text)} changed what it claims, so it needs your answer again before it can be confirmed.`);
      }
      return ok(next, claim.status === "confirmed" ? `${quoteClaim(text)} edited. The profile is not approved yet, so no revision is needed.` : `${quoteClaim(text)} edited.`);
    }

    case "editStatementText": {
      const field = statementField(action.kind);
      const list = profile[field];
      const statement = list.find((s) => s.id === action.statementId);
      const label = statementLabel(action.kind);
      if (!statement) return refuse(profile, `That ${label} does not exist.`);
      const text = cleanText(action.text);
      if (!text) return refuse(profile, `A ${label} cannot be empty.`);
      if (text === statement.text) return ok(profile, `The ${label} is unchanged.`);

      if (profile.approval === null) {
        const next: OnboardingProfile = { ...profile, [field]: list.map((s) => (s.id === statement.id ? { ...s, text } : s)) };
        return ok(next, `The ${label} was edited. The profile is not approved yet, so no revision is needed.`);
      }

      const revision: CareerProfileRevision = {
        id: action.newId(),
        summary: encodeStatementEditSummary(action.kind, statement.id, text),
        proposedAt: action.now,
        status: "proposed",
      };
      const next: OnboardingProfile = { ...profile, revisions: [...profile.revisions, revision] };
      return ok(next, `A revision to this ${label} is proposed. Version ${profile.approval.version} stays in force until you accept it on the Profile page.`);
    }

    case "addStatement": {
      // A brand-new boundary/preference/presentation note is in force as
      // soon as it exists (it has no candidate/confirm cycle the way a claim
      // does), so on an approved profile adding one is a content change:
      // approval is withdrawn (D3, revision 1), and D11 applies any pending
      // revisions to the draft.
      const field = statementField(action.kind);
      const label = statementLabel(action.kind);
      const text = cleanText(action.text);
      if (!text) return refuse(profile, `Type the ${label} first.`);
      const statement = { id: action.newId(), text };
      let next: OnboardingProfile = { ...profile, [field]: [...profile[field], statement] };
      let message = `Your ${label} is recorded.`;
      if (next.approval !== null) {
        const version = next.approval.version;
        next = withdrawApproval(next, action.now, action.newId, { kind: "statement", statementKind: action.kind, statementId: statement.id, change: "added" });
        message += withdrawnNote(version, next);
      }
      return ok(next, message);
    }

    case "acceptRevision": {
      if (profile.approval === null) return refuse(profile, "The profile is not approved, so there is no revision to accept. Approve it first.");
      const revision = profile.revisions.find((rev) => rev.id === action.revisionId && rev.status === "proposed");
      if (!revision) return refuse(profile, "That revision is no longer waiting for a decision.");

      const applied = applyRevisionContent(profile, revision);
      if (!applied) {
        return decodeClaimEditSummary(revision.summary) || decodeStatementEditSummary(revision.summary)
          ? refuse(profile, "That revision refers to something no longer in the profile. Reject it instead.")
          : refuse(profile, "This revision cannot be applied automatically.");
      }

      if (applied.reopened) {
        // D15: the accepted text needs a question answered before it can be
        // confirmed, so the profile cannot stay approved (D11 then applies
        // the other pending revisions to the draft).
        const claimEdit = decodeClaimEditSummary(revision.summary)!;
        const version = profile.approval.version;
        let next = markRevision(applied.profile, revision.id, "accepted", action.now);
        next = withdrawApproval(next, action.now, action.newId, { kind: "claim", claimId: claimEdit.claimId, change: "reopened" });
        return ok(
          next,
          `Accepted. ${quoteClaim(claimEdit.text)} now needs your answer to a question before it can be confirmed, so approval of version ${version} is withdrawn. Answer it on the Onboarding page, then approve again.`,
        );
      }

      const version = highestVersionUsed(profile) + 1;
      const next: OnboardingProfile = { ...markRevision(applied.profile, revision.id, "accepted", action.now, version), approval: { version, at: action.now } };
      return ok(next, `Profile is now v${version}. Documents prepared from the previous version keep saying which version they used.`);
    }

    case "rejectRevision": {
      const revision = profile.revisions.find((rev) => rev.id === action.revisionId && rev.status === "proposed");
      if (!revision) return refuse(profile, "That revision is no longer waiting for a decision.");
      const statementEdit = decodeStatementEditSummary(revision.summary);
      const target = statementEdit ? statementLabel(statementEdit.kind) : "claim";
      return ok(markRevision(profile, revision.id, "rejected", action.now), `Revision rejected. The ${target} keeps its current text.`);
    }

    default: {
      const _exhaustive: never = action;
      return refuse(profile, `Unknown action: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Views: what the pages and career-profile.md show, decoded from revisions[]
// in one place so neither page mirrors the summary encodings.
// ---------------------------------------------------------------------------

export interface PendingRevisionView {
  readonly id: string;
  readonly proposedAt: string;
  readonly target: "claim" | StatementKind;
  readonly targetId: string;
  /** The text in force now. */
  readonly before: string;
  /** The proposed text. */
  readonly after: string;
}

/** Proposed revisions whose claim or statement still exists, oldest first. */
export function pendingRevisions(profile: OnboardingProfile): PendingRevisionView[] {
  const views: PendingRevisionView[] = [];
  for (const revision of profile.revisions) {
    if (revision.status !== "proposed") continue;
    const claimEdit = decodeClaimEditSummary(revision.summary);
    if (claimEdit) {
      const claim = findClaim(profile, claimEdit.claimId);
      if (claim) views.push({ id: revision.id, proposedAt: revision.proposedAt, target: "claim", targetId: claim.id, before: claim.text, after: claimEdit.text });
      continue;
    }
    const statementEdit = decodeStatementEditSummary(revision.summary);
    if (statementEdit) {
      const statement = profile[statementField(statementEdit.kind)].find((s) => s.id === statementEdit.statementId);
      if (statement) views.push({ id: revision.id, proposedAt: revision.proposedAt, target: statementEdit.kind, targetId: statement.id, before: statement.text, after: statementEdit.text });
    }
  }
  return views;
}

export interface QuestionNoteView {
  readonly text: string;
  readonly at: string;
}

/** D10: the notes on each claim's open question, oldest first, keyed by claim id. Only claims whose question is still open are included. */
export function questionNotes(profile: OnboardingProfile): Record<string, QuestionNoteView[]> {
  const open = new Set(profile.claims.filter((claim) => claim.status === "disputed").map((claim) => claim.id));
  const notes: Record<string, QuestionNoteView[]> = {};
  for (const revision of profile.revisions) {
    const decoded = decodeQuestionNote(revision.summary);
    if (!decoded || !open.has(decoded.claimId)) continue;
    (notes[decoded.claimId] ??= []).push({ text: decoded.note, at: revision.proposedAt });
  }
  return notes;
}

export interface WithdrawalView {
  readonly version: number;
  readonly at: string;
  /** What changed, named for a person: the claim's text, or the statement's kind and text. Undefined for a marker written before revision 2. */
  readonly cause:
    | { readonly kind: "claim"; readonly change: "disputed" | "confirmed" | "answered" | "reopened"; readonly claimText: string }
    | { readonly kind: "statement"; readonly change: "added"; readonly statementKind: StatementKind; readonly statementText: string }
    | undefined;
  /** The pending revisions D11 applied to the draft when approval was withdrawn. */
  readonly applied: ReadonlyArray<{ readonly target: "claim" | StatementKind; readonly text: string }>;
}

/** The withdrawal the profile is currently in, if it is unapproved because approval was withdrawn (not merely never approved). */
export function currentWithdrawal(profile: OnboardingProfile): WithdrawalView | null {
  if (profile.approval !== null) return null;
  for (let i = profile.revisions.length - 1; i >= 0; i--) {
    const revision = profile.revisions[i]!;
    const decoded = decodeWithdrawalSummary(revision.summary);
    if (!decoded) continue;
    let cause: WithdrawalView["cause"];
    if (decoded.cause?.kind === "claim") {
      const claim = findClaim(profile, decoded.cause.claimId);
      cause = claim ? { kind: "claim", change: decoded.cause.change, claimText: claim.text } : undefined;
    } else if (decoded.cause?.kind === "statement") {
      const { statementKind, statementId } = decoded.cause;
      const statement = profile[statementField(statementKind)].find((s) => s.id === statementId);
      cause = statement ? { kind: "statement", change: "added", statementKind, statementText: statement.text } : undefined;
    }
    const applied = decoded.applied.flatMap((id): WithdrawalView["applied"][number][] => {
      const rev = profile.revisions.find((r) => r.id === id);
      if (!rev) return [];
      const claimEdit = decodeClaimEditSummary(rev.summary);
      if (claimEdit) return [{ target: "claim", text: claimEdit.text }];
      const statementEdit = decodeStatementEditSummary(rev.summary);
      return statementEdit ? [{ target: statementEdit.kind, text: statementEdit.text }] : [];
    });
    return { version: decoded.version, at: revision.proposedAt, cause, applied };
  }
  return null;
}

export { isSourcesComplete };
