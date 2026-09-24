import type { JobSnapshot } from "@workflow-catalog/contracts";
import { systemClock } from "../../lib/clock.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { ApplicationsStore, type PreparationRecord, type PreparedClaim } from "../../store/applications.ts";
import { JobsStore } from "../../store/jobs.ts";
import { Workspace } from "../../store/workspace.ts";
import { describeLocation, validateDraft, type ValidationClaim } from "../../validate/validator.ts";
import type { PrepareApplicationInput, PrepareApplicationOutput } from "./prepare-schema.ts";

/**
 * The behaviour behind `prepare_application` (P05). Directive-free, so both
 * tool roots call it from a one-line `"use step"` wrapper
 * (docs/spec/research/eve-runtime.md §8 item 14), and
 * `test/prepare-logic.test.ts` tests it against real stores.
 *
 * It never writes. It reads the preparation attempt the bridge started for
 * this application (`applications/<taskId>/preparation.json`: the labelled
 * claims, the answers so far, the job revision) and that revision's
 * snapshot, and answers the model with one of:
 *
 * - `refused`: something to fix, each problem named with its place. The
 *   model fixes it and calls again (the revision pass).
 * - `questions`: at least one requirement has no confirmed claim behind it.
 *   The draft is not checked; the bridge records the questions and the run
 *   parks until the person answers (never guessed).
 * - `accepted`: every requirement is accounted for and every sentence passed
 *   the validator. The bridge checks it once more against the live profile
 *   before exporting anything.
 *
 * Nothing it returns names an excluded claim, by text or id: the model was
 * never shown one, and a refusal never tells it.
 */

export interface PreparationStores {
  readonly applications: ApplicationsStore;
  readonly jobs: JobsStore;
}

/** The posting's own words: its text and extracted fields, which a draft must not copy (the validator's `posting_wording`). */
export function postingText(snapshot: JobSnapshot): string {
  const structured = snapshot.structured;
  return [snapshot.text, structured.title, structured.company, structured.location, ...(structured.requirements ?? []), ...(structured.niceToHave ?? [])]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
}

/** A digest of a snapshot's requirement list, so a re-extraction mid-preparation is noticed. */
export function requirementsDigest(requirements: readonly string[]): string {
  return sha256Hex(JSON.stringify(requirements));
}

function asValidationClaims(claims: readonly PreparedClaim[]): ValidationClaim[] {
  return claims.map((claim) => ({ label: claim.label, id: claim.id, kind: claim.kind, status: claim.status, text: claim.text }));
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Problems with how the requirements are accounted for, before any draft is read. */
function coverageProblems(input: PrepareApplicationInput, attempt: PreparationRecord): Array<{ rule: string; where: string; sentence: string; message: string }> {
  const problems: Array<{ rule: string; where: string; sentence: string; message: string }> = [];
  const add = (requirement: number, message: string) => problems.push({ rule: "requirements", where: `Requirement ${requirement}`, sentence: "", message });
  const confirmed = new Set(attempt.claims.filter((claim) => claim.status === "confirmed").map((claim) => claim.label));
  const answered = new Map(attempt.answers.map((answer) => [answer.requirement, answer.answer]));
  const seen = new Set<number>();
  for (const entry of input.requirements) {
    if (entry.requirement > attempt.requirementCount) {
      add(entry.requirement, `There is no requirement ${entry.requirement}; the posting lists ${plural(attempt.requirementCount, "requirement")}.`);
      continue;
    }
    if (seen.has(entry.requirement)) {
      add(entry.requirement, `Requirement ${entry.requirement} is listed twice. Give it one entry.`);
      continue;
    }
    seen.add(entry.requirement);
    const labels = entry.claims ?? [];
    switch (entry.status) {
      case "covered": {
        if (labels.length === 0) add(entry.requirement, "A covered requirement names the labels of the confirmed claims that meet it.");
        const unknown = labels.filter((label) => !confirmed.has(label));
        if (unknown.length > 0) add(entry.requirement, `${unknown.join(", ")} ${unknown.length === 1 ? "isn't one of" : "aren't among"} the confirmed claims you were given.`);
        if (entry.question) add(entry.requirement, "A covered requirement has no question. Mark it a gap if the claims don't meet it.");
        break;
      }
      case "gap":
        if (!entry.question) add(entry.requirement, "A gap needs one short question for the person.");
        if (answered.get(entry.requirement) === "leave_out") add(entry.requirement, `The person already answered requirement ${entry.requirement}: leave it out. Mark it left_out.`);
        break;
      case "left_out":
        if (answered.get(entry.requirement) !== "leave_out") add(entry.requirement, `The person hasn't said to leave requirement ${entry.requirement} out. Mark it covered, or a gap with a question.`);
        break;
      case "not_a_requirement":
        if (labels.length > 0 || entry.question) add(entry.requirement, "A line that isn't a requirement takes no claims and no question.");
        break;
    }
  }
  for (let requirement = 1; requirement <= attempt.requirementCount; requirement += 1) {
    if (!seen.has(requirement)) add(requirement, `Requirement ${requirement} isn't accounted for: mark it covered, a gap with a question, or not a requirement.`);
  }
  return problems;
}

/** Checks one `prepare_application` call against the attempt the bridge started. Never writes; never throws for bad input. */
export async function checkPreparation(input: PrepareApplicationInput, stores: PreparationStores): Promise<PrepareApplicationOutput> {
  const attempt = await stores.applications.readPreparation(input.taskId);
  if (attempt === undefined || attempt === "unreadable" || attempt.status !== "running") {
    return { taskId: input.taskId, status: "refused", message: "This application isn't being prepared right now, so nothing was checked." };
  }
  const base = { taskId: input.taskId, attemptId: attempt.attemptId };
  const snapshot = await stores.jobs.readSnapshot(attempt.jobId, attempt.jobRevision);
  if (snapshot.kind !== "ok") return { ...base, status: "refused", message: "The job posting this preparation uses can't be read, so nothing was checked." };
  const requirements = snapshot.snapshot.structured.requirements ?? [];
  if (requirementsDigest(requirements) !== attempt.requirementsDigest || requirements.length !== attempt.requirementCount) {
    return { ...base, status: "refused", message: "The job's requirements changed while this was being prepared. Stop here; the person can prepare it again." };
  }

  const coverage = input.requirements.map((entry) => ({ requirement: entry.requirement, status: entry.status, labels: entry.claims ?? [] }));
  const problems = coverageProblems(input, attempt);
  if (problems.length > 0) {
    return { ...base, status: "refused", message: `Fix ${plural(problems.length, "problem")} with the requirements, then call again.`, problems };
  }

  const gaps = input.requirements.filter((entry) => entry.status === "gap");
  if (gaps.length > 0) {
    return {
      ...base,
      status: "questions",
      message: `${plural(gaps.length, "question")} recorded for the person. Stop here and write no documents: the runner asks, and preparation continues once they answer.`,
      questions: gaps.map((entry) => ({ requirement: entry.requirement, question: entry.question! })),
      coverage,
    };
  }

  if (!input.resume) return { ...base, status: "refused", message: "Every requirement is accounted for, so write the resume now and call again with it.", coverage };
  if (input.coverLetter && !attempt.coverLetter) return { ...base, status: "refused", message: "No cover letter was asked for. Call again without one.", coverage };

  const draft = { resume: input.resume, ...(input.coverLetter ? { coverLetter: input.coverLetter } : {}) };
  const result = validateDraft({ draft, claims: asValidationClaims(attempt.claims), postingText: postingText(snapshot.snapshot), coverLetterRequested: attempt.coverLetter });
  if (!result.ok) {
    return {
      ...base,
      status: "refused",
      message: `The runner refused ${plural(result.refusals.length, "sentence problem")}. Fix exactly what each one names, keep the other sentences as they are, and call again with the whole draft.`,
      problems: result.refusals.map((refusal) => ({ rule: refusal.rule, where: describeLocation(refusal.where), sentence: refusal.sentence, message: refusal.message })),
      coverage,
    };
  }
  return {
    ...base,
    status: "accepted",
    message: "Accepted. The runner saves the documents when this turn ends. Reply with one short line; don't repeat the documents.",
    coverage,
    draft,
  };
}

/**
 * Opens the stores against the runner's live workspace
 * (`process.env.RUNNER_WORKSPACE`), the pattern `extract-job-logic.ts`'s
 * `openJobsStore` uses. Directive-free, so either app root can import it.
 */
export async function openPreparationStores(): Promise<PreparationStores> {
  const dir = process.env.RUNNER_WORKSPACE;
  if (!dir) throw new Error("RUNNER_WORKSPACE is not set; the runner launcher sets it before the agent starts.");
  const workspace = await Workspace.open(dir);
  return { applications: new ApplicationsStore(workspace, systemClock), jobs: new JobsStore(workspace) };
}
