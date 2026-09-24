import { randomUUID } from "node:crypto";
import path from "node:path";
import { uuidSchema, type Application, type ApplicationDocument, type JobSnapshot, type JobStructured, type RunKind, type RunRecord } from "@workflow-catalog/contracts";
import { z } from "zod";
import { postingText, requirementsDigest } from "../../agent/lib/prepare-logic.ts";
import { buildPreparationPrompt } from "../../agent/lib/prepare-prompt.ts";
import { actionsOutsidePreparation, preparationResult, type PrepareApplicationOutput } from "../../agent/lib/prepare-schema.ts";
import { presentationSummary, renderDiffMarkdown, statementDiffs, versionChanges, type SourceClaim, type StatementDiff } from "../../export/diff.ts";
import { coverLetterModel, letterDate, resumeModel, type PersonHeader } from "../../export/document.ts";
import { renderDocx } from "../../export/docx.ts";
import { renderMarkdown } from "../../export/markdown.ts";
import { renderPdf } from "../../export/pdf.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import {
  ApplicationsStore,
  GAP_ANSWERS,
  isDocumentFileName,
  personDetailsSchema,
  type GapAnswer,
  type PreparationProblem,
  type PreparationRecord,
  type PreparedClaim,
  type VersionRecord,
} from "../../store/applications.ts";
import { getBudgetState } from "../../store/budget.ts";
import { JobsStore } from "../../store/jobs.ts";
import { ProfileStore, type OnboardingProfile } from "../../store/profile.ts";
import { readiness as profileReadiness } from "../../store/profile-reducer.ts";
import { ProfileBusyError, serialise } from "../../store/profile-writes.ts";
import { labelClaims } from "../../validate/claims.ts";
import { citedLabels } from "../../validate/text.ts";
import { describeLocation, draftStatements, validateDraft, type Draft } from "../../validate/validator.ts";
import type { RunnerContext } from "../context.ts";
import { errorResponse, readBoundedJson, validationErrorResponse } from "../http.ts";
import { defineRouteModule } from "../route-modules.ts";
import { runTurn, withRun, type TurnResult } from "../run-harness.ts";

/**
 * Preparation with evidence (P05, mvp-spec F7), mounted at
 * `/api/applications`: prepare a saved job's resume (and, if asked, cover
 * letter) from confirmed claims only, check every sentence, export it, and
 * attach it to the job's application.
 *
 * One preparation, start to finish (`startPreparation`, then the queue):
 *
 * 1. Refused up front, plainly, when it can't be done: no name for the
 *    documents' header yet, the job's details not extracted, the career
 *    profile not ready ("Preparation is locked: … The workflow will not
 *    guess."), or the runner unable to run a turn (eve, a model, the budget).
 * 2. The idempotency key: the job and its revision, the profile's approved
 *    version, the options that change the output (the cover letter), and a
 *    digest of every input the model reads (the confirmed claims, the
 *    profile's notes, the job's fields). Documents already carrying that key
 *    mean "already prepared": nothing runs and nothing new is written. The
 *    digest is there because excluding a claim after approval keeps the
 *    profile's version (P03), and a document must never outlive a claim's
 *    exclusion unnoticed.
 * 3. A preparation attempt (`applications/<taskId>/preparation.json`)
 *    records the labelled claims and the job revision, and the application's
 *    `processing` goes to `running`. Its stage never moves until documents
 *    exist.
 * 4. One turn, inside `withRun` (budgeted and logged), through `runTurn`.
 *    The prompt (`buildPreparationPrompt`) carries the confirmed claims and
 *    the posting's fields as user-turn data in a random boundary; excluded
 *    claims are not in it at all. The model loads its skills and calls
 *    `prepare_application`, which checks the requirements and the draft
 *    and answers accepted, questions or refused (the model revises a
 *    refused draft and calls again in the same turn).
 * 5. After an ok turn only: any tool call outside the preparation's own
 *    tools saves nothing. Questions park the preparation: they are recorded,
 *    the run ends (recorded as not finished, "waiting for your answer"), and
 *    the page asks the person. An accepted draft is checked once more
 *    against the profile as it is now, then exported (Markdown from the
 *    package templates, DOCX, PDF, and diff-v<n>.md naming the version it
 *    replaces), and attached: documents recorded with the profile version,
 *    job revision and key; stage saved or preparing becomes ready;
 *    `processing` goes back to idle.
 * 6. Anything else (a failed, timed-out or cancelled turn, a provider limit,
 *    which also pauses the budget, a draft that never passed, a profile
 *    that changed meanwhile) records the reason in plain words on the
 *    attempt and in `processing`, writes no document and leaves the stage
 *    alone.
 *
 * Gap questions and eve's HITL. eve's `ctx.ask` parks a run until an answer
 * arrives, but "ending the run, by returning, throwing, or cancellation,
 * withdraws its pending requests" (eve docs, tools/workflows.mdx), and
 * `runTurn` cancels a turn that parks (run-harness.ts). A preparation is
 * a budgeted run that must end, and its answer may come days later, so the
 * question is the runner's own record, answered on the Applications page;
 * "Continue preparing" starts a new run for the same key with the answers
 * in its prompt. An answer can only leave a requirement out, or send the
 * person to their profile: it is never a fact a document can cite.
 */

const PREPARATION_TIMEOUT_MS = 180_000;
const MAX_PREPARE_BODY_BYTES = 4 * 1024;
const MAX_DETAILS_BODY_BYTES = 4 * 1024;
const MAX_ANSWER_BODY_BYTES = 2 * 1024;

/** This runner process, on every `running` attempt it writes; any other owner means the attempt was interrupted. */
const PROCESS_OWNER = randomUUID();
/** One preparation turn at a time per workspace. */
const PREPARATION_CHAINS = new Map<string, Promise<unknown>>();
/** Applications this process has queued and not yet finished, by workspace and task. Checked and set before any await. */
const IN_FLIGHT = new Set<string>();
/** Answers to one application's questions, one write at a time. */
const ANSWER_CHAINS = new Map<string, Promise<unknown>>();

export const INTERRUPTED_MESSAGE = "The last preparation was interrupted before it finished. Prepare it again.";
export const LOCKED_SUFFIX = "The workflow will not guess.";

function flightKey(ctx: RunnerContext, taskId: string): string {
  return `${ctx.workspace.root}\n${taskId}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// --- Inputs -----------------------------------------------------------------

/** The job's name as the pages show it: title and company when extracted, else its address's path. */
export function jobName(snapshot: JobSnapshot | undefined): string {
  if (!snapshot) return "A saved job that can't be read";
  const { title, company } = snapshot.structured;
  if (title && company) return `${title} · ${company}`;
  if (title) return title;
  try {
    const url = new URL(snapshot.url);
    return url.pathname.replace(/^\/+|\/+$/g, "") || url.hostname;
  } catch {
    return "Untitled posting";
  }
}

function hasStructuredFields(structured: JobStructured): boolean {
  return Object.values(structured).some((value) => (Array.isArray(value) ? value.length > 0 : value !== undefined));
}

/** A digest of everything the model reads, so any change to it is a new key. */
function inputsDigest(claims: readonly PreparedClaim[], profile: OnboardingProfile, job: JobStructured): string {
  const confirmed = claims.filter((claim) => claim.status === "confirmed").map((claim) => [claim.label, claim.id, claim.kind, claim.text]);
  const { title, company, location, requirements, niceToHave } = job;
  return sha256Hex(
    JSON.stringify({
      confirmed,
      boundaries: profile.boundaries.map((statement) => statement.text),
      presentation: profile.presentation.map((statement) => statement.text),
      job: { title, company, location, requirements, niceToHave },
    }),
  ).slice(0, 12);
}

/** `<jobId>@<revision>+profile@v<version>+<resume|resume+cover>+inputs@<digest>`: the walkthrough's key, plus the output options and the inputs digest. */
export function preparationKey(jobId: string, jobRevision: number, profileVersion: number, coverLetter: boolean, digest: string): string {
  return `${jobId}@${jobRevision}+profile@v${profileVersion}+${coverLetter ? "resume+cover" : "resume"}+inputs@${digest}`;
}

function preparedClaims(profile: OnboardingProfile): PreparedClaim[] {
  return labelClaims(profile.claims).map((claim) => ({ label: claim.label, id: claim.id, kind: claim.kind, status: claim.status, text: claim.text }));
}

/** Why preparation is locked, in the walkthrough's words: "Preparation is locked: <why>. The workflow will not guess." */
function lockedMessage(reasons: readonly string[]): string {
  const first = (reasons[0] ?? "the career profile isn't ready").replace(/^Not ready:\s*/, "").replace(/\.\s*$/, "");
  return `Preparation is locked: ${first}. ${LOCKED_SUFFIX}`;
}

// --- Starting a preparation --------------------------------------------------

export interface PrepareRequest {
  readonly jobId: string;
  readonly coverLetter: boolean;
  /** The run log's kind: `manual` from the page; P08-B's scheduled runs pass their own. */
  readonly kind?: RunKind;
  readonly isCatchUp?: boolean;
}

export type PrepareStart =
  | { readonly outcome: "refused"; readonly status: 404 | 409; readonly code: string; readonly message: string }
  | { readonly outcome: "already_prepared"; readonly taskId: string; readonly version: number }
  | { readonly outcome: "already_running"; readonly taskId: string }
  | { readonly outcome: "started"; readonly taskId: string };

interface Plan {
  readonly taskId: string;
  readonly attemptId: string;
  readonly jobId: string;
  readonly jobRevision: number;
  readonly profileVersion: number;
  readonly coverLetter: boolean;
  readonly idempotencyKey: string;
  readonly kind: RunKind;
  readonly isCatchUp: boolean;
}

function refused(status: 404 | 409, code: string, message: string): PrepareStart {
  return { outcome: "refused", status, code, message };
}

/** Why no turn can start right now, or undefined when one can. */
async function runnerRefusal(ctx: RunnerContext): Promise<PrepareStart | undefined> {
  if (!ctx.eve) return refused(409, "runner_not_running", "The runner's agent isn't running, so nothing can be prepared. Start it with `npm run runner`, then try again.");
  if (!ctx.model) return refused(409, "no_model", "No model is set up. Run `npm run setup` in `runner/`, then try again.");
  const budget = await getBudgetState(ctx.workspace, ctx.clock);
  if (budget.paused) return refused(409, "budget_paused", "The run budget is paused, so nothing was prepared. Resume it in Settings, then try again.");
  return undefined;
}

/** A previous attempt's answers carry over to the next attempt for the same key. */
function carriedAnswers(previous: PreparationRecord | "unreadable" | undefined, key: string): PreparationRecord["answers"] {
  if (!previous || previous === "unreadable" || previous.idempotencyKey !== key) return [];
  return previous.answers;
}

/**
 * Starts preparing `request.jobId`'s latest revision, or says why not, or
 * that it is already prepared or already running. Resolves as soon as the
 * turn is queued; `waitForPreparationQueue` resolves once it has finished.
 */
export async function startPreparation(ctx: RunnerContext, request: PrepareRequest): Promise<PrepareStart> {
  const applications = new ApplicationsStore(ctx.workspace, ctx.clock);
  const jobs = new JobsStore(ctx.workspace);

  const details = await applications.readDetails();
  if (!details) return refused(409, "details_missing", "Add your name for the documents' header first.");

  const revisions = uuidSchema.safeParse(request.jobId).success ? await jobs.revisions(request.jobId) : [];
  const jobRevision = revisions.at(-1);
  if (jobRevision === undefined) return refused(404, "job_not_found", "No such job.");
  const read = await jobs.readSnapshot(request.jobId, jobRevision);
  if (read.kind !== "ok") return refused(409, "snapshot_unreadable", "This job's latest revision can't be read, so it can't be prepared.");
  const snapshot = read.snapshot;
  if (!hasStructuredFields(snapshot.structured)) return refused(409, "not_extracted", "This job's details haven't been extracted yet. Extract them on the Jobs page first.");

  const loaded = await new ProfileStore(ctx.workspace, ctx.clock).load();
  if (loaded.markdownError) return refused(409, "profile_unreadable", "Your career-profile.md has an edit the runner can't read. Fix it on the Profile page first.");
  const profile = loaded.profile;
  const readiness = profileReadiness(profile);
  if (!readiness.ready || !profile.approval) return refused(409, "not_ready", lockedMessage(readiness.reasons));

  const claims = preparedClaims(profile);
  const profileVersion = profile.approval.version;
  const key = preparationKey(request.jobId, jobRevision, profileVersion, request.coverLetter, inputsDigest(claims, profile, snapshot.structured));

  const existing = await applications.findByJob(request.jobId);
  if (existing) {
    const done = existing.documents.find((document) => document.idempotencyKey === key);
    if (done) return { outcome: "already_prepared", taskId: existing.taskId, version: done.version };
    if (IN_FLIGHT.has(flightKey(ctx, existing.taskId))) return { outcome: "already_running", taskId: existing.taskId };
    const previous = await applications.readPreparation(existing.taskId);
    if (previous && previous !== "unreadable" && previous.status === "parked" && previous.idempotencyKey === key) {
      const answered = new Map(previous.answers.map((answer) => [answer.requirement, answer.answer]));
      const open = previous.questions.filter((question) => !answered.has(question.requirement));
      if (open.length > 0) return refused(409, "needs_answers", `Answer the ${plural(open.length, "open question")} first; preparation continues after that.`);
      if (previous.questions.some((question) => answered.get(question.requirement) === "add_evidence")) {
        return refused(409, "needs_profile", "Add the missing evidence to your profile and approve it, then prepare again.");
      }
    }
  }

  const runnerProblem = await runnerRefusal(ctx);
  if (runnerProblem) return runnerProblem;

  const { application } = await applications.ensureForJob(request.jobId);
  const flight = flightKey(ctx, application.taskId);
  if (IN_FLIGHT.has(flight)) return { outcome: "already_running", taskId: application.taskId };
  IN_FLIGHT.add(flight); // synchronously after the check: a second request for this task sees it

  try {
    const previous = await applications.readPreparation(application.taskId);
    const requirements = snapshot.structured.requirements ?? [];
    const now = ctx.clock.now().toISOString();
    const attempt: PreparationRecord = {
      attemptId: randomUUID(),
      status: "running",
      owner: PROCESS_OWNER,
      idempotencyKey: key,
      jobId: request.jobId,
      jobRevision,
      profileVersion,
      coverLetter: request.coverLetter,
      claims,
      requirementsDigest: requirementsDigest(requirements),
      requirementCount: requirements.length,
      answers: carriedAnswers(previous, key),
      questions: [],
      problems: [],
      startedAt: now,
      updatedAt: now,
    };
    await applications.writePreparation(application.taskId, attempt);
    await applications.update(application.taskId, (current) => ({ ...current, processing: { status: "running" } }));
    const plan: Plan = {
      taskId: application.taskId,
      attemptId: attempt.attemptId,
      jobId: request.jobId,
      jobRevision,
      profileVersion,
      coverLetter: request.coverLetter,
      idempotencyKey: key,
      kind: request.kind ?? "manual",
      isCatchUp: request.isCatchUp ?? false,
    };
    void serialise(PREPARATION_CHAINS, ctx.workspace.root, () => runPreparation(ctx, plan)).finally(() => IN_FLIGHT.delete(flight));
    return { outcome: "started", taskId: application.taskId };
  } catch (error) {
    IN_FLIGHT.delete(flight);
    throw error;
  }
}

/** Test-only: resolves once every preparation queued so far for this workspace has finished. */
export async function waitForPreparationQueue(workspaceRoot: string): Promise<void> {
  await (PREPARATION_CHAINS.get(workspaceRoot) ?? Promise.resolve());
}

// --- Running one ------------------------------------------------------------

type Outcome =
  | { readonly kind: "done"; readonly version: VersionRecord; readonly documents: readonly ApplicationDocument[]; readonly coverage: PrepareApplicationOutput["coverage"] }
  | { readonly kind: "parked"; readonly questions: PreparationRecord["questions"]; readonly coverage: PrepareApplicationOutput["coverage"] }
  | { readonly kind: "failed"; readonly error: string; readonly problems?: readonly PreparationProblem[] };

const ZERO_TOKENS = { input: 0, output: 0 };

export const EXCLUDED_PROBLEM_MESSAGE = "This sentence drew on a claim you excluded, so it was refused.";

/**
 * The refusals as the attempt keeps them for the page. A sentence that drew
 * on an excluded claim is never quoted back, not even to the person: it
 * keeps one problem, with no sentence and no detail (the other rules' details,
 * a number say, could repeat the excluded wording).
 */
export function keptProblems(problems: ReadonlyArray<{ readonly rule: string; readonly where: string; readonly sentence: string; readonly message: string }>): PreparationProblem[] {
  const excluded = new Set(problems.filter((problem) => problem.rule === "excluded_claim").map((problem) => `${problem.where}\n${problem.sentence}`));
  const kept: PreparationProblem[] = [];
  const seen = new Set<string>();
  for (const problem of problems) {
    const key = `${problem.where}\n${problem.sentence}`;
    if (!excluded.has(key)) {
      kept.push({ rule: problem.rule, where: problem.where, sentence: problem.sentence, message: problem.message });
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ rule: "excluded_claim", where: problem.where, sentence: "", message: EXCLUDED_PROBLEM_MESSAGE });
  }
  return kept;
}

/** A turn's status in words the person can act on. The run log keeps the technical detail. */
function turnFailure(turn: TurnResult): string {
  if (turn.status === "timeout") return "The model took too long, so the preparation was stopped. Try again.";
  if (turn.providerLimit) return "The model provider's rate limit stopped this, and the run budget is now paused. Resume it in Settings, then prepare again.";
  if (turn.status === "cancelled") return "The preparation was cancelled before it finished.";
  if (turn.status === "parked") return "The model asked for input instead of finishing. Try again.";
  if (turn.detail === "eve is not running.") return "The runner's agent isn't running. Start it with `npm run runner`, then prepare again.";
  return "The model's turn failed, so nothing was saved. Try again; the Runs page has the details.";
}

async function runPreparation(ctx: RunnerContext, plan: Plan): Promise<void> {
  let outcome: Outcome | undefined;
  let record: RunRecord;
  try {
    record = await withRun(
      ctx,
      {
        kind: plan.kind,
        idempotencyKey: plan.idempotencyKey,
        isCatchUp: plan.isCatchUp,
        items: [plan.taskId],
        inputs: { taskId: plan.taskId, jobId: plan.jobId, jobRevision: plan.jobRevision, profileVersion: plan.profileVersion, coverLetter: plan.coverLetter },
      },
      async (runCtx) => {
        try {
          const result = await preparePackage(runCtx, plan);
          outcome = result.outcome;
          return { turns: result.turns };
        } catch (error) {
          // withRun records the throw as the run's failure; the attempt and the application say it plainly.
          outcome = {
            kind: "failed",
            error: error instanceof ProfileBusyError ? "Your career profile was busy, so nothing was saved. Prepare it again in a moment." : "The preparation stopped unexpectedly, so nothing was saved. Try again.",
          };
          throw error;
        }
      },
    );
  } catch (error) {
    // withRun never rejects; this keeps an unexpected throw from leaving the attempt "running".
    ctx.log.error(`applications: preparation ${plan.taskId} stopped unexpectedly (${(error as Error).name}).`);
    await finish(ctx, plan, undefined, { kind: "failed", error: "The preparation stopped unexpectedly. Try again." }).catch(() => undefined);
    return;
  }
  if (!outcome) {
    // The body never ran: the budget was paused or today's limit reached (a paused record), or the run couldn't be recorded.
    const reason =
      record.outcome !== "paused"
        ? "The preparation didn't start because its run couldn't be recorded. Try again."
        : record.error?.startsWith("daily run limit reached")
          ? "Today's run limit is reached, so nothing was prepared. Raise it in Settings, or prepare it tomorrow."
          : "The run budget is paused, so nothing was prepared. Resume it in Settings, then try again.";
    outcome = { kind: "failed", error: reason };
  }
  await finish(ctx, plan, record, outcome);
}

/** The attempt's final state, and the application's: documents and stage only when done; `processing` always. */
async function finish(ctx: RunnerContext, plan: Plan, record: RunRecord | undefined, outcome: Outcome): Promise<void> {
  const applications = new ApplicationsStore(ctx.workspace, ctx.clock);
  const current = await applications.readPreparation(plan.taskId);
  const runId = record?.runId !== undefined && uuidSchema.safeParse(record.runId).success ? record.runId : undefined;
  if (current && current !== "unreadable" && current.attemptId === plan.attemptId) {
    const { owner: _owner, ...rest } = current;
    void _owner;
    const base = { ...rest, ...(runId ? { runId } : {}) };
    const next: PreparationRecord =
      outcome.kind === "done"
        ? { ...base, status: "done", version: outcome.version.version, questions: [], problems: [], ...(outcome.coverage ? { coverage: outcome.coverage } : {}) }
        : outcome.kind === "parked"
          ? { ...base, status: "parked", questions: outcome.questions, problems: [], ...(outcome.coverage ? { coverage: outcome.coverage } : {}) }
          : { ...base, status: "failed", error: outcome.error, problems: [...(outcome.problems ?? [])] };
    await applications.writePreparation(plan.taskId, next);
  }
  await applications.update(plan.taskId, (application) => {
    const processingBase = runId ? { runId } : {};
    if (outcome.kind === "done") {
      return {
        ...application,
        documents: [...application.documents, ...outcome.documents],
        stage: application.stage === "saved" || application.stage === "preparing" ? "ready" : application.stage,
        processing: { status: "idle", ...processingBase },
      };
    }
    const error = outcome.kind === "parked" ? `Waiting for your answer to ${plural(outcome.questions.length, "question")}.` : outcome.error;
    return { ...application, processing: { status: "failed", ...processingBase, error } };
  });
}

/**
 * The body of one preparation run: the turn, then everything decided from
 * it. Returns the turns for `withRun`'s record (a synthetic non-ok turn
 * marks a run that ended without documents, so the log never calls it a
 * success) and the outcome for `finish`.
 */
export async function preparePackage(ctx: RunnerContext, plan: Plan): Promise<{ readonly turns: readonly TurnResult[]; readonly outcome: Outcome }> {
  const applications = new ApplicationsStore(ctx.workspace, ctx.clock);
  const jobs = new JobsStore(ctx.workspace);
  const notFinished = (status: "failed" | "parked", detail: string): TurnResult => ({ status, tokens: ZERO_TOKENS, detail });
  const fail = (turns: TurnResult[], error: string, problems?: readonly PreparationProblem[]) => ({
    turns: turns.some((turn) => turn.status !== "ok") ? turns : [...turns, notFinished("failed", error)],
    outcome: { kind: "failed" as const, error, ...(problems ? { problems } : {}) },
  });

  const attempt = await applications.readPreparation(plan.taskId);
  const read = await jobs.readSnapshot(plan.jobId, plan.jobRevision);
  if (!attempt || attempt === "unreadable" || attempt.attemptId !== plan.attemptId || read.kind !== "ok") {
    return fail([], "The preparation's own records couldn't be read. Try again.");
  }
  const profile = (await new ProfileStore(ctx.workspace, ctx.clock).load()).profile;
  const message = buildPreparationPrompt({
    taskId: plan.taskId,
    coverLetter: plan.coverLetter,
    claims: attempt.claims,
    boundaries: profile.boundaries.map((statement) => statement.text),
    presentation: profile.presentation.map((statement) => statement.text),
    answers: attempt.answers,
    job: read.snapshot.structured,
  });

  const turn = await runTurn(ctx, { message, timeoutMs: PREPARATION_TIMEOUT_MS, collectEvents: true });
  if (turn.status !== "ok") return fail([turn], turnFailure(turn));
  const events = turn.events ?? [];

  // hard-problems.md #3: a preparation turn may only prepare. Anything else it asked for (whatever the posting said) saves nothing.
  const outside = actionsOutsidePreparation(events);
  if (outside.length > 0) {
    ctx.log.warn(`applications: preparation ${plan.taskId} asked for ${outside.length} action(s) outside preparation; nothing saved.`);
    return fail([turn], "The model tried to do something other than prepare documents, so nothing was saved.");
  }

  const result = preparationResult(events, plan.taskId, plan.attemptId);
  if (!result) return fail([turn], "The model finished without handing over a draft, so nothing was saved. Try again.");
  if (result.status === "questions") {
    const questions = (result.questions ?? []).map((question) => ({ requirement: question.requirement, question: question.question }));
    return {
      turns: [turn, notFinished("parked", `Waiting for your answer to ${plural(questions.length, "question")}.`)],
      outcome: { kind: "parked", questions, coverage: result.coverage },
    };
  }
  if (result.status !== "accepted" || !result.draft) {
    return fail([turn], "The draft didn't pass the runner's checks, so nothing was saved.", keptProblems(result.problems ?? []));
  }

  // The authoritative check: the draft again, against the profile as it is now (P03 may have changed it during the turn).
  const live = await new ProfileStore(ctx.workspace, ctx.clock).load();
  const liveReadiness = profileReadiness(live.profile);
  const liveClaims = preparedClaims(live.profile);
  const liveKey = live.profile.approval ? preparationKey(plan.jobId, plan.jobRevision, live.profile.approval.version, plan.coverLetter, inputsDigest(liveClaims, live.profile, read.snapshot.structured)) : undefined;
  if (live.markdownError || !liveReadiness.ready || liveKey !== plan.idempotencyKey) {
    return fail([turn], "Your career profile changed while this was being prepared, so nothing was saved. Prepare it again.");
  }
  const draft: Draft = result.draft;
  const check = validateDraft({ draft, claims: liveClaims, postingText: postingText(read.snapshot), coverLetterRequested: plan.coverLetter });
  if (!check.ok) {
    const problems = check.refusals.map((refusal) => ({ rule: refusal.rule, where: describeLocation(refusal.where), sentence: refusal.sentence, message: refusal.message }));
    return fail([turn], "The draft didn't pass the runner's checks, so nothing was saved.", keptProblems(problems));
  }

  const details = await applications.readDetails();
  if (!details) return fail([turn], "Add your name for the documents' header, then prepare again.");
  const exported = await exportVersion(ctx, plan, draft, liveClaims, read.snapshot, details);
  return { turns: [turn], outcome: { kind: "done", version: exported.version, documents: exported.documents, coverage: result.coverage } };
}

// --- Export -------------------------------------------------------------------

async function exportVersion(
  ctx: RunnerContext,
  plan: Plan,
  draft: Draft,
  claims: readonly PreparedClaim[],
  snapshot: JobSnapshot,
  person: PersonHeader,
): Promise<{ readonly version: VersionRecord; readonly documents: ApplicationDocument[] }> {
  const applications = new ApplicationsStore(ctx.workspace, ctx.clock);
  const application = await applications.get(plan.taskId);
  const versions = await applications.listVersions(plan.taskId);
  const previous = versions.at(-1);
  const number = Math.max(previous?.version ?? 0, ...(application?.documents ?? []).map((document) => document.version)) + 1;
  const at = ctx.clock.now();
  const createdAt = at.toISOString();

  const confirmed = claims.filter((claim) => claim.status === "confirmed");
  const cited = new Set(draftStatements(draft).flatMap((statement) => citedLabels(statement.text)));
  const sources = confirmed.filter((claim) => cited.has(claim.label));
  const sourceMap = new Map<string, SourceClaim>(sources.map((claim) => [claim.label, { label: claim.label, kind: claim.kind, text: claim.text }]));
  const statements: StatementDiff[] = statementDiffs(draft, sourceMap);
  const changes = previous ? versionChanges(previous.statements, statements, new Set(confirmed.map((claim) => claim.label))) : [];

  const files: Array<{ readonly kind: ApplicationDocument["kind"]; readonly format: ApplicationDocument["format"]; readonly name: string; readonly data: string | Uint8Array }> = [];
  const resume = resumeModel(draft, person);
  files.push(
    { kind: "resume", format: "md", name: `resume-v${number}.md`, data: await renderMarkdown(resume) },
    { kind: "resume", format: "docx", name: `resume-v${number}.docx`, data: await renderDocx(resume) },
    { kind: "resume", format: "pdf", name: `resume-v${number}.pdf`, data: await renderPdf(resume) },
  );
  if (plan.coverLetter) {
    const letter = coverLetterModel(draft, person, snapshot.structured.company, at);
    files.push(
      { kind: "cover_letter", format: "md", name: `cover-v${number}.md`, data: await renderMarkdown(letter) },
      { kind: "cover_letter", format: "docx", name: `cover-v${number}.docx`, data: await renderDocx(letter) },
      { kind: "cover_letter", format: "pdf", name: `cover-v${number}.pdf`, data: await renderPdf(letter) },
    );
  }
  files.push({
    kind: "diff",
    format: "md",
    name: `diff-v${number}.md`,
    data: renderDiffMarkdown({
      version: number,
      ...(previous ? { replaces: previous.version } : {}),
      preparedOn: letterDate(at),
      profileVersion: plan.profileVersion,
      jobRevision: plan.jobRevision,
      statements,
      changes,
    }),
  });

  const documents: ApplicationDocument[] = [];
  for (const file of files) {
    const documentPath = await applications.writeDocumentFile(plan.taskId, file.name, file.data);
    documents.push({
      kind: file.kind,
      version: number,
      format: file.format,
      path: documentPath,
      createdAt,
      profileVersion: plan.profileVersion,
      jobRevision: plan.jobRevision,
      idempotencyKey: plan.idempotencyKey,
    });
  }
  const version: VersionRecord = {
    version: number,
    ...(previous ? { replaces: previous.version } : {}),
    createdAt,
    idempotencyKey: plan.idempotencyKey,
    profileVersion: plan.profileVersion,
    jobRevision: plan.jobRevision,
    coverLetter: plan.coverLetter,
    draft: { resume: { sections: draft.resume.sections.map((section) => ({ heading: section.heading, statements: [...section.statements] })) }, ...(draft.coverLetter ? { coverLetter: { paragraphs: draft.coverLetter.paragraphs.map((paragraph) => [...paragraph]) } } : {}) },
    sources,
    statements: statements.map((statement) => ({ ...statement, labels: [...statement.labels], sources: [...statement.sources], ops: statement.ops ? [...statement.ops] : null })),
    changes: changes.map(({ noLongerConfirmed, ...change }) => ({ ...change, labels: [...change.labels], ...(noLongerConfirmed ? { noLongerConfirmed: [...noLongerConfirmed] } : {}) })),
  };
  await applications.writeVersion(plan.taskId, version);
  return { version, documents };
}

// --- Views ------------------------------------------------------------------

export type StateStatus = "idle" | "running" | "parked" | "failed" | "interrupted";

export interface StateView {
  readonly status: StateStatus;
  readonly message: string;
}

function stateOf(ctx: RunnerContext, application: Application, attempt: PreparationRecord | "unreadable" | undefined): StateView {
  const known = attempt !== undefined && attempt !== "unreadable" ? attempt : undefined;
  if (known?.status === "running" || application.processing.status === "running") {
    const live = known?.status === "running" && known.owner === PROCESS_OWNER && IN_FLIGHT.has(flightKey(ctx, application.taskId));
    return live ? { status: "running", message: "Preparing now. This can take a minute or two." } : { status: "interrupted", message: INTERRUPTED_MESSAGE };
  }
  if (known?.status === "parked") return { status: "parked", message: application.processing.error ?? "Waiting for your answers." };
  if (application.processing.status === "failed") return { status: "failed", message: application.processing.error ?? "The last preparation didn't finish." };
  return { status: "idle", message: "" };
}

const FORMAT_LABELS: Readonly<Record<ApplicationDocument["format"], string>> = { md: "Markdown", docx: "Word", pdf: "PDF" };
const KIND_LABELS: Readonly<Record<ApplicationDocument["kind"], string>> = { resume: "Resume", cover_letter: "Cover letter", diff: "What changed" };

function fileView(taskId: string, document: ApplicationDocument) {
  const name = path.posix.basename(document.path);
  return { kind: document.kind, format: document.format, name, label: `${KIND_LABELS[document.kind]} · ${FORMAT_LABELS[document.format]}`, href: `/api/applications/${taskId}/docs/${name}` };
}

async function summaryView(ctx: RunnerContext, application: Application, jobs: JobsStore, applications: ApplicationsStore) {
  const latest = application.documents.reduce((max, document) => Math.max(max, document.version), 0);
  const snapshot = await latestSnapshot(jobs, application.jobId);
  return {
    taskId: application.taskId,
    jobId: application.jobId,
    jobName: jobName(snapshot),
    stage: application.stage,
    latestVersion: latest > 0 ? latest : null,
    state: stateOf(ctx, application, await applications.readPreparation(application.taskId)),
  };
}

async function latestSnapshot(jobs: JobsStore, jobId: string): Promise<JobSnapshot | undefined> {
  const numbers = await jobs.revisions(jobId);
  for (let index = numbers.length - 1; index >= 0; index -= 1) {
    const snapshot = await jobs.getSnapshot(jobId, numbers[index]!);
    if (snapshot) return snapshot;
  }
  return undefined;
}

async function listView(ctx: RunnerContext) {
  const applications = new ApplicationsStore(ctx.workspace, ctx.clock);
  const jobs = new JobsStore(ctx.workspace);
  const loaded = await new ProfileStore(ctx.workspace, ctx.clock).load();
  const readiness = profileReadiness(loaded.profile);
  const listed = await applications.list();
  const byJob = new Map(listed.applications.map((application) => [application.jobId, application]));
  const summaries = await jobs.listJobs();
  const runnerProblem = await runnerRefusal(ctx);
  return {
    readiness: {
      ready: readiness.ready && !loaded.markdownError,
      message: loaded.markdownError ? "Your career-profile.md has an edit the runner can't read. Fix it on the Profile page first." : readiness.ready ? null : lockedMessage(readiness.reasons),
      profileVersion: loaded.profile.approval?.version ?? null,
    },
    details: (await applications.readDetails()) ?? null,
    runner: runnerProblem && runnerProblem.outcome === "refused" ? { ready: false, code: runnerProblem.code, message: runnerProblem.message } : { ready: true, code: null, message: null },
    jobs: summaries.map((summary) => ({
      jobId: summary.jobId,
      name: jobName(summary.newestReadable),
      revision: summary.latestRevisionNumber,
      extracted: summary.latest ? hasStructuredFields(summary.latest.structured) : false,
      taskId: byJob.get(summary.jobId)?.taskId ?? null,
    })),
    applications: await Promise.all(listed.applications.map((application) => summaryView(ctx, application, jobs, applications))),
    unreadable: listed.unreadable.map((entry) => ({ path: entry.path })),
  };
}

async function detailView(ctx: RunnerContext, taskId: string) {
  const applications = new ApplicationsStore(ctx.workspace, ctx.clock);
  const jobs = new JobsStore(ctx.workspace);
  const application = await applications.get(taskId);
  if (!application) return undefined;
  const attempt = await applications.readPreparation(taskId);
  const known = attempt !== undefined && attempt !== "unreadable" ? attempt : undefined;
  const attemptSnapshot = known ? await jobs.getSnapshot(application.jobId, known.jobRevision) : undefined;
  const requirementText = (requirement: number) => attemptSnapshot?.structured.requirements?.[requirement - 1] ?? `Requirement ${requirement}`;

  const loaded = await new ProfileStore(ctx.workspace, ctx.clock).load();
  const confirmedNow = new Set(preparedClaims(loaded.profile).filter((claim) => claim.status === "confirmed").map((claim) => claim.label));
  const currentVersion = loaded.profile.approval?.version ?? null;
  const versions = (await applications.listVersions(taskId)).reverse();
  const latest = await latestSnapshot(jobs, application.jobId);

  return {
    taskId,
    jobId: application.jobId,
    jobName: jobName(latest),
    stage: application.stage,
    state: stateOf(ctx, application, attempt),
    preparation: known
      ? {
          status: known.status,
          coverLetter: known.coverLetter,
          questions: known.questions.map((question) => ({
            requirement: question.requirement,
            requirementText: requirementText(question.requirement),
            question: question.question,
            answer: known.answers.find((answer) => answer.requirement === question.requirement)?.answer ?? null,
          })),
          problems: known.status === "failed" ? known.problems : [],
          /** The confirmed claims this attempt could cite, by label: the page names a covered requirement's evidence by its words. */
          claims: known.claims.filter((claim) => claim.status === "confirmed").map((claim) => ({ label: claim.label, text: claim.text })),
          // A line the model set aside as not a requirement is never quoted back: a posting can hide an instruction there (job-hostile.json).
          coverage: (known.coverage ?? []).map((entry) => ({ ...entry, requirementText: entry.status === "not_a_requirement" ? null : requirementText(entry.requirement) })),
        }
      : null,
    versions: versions.map((version) => {
      const stale = version.sources.map((source) => source.label).filter((label) => !confirmedNow.has(label));
      return {
        version: version.version,
        replaces: version.replaces ?? null,
        createdAt: version.createdAt,
        profileVersion: version.profileVersion,
        jobRevision: version.jobRevision,
        coverLetter: version.coverLetter,
        files: application.documents.filter((document) => document.version === version.version).map((document) => fileView(taskId, document)),
        // Each sentence with its source claims and its presentation change, in the words diff-v<n>.md uses.
        statements: version.statements.map((statement) => ({ ...statement, presentation: presentationSummary(statement) })),
        changes: version.changes,
        olderProfile: currentVersion !== null && version.profileVersion < currentVersion,
        noLongerConfirmed: stale,
      };
    }),
    latestJobRevision: latest?.revision ?? null,
  };
}

// --- The module -----------------------------------------------------------------

const prepareBodySchema = z.object({ jobId: z.string(), coverLetter: z.boolean() }).strict();
const answerBodySchema = z.object({ requirement: z.number().int().positive(), answer: z.enum(GAP_ANSWERS) }).strict();

const DOCUMENT_TYPES: Readonly<Record<string, string>> = {
  md: "text/markdown; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

async function answerQuestion(ctx: RunnerContext, taskId: string, requirement: number, answer: GapAnswer): Promise<"ok" | "no_question"> {
  return serialise(ANSWER_CHAINS, `${ctx.workspace.root}\n${taskId}`, async () => {
    const applications = new ApplicationsStore(ctx.workspace, ctx.clock);
    const attempt = await applications.readPreparation(taskId);
    if (!attempt || attempt === "unreadable" || attempt.status !== "parked") return "no_question";
    const question = attempt.questions.find((entry) => entry.requirement === requirement);
    if (!question) return "no_question";
    const answers = [...attempt.answers.filter((entry) => entry.requirement !== requirement), { requirement, question: question.question, answer, answeredAt: ctx.clock.now().toISOString() }];
    await applications.writePreparation(taskId, { ...attempt, answers });
    return "ok";
  });
}

/** Marks every preparation a stopped runner left `running` as interrupted: nothing is working on it any more. */
async function sweepInterrupted(ctx: RunnerContext): Promise<void> {
  const applications = new ApplicationsStore(ctx.workspace, ctx.clock);
  for (const application of (await applications.list()).applications) {
    const attempt = await applications.readPreparation(application.taskId);
    const running = attempt !== undefined && attempt !== "unreadable" && attempt.status === "running";
    if (application.processing.status !== "running" && !running) continue;
    if (IN_FLIGHT.has(flightKey(ctx, application.taskId))) continue;
    if (running) {
      const { owner: _owner, ...rest } = attempt;
      void _owner;
      await applications.writePreparation(application.taskId, { ...rest, status: "failed", error: INTERRUPTED_MESSAGE, problems: [] });
    }
    await applications.update(application.taskId, (current) => ({
      ...current,
      processing: { status: "failed", ...(current.processing.runId ? { runId: current.processing.runId } : {}), error: INTERRUPTED_MESSAGE },
    }));
  }
}

export default defineRouteModule({
  async start(ctx) {
    await sweepInterrupted(ctx).catch((error: Error) => ctx.log.warn(`applications: couldn't mark interrupted preparations (${error.name}).`));
  },

  api(router, ctx) {
    router.onError((error) => {
      if (error instanceof ProfileBusyError) return errorResponse(503, "profile_busy", "Your career profile is busy. Try again in a moment.");
      throw error;
    });

    router.get("/", async (c) => c.json(await listView(ctx)));

    router.post("/details", async (c) => {
      const body = await readBoundedJson(c.req.raw, MAX_DETAILS_BODY_BYTES);
      if (!body.ok) return body.response;
      const parsed = personDetailsSchema.safeParse(body.value);
      if (!parsed.success) {
        const name = typeof (body.value as { name?: unknown } | null)?.name === "string" ? ((body.value as { name: string }).name.trim()) : "";
        if (!name) return errorResponse(400, "name_missing", "Enter your name as it should appear on your documents.");
        return validationErrorResponse(parsed.error);
      }
      const details = await new ApplicationsStore(ctx.workspace, ctx.clock).writeDetails(parsed.data);
      return c.json({ ok: true, details });
    });

    router.post("/prepare", async (c) => {
      const body = await readBoundedJson(c.req.raw, MAX_PREPARE_BODY_BYTES);
      if (!body.ok) return body.response;
      const parsed = prepareBodySchema.safeParse(body.value);
      if (!parsed.success) return validationErrorResponse(parsed.error);
      const started = await startPreparation(ctx, { jobId: parsed.data.jobId, coverLetter: parsed.data.coverLetter });
      if (started.outcome === "refused") return errorResponse(started.status, started.code, started.message);
      return c.json({ ok: true, outcome: started.outcome, ...(started.outcome === "already_prepared" ? { version: started.version } : {}), application: await detailView(ctx, started.taskId) });
    });

    router.get("/:taskId", async (c) => {
      const taskId = c.req.param("taskId");
      if (!uuidSchema.safeParse(taskId).success) return errorResponse(404, "not_found", "No such application.");
      const detail = await detailView(ctx, taskId);
      if (!detail) return errorResponse(404, "not_found", "No such application.");
      return c.json(detail);
    });

    router.post("/:taskId/answers", async (c) => {
      const taskId = c.req.param("taskId");
      if (!uuidSchema.safeParse(taskId).success) return errorResponse(404, "not_found", "No such application.");
      const body = await readBoundedJson(c.req.raw, MAX_ANSWER_BODY_BYTES);
      if (!body.ok) return body.response;
      const parsed = answerBodySchema.safeParse(body.value);
      if (!parsed.success) return validationErrorResponse(parsed.error);
      const result = await answerQuestion(ctx, taskId, parsed.data.requirement, parsed.data.answer);
      if (result === "no_question") return errorResponse(409, "no_open_question", "That question isn't open any more.");
      return c.json({ ok: true, application: await detailView(ctx, taskId) });
    });

    // Downloads: an attachment, never rendered in the page's origin, and only a file this application's record lists.
    router.get("/:taskId/docs/:file", async (c) => {
      const taskId = c.req.param("taskId");
      const file = c.req.param("file");
      if (!uuidSchema.safeParse(taskId).success || !isDocumentFileName(file)) return errorResponse(404, "not_found", "No such document.");
      const applications = new ApplicationsStore(ctx.workspace, ctx.clock);
      const application = await applications.get(taskId);
      if (!application || !application.documents.some((document) => path.posix.basename(document.path) === file)) return errorResponse(404, "not_found", "No such document.");
      const data = await applications.readDocumentFile(taskId, file);
      if (!data) return errorResponse(404, "not_found", "That document's file is missing from the workspace.");
      const extension = file.slice(file.lastIndexOf(".") + 1);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          "content-type": DOCUMENT_TYPES[extension] ?? "application/octet-stream",
          "content-disposition": `attachment; filename="${file}"`,
          "content-security-policy": "default-src 'none'; sandbox",
          "cache-control": "no-store",
        },
      });
    });
  },
});
