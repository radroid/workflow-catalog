import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkPreparation, postingText, requirementsDigest, type PreparationStores } from "../agent/lib/prepare-logic.ts";
import type { PrepareApplicationInput } from "../agent/lib/prepare-schema.ts";
import { ManualClock } from "../lib/clock.ts";
import { ApplicationsStore, type PreparationRecord } from "../store/applications.ts";
import { JobsStore } from "../store/jobs.ts";
import type { Workspace } from "../store/workspace.ts";
import { labelClaims } from "../validate/claims.ts";
import { newWorkspace } from "./helpers.ts";
import {
  DRAFT_WITH_EXCLUDED_METRIC,
  entries,
  EXCLUDED_METRIC,
  FIXTURE_CLAIMS,
  fixtureJob,
  GOOD_COVER_LETTER,
  GOOD_RESUME,
  HOSTILE_JOB,
  INJECTION_PHRASES,
  platformLeadJob,
  profileFilesHash,
  seedJob,
  seedReadyProfile,
} from "./preparation-helpers.ts";

/**
 * `prepare_application`'s behaviour (`checkPreparation`), against real
 * stores over a private workspace (P05). The tool reads the attempt the
 * bridge started and the job revision it names; it answers refused,
 * questions or accepted, and never writes anything.
 */

const LABELLED = labelClaims(FIXTURE_CLAIMS).map((claim) => ({ label: claim.label, id: claim.id, kind: claim.kind, status: claim.status, text: claim.text }));

interface Fixture {
  readonly workspace: Workspace;
  readonly clock: ManualClock;
  readonly stores: PreparationStores;
  readonly taskId: string;
  readonly jobId: string;
}

async function fixture(options: { job?: ReturnType<typeof platformLeadJob>; attempt?: Partial<PreparationRecord>; noAttempt?: boolean } = {}): Promise<Fixture> {
  const clock = new ManualClock();
  const workspace = await newWorkspace(clock);
  const job = options.job ?? platformLeadJob();
  const { jobId, revision } = await seedJob(workspace, clock, job);
  const applications = new ApplicationsStore(workspace, clock);
  const { application } = await applications.ensureForJob(jobId);
  const requirements = job.structured.requirements ?? [];
  if (!options.noAttempt) {
    const now = clock.now().toISOString();
    await applications.writePreparation(application.taskId, {
      attemptId: randomUUID(),
      status: "running",
      idempotencyKey: `${jobId}@${revision}+profile@v1+resume+inputs@000000000000`,
      jobId,
      jobRevision: revision,
      profileVersion: 1,
      coverLetter: false,
      claims: LABELLED,
      requirementsDigest: requirementsDigest(requirements),
      requirementCount: requirements.length,
      answers: [],
      questions: [],
      problems: [],
      startedAt: now,
      updatedAt: now,
      ...options.attempt,
    });
  }
  return { workspace, clock, stores: { applications, jobs: new JobsStore(workspace) }, taskId: application.taskId, jobId };
}

function call(f: Fixture, input: Omit<PrepareApplicationInput, "taskId">) {
  return checkPreparation({ taskId: f.taskId, ...input }, f.stores);
}

const COVERED = entries([
  { status: "covered", claims: ["C1"] },
  { status: "covered", claims: ["C3"] },
  { status: "covered", claims: ["C5"] },
]);

/** Every file under the workspace root, by relative path and content hash. */
async function workspaceSnapshot(workspace: Workspace): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of await readdir(workspace.root, { recursive: true })) {
    const file = path.join(workspace.root, name);
    if (!(await stat(file)).isFile()) continue;
    out[name] = createHash("sha256").update(await readFile(file)).digest("hex");
  }
  return out;
}

describe("checkPreparation: which preparation it checks", () => {
  it("refuses when this application isn't being prepared right now", async () => {
    const none = await fixture({ noAttempt: true });
    expect(await call(none, { requirements: COVERED, resume: GOOD_RESUME })).toEqual({
      taskId: none.taskId,
      status: "refused",
      message: "This application isn't being prepared right now, so nothing was checked.",
    });
    const parked = await fixture({ attempt: { status: "parked" } });
    expect((await call(parked, { requirements: COVERED, resume: GOOD_RESUME })).status).toBe("refused");
    const done = await fixture({ attempt: { status: "done" } });
    expect((await call(done, { requirements: COVERED, resume: GOOD_RESUME })).message).toBe("This application isn't being prepared right now, so nothing was checked.");
  });

  it("refuses when the job's requirements changed since the preparation started", async () => {
    const f = await fixture({ attempt: { requirementsDigest: requirementsDigest(["Something else entirely"]) } });
    const output = await call(f, { requirements: COVERED, resume: GOOD_RESUME });
    expect(output.status).toBe("refused");
    expect(output.message).toBe("The job's requirements changed while this was being prepared. Stop here; the person can prepare it again.");
  });
});

describe("checkPreparation: every requirement accounted for", () => {
  const cases: Array<[string, PrepareApplicationInput["requirements"], Record<string, never> | { answers: PreparationRecord["answers"] }, string]> = [
    ["a requirement left out", COVERED.slice(0, 2), {}, "Requirement 3 isn't accounted for: mark it covered, a gap with a question, or not a requirement."],
    ["a requirement that doesn't exist", [...COVERED, { requirement: 4, status: "not_a_requirement" }], {}, "There is no requirement 4; the posting lists 3 requirements."],
    ["a requirement twice", [...COVERED, { requirement: 1, status: "covered", claims: ["C1"] }], {}, "Requirement 1 is listed twice. Give it one entry."],
    ["covered with no claims", [{ requirement: 1, status: "covered", claims: [] }, ...COVERED.slice(1)], {}, "A covered requirement names the labels of the confirmed claims that meet it."],
    ["covered by a label it was never given", [{ requirement: 1, status: "covered", claims: ["C99"] }, ...COVERED.slice(1)], {}, "C99 isn't one of the confirmed claims you were given."],
    ["covered by the excluded claim", [{ requirement: 1, status: "covered", claims: ["C2"] }, ...COVERED.slice(1)], {}, "C2 isn't one of the confirmed claims you were given."],
    ["covered by a claim still undecided", [{ requirement: 1, status: "covered", claims: ["C4"] }, ...COVERED.slice(1)], {}, "C4 isn't one of the confirmed claims you were given."],
    ["covered, with a question", [{ requirement: 1, status: "covered", claims: ["C1"], question: "Really?" }, ...COVERED.slice(1)], {}, "A covered requirement has no question. Mark it a gap if the claims don't meet it."],
    ["a gap without a question", [{ requirement: 1, status: "gap" }, ...COVERED.slice(1)], {}, "A gap needs one short question for the person."],
    ["left out without the person saying so", [{ requirement: 1, status: "left_out" }, ...COVERED.slice(1)], {}, "The person hasn't said to leave requirement 1 out. Mark it covered, or a gap with a question."],
    [
      "a gap the person already answered",
      [{ requirement: 1, status: "gap", question: "Anything?" }, ...COVERED.slice(1)],
      { answers: [{ requirement: 1, question: "Anything?", answer: "leave_out", answeredAt: "2026-09-22T09:00:00.000Z" }] },
      "The person already answered requirement 1: leave it out. Mark it left_out.",
    ],
    ["a set-aside line with claims", [...COVERED.slice(0, 2), { requirement: 3, status: "not_a_requirement", claims: ["C5"] }], {}, "A line that isn't a requirement takes no claims and no question."],
  ];

  it.each(cases)("refuses %s, naming the requirement", async (_name, requirements, attempt, message) => {
    const f = await fixture({ attempt });
    const output = await call(f, { requirements, resume: GOOD_RESUME });
    expect(output.status).toBe("refused");
    expect(output.problems).toContainEqual(expect.objectContaining({ rule: "requirements", message }));
    expect(output.draft).toBeUndefined();
  });

  it("gives the excluded claim's label the same words as a label it never had, so the refusal says nothing about it", async () => {
    const f = await fixture();
    const excluded = await call(f, { requirements: [{ requirement: 1, status: "covered", claims: ["C2"] }, ...COVERED.slice(1)], resume: GOOD_RESUME });
    const unknown = await call(f, { requirements: [{ requirement: 1, status: "covered", claims: ["C99"] }, ...COVERED.slice(1)], resume: GOOD_RESUME });
    expect(excluded.problems?.[0]?.message.replace("C2", "C#")).toBe(unknown.problems?.[0]?.message.replace("C99", "C#"));
    expect(JSON.stringify(excluded)).not.toContain(EXCLUDED_METRIC.text);
    expect(JSON.stringify(excluded)).not.toContain(EXCLUDED_METRIC.id);
  });
});

describe("checkPreparation: gap questions", () => {
  it("answers with the questions, and checks no draft, when any requirement is a gap", async () => {
    const f = await fixture();
    const requirements = entries([{ status: "gap", question: "Which team did you lead?" }, { status: "covered", claims: ["C3"] }, { status: "gap", question: "Which projects do you maintain?" }]);
    const output = await call(f, { requirements, resume: DRAFT_WITH_EXCLUDED_METRIC });
    expect(output).toMatchObject({
      status: "questions",
      message: "2 questions recorded for the person. Stop here and write no documents: the runner asks, and preparation continues once they answer.",
      questions: [
        { requirement: 1, question: "Which team did you lead?" },
        { requirement: 3, question: "Which projects do you maintain?" },
      ],
    });
    expect(output.problems).toBeUndefined();
    expect(output.draft).toBeUndefined();
  });
});

describe("checkPreparation: the draft", () => {
  it("asks for the resume once every requirement is accounted for", async () => {
    const f = await fixture();
    const output = await call(f, { requirements: COVERED });
    expect(output).toMatchObject({ status: "refused", message: "Every requirement is accounted for, so write the resume now and call again with it." });
  });

  it("refuses a cover letter nobody asked for, and asks for one that was", async () => {
    const unasked = await fixture();
    expect((await call(unasked, { requirements: COVERED, resume: GOOD_RESUME, coverLetter: GOOD_COVER_LETTER })).message).toBe("No cover letter was asked for. Call again without one.");
    const asked = await fixture({ attempt: { coverLetter: true } });
    const output = await call(asked, { requirements: COVERED, resume: GOOD_RESUME });
    expect(output.status).toBe("refused");
    expect(output.problems).toContainEqual(expect.objectContaining({ rule: "empty", where: "Cover letter, paragraph 1, sentence 1" }));
  });

  it("refuses a draft sentence by sentence, by place and rule, never naming the excluded claim it drew on", async () => {
    const f = await fixture();
    const output = await call(f, { requirements: COVERED, resume: DRAFT_WITH_EXCLUDED_METRIC });
    expect(output.status).toBe("refused");
    expect(output.message).toMatch(/^The runner refused \d+ sentence problems?\. Fix exactly what each one names/);
    expect(output.problems).toContainEqual(expect.objectContaining({ rule: "excluded_claim", where: "Resume, Projects, bullet 1" }));
    expect(output.problems).toContainEqual(expect.objectContaining({ rule: "number", where: "Resume, Projects, bullet 1" }));
    for (const problem of output.problems ?? []) {
      expect(problem.message).not.toContain("Grew signups");
      expect(problem.message).not.toContain(EXCLUDED_METRIC.id);
    }
    expect(output.draft).toBeUndefined();
  });

  it("accepts a draft that states only what its cited claims say, and hands it back for the bridge to export", async () => {
    const f = await fixture({ attempt: { coverLetter: true } });
    const output = await call(f, { requirements: COVERED, resume: GOOD_RESUME, coverLetter: GOOD_COVER_LETTER });
    expect(output).toMatchObject({ taskId: f.taskId, status: "accepted", draft: { resume: GOOD_RESUME, coverLetter: GOOD_COVER_LETTER } });
    expect(output.coverage).toEqual([
      { requirement: 1, status: "covered", labels: ["C1"] },
      { requirement: 2, status: "covered", labels: ["C3"] },
      { requirement: 3, status: "covered", labels: ["C5"] },
    ]);
  });

  it("checks the draft against the posting it prepares for: copied posting wording is refused", async () => {
    const f = await fixture();
    const posting = postingText((await f.stores.jobs.getSnapshot(f.jobId, 1))!);
    expect(posting).toContain("run the team behind our internal developer tools");
    const copying = { sections: [{ heading: "Summary", statements: ["Ran the team behind our internal developer tools at Northwind Labs [C1]."] }] };
    const output = await call(f, { requirements: COVERED, resume: copying });
    expect(output.status).toBe("refused");
    expect(output.problems).toContainEqual(expect.objectContaining({ rule: "posting_wording", where: "Resume, Summary, bullet 1" }));
  });
});

describe("checkPreparation never writes", () => {
  it("leaves the workspace byte-for-byte as it was, whatever it answers", async () => {
    const f = await fixture();
    await seedReadyProfile(f.workspace, f.clock);
    const before = await workspaceSnapshot(f.workspace);
    await call(f, { requirements: COVERED.slice(0, 1), resume: GOOD_RESUME });
    await call(f, { requirements: entries([{ status: "gap", question: "Which team?" }, { status: "covered", claims: ["C3"] }, { status: "covered", claims: ["C5"] }]) });
    await call(f, { requirements: COVERED, resume: DRAFT_WITH_EXCLUDED_METRIC });
    await call(f, { requirements: COVERED, resume: GOOD_RESUME });
    expect(await workspaceSnapshot(f.workspace)).toEqual(before);
  });

  it("the hostile posting: its injected line is set aside, nothing it answers repeats it, and the profile is untouched", async () => {
    const f = await fixture({
      job: fixtureJob(HOSTILE_JOB),
      attempt: {
        answers: [
          { requirement: 1, question: "How many years?", answer: "leave_out", answeredAt: "2026-09-22T09:00:00.000Z" },
          { requirement: 2, question: "Which work used Node.js?", answer: "leave_out", answeredAt: "2026-09-22T09:00:00.000Z" },
        ],
      },
    });
    await seedReadyProfile(f.workspace, f.clock);
    const profileBefore = await profileFilesHash(f.workspace);
    const output = await call(f, { requirements: entries([{ status: "left_out" }, { status: "left_out" }, { status: "not_a_requirement" }]), resume: GOOD_RESUME });
    expect(output.status).toBe("accepted");
    const text = JSON.stringify(output).toLowerCase();
    for (const phrase of INJECTION_PHRASES) expect(text).not.toContain(phrase.toLowerCase());
    expect(await profileFilesHash(f.workspace)).toBe(profileBefore);
  });
});
