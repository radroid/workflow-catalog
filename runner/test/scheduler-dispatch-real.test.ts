import { describe, expect, it } from "vitest";
import { ManualClock, type Clock } from "../lib/clock.ts";
import { createRunnerContext, silentLogger, type RunnerLogger } from "../server/context.ts";
import { runDailyPrepare, runDueSchedules } from "../scheduler/dispatch.ts";
import { getScheduleState, pauseSchedule } from "../scheduler/store.ts";
import { ApplicationsStore } from "../store/applications.ts";
import { setBudgetLimits } from "../store/budget.ts";
import type { Workspace } from "../store/workspace.ts";
import { newWorkspace } from "./helpers.ts";
import { entries, GOOD_RESUME, platformLeadJob, scriptedModel, seedDetails, seedJob, seedReadyProfile, type Planner, type ScriptedModel } from "./preparation-helpers.ts";

/**
 * Gate fix round 1, B2: acceptance bullets 1, 2 and 4 previously mapped to
 * tests that stayed green with the real behaviour broken, because
 * `scheduler-dispatch.test.ts` mocks `startPreparation` and asserts only the
 * tally of its own mocked return value. These tests drive the real pipeline
 * instead — the real `startPreparation`/`waitForPreparationQueue`
 * (unmocked: no `vi.mock` anywhere in this file), P05's own
 * `checkPreparation` through a scripted model (`test/preparation-helpers.ts`,
 * the same helpers P05's own suite uses), and real documents on disk.
 *
 * Every job here is a copy of `platformLeadJob()`, whose three requirements
 * are each met by one of Ada Quill's own confirmed claims (C1, C3, C5) —
 * the same fixture and coverage `applications-routes.test.ts`'s `honest`
 * planner uses for its own single-turn happy path, reproduced locally and
 * minimally here since this file has no need for `honest`'s gap/leave-out
 * generality.
 */

const PLATFORM_LEAD_REQUIREMENTS = entries([{ status: "covered", claims: ["C1"] }, { status: "covered", claims: ["C3"] }, { status: "covered", claims: ["C5"] }]);

/** Always accepts on the first call, citing only claims confirmed by `seedReadyProfile`'s defaults. No revision, no cover letter — matching daily-prepare's own request shape (`coverLetter: false`). */
const readyPlanner: Planner = () => ({ skills: ["claim-matching", "resume-drafting"], calls: [{ requirements: PLATFORM_LEAD_REQUIREMENTS, resume: GOOD_RESUME }] });

async function baseContext(options: { readonly log?: RunnerLogger } = {}) {
  const clock = new ManualClock();
  const workspace = await newWorkspace(clock);
  await seedReadyProfile(workspace, clock);
  await seedDetails(workspace, clock);
  const model: ScriptedModel = scriptedModel(() => ({ workspace, clock }), readyPlanner);
  const ctx = createRunnerContext({
    workspace,
    clock,
    packageVersion: "0.1.0",
    model: { provider: "chatgpt", model: "gpt-5.6-luna" },
    eve: model.eve,
    log: options.log ?? silentLogger,
  });
  return { ctx, workspace, clock, model, applications: new ApplicationsStore(workspace, clock) };
}

function secondJob() {
  return { ...platformLeadJob(), url: "https://jobs.example/postings/fernwood-platform-lead-2" };
}

/** `seedJob` only writes the job snapshot; the schedule's own eligibility scan (`savedJobIds`, dispatch.ts) reads the *Application* record, so a Saved-stage one must exist too — the same two steps a person's own "Save this job" and the board take separately. */
async function seedSavedApplication(applications: ApplicationsStore, workspace: Workspace, clock: Clock, job: ReturnType<typeof platformLeadJob>): Promise<string> {
  const { jobId } = await seedJob(workspace, clock, job);
  await applications.ensureForJob(jobId);
  return jobId;
}

describe("scheduler/dispatch.ts over the real startPreparation (gate fix round 1, B2)", () => {
  it("Acceptance: two consecutive daily runs over the same inputs create zero new documents and zero new model turns (defeats M6)", async () => {
    const { ctx, model, applications } = await baseContext();
    const jobId = await seedSavedApplication(applications, ctx.workspace, ctx.clock, platformLeadJob());

    const first = await runDailyPrepare(ctx, { isCatchUp: false });
    expect(first.outcomes.started).toBe(1);
    expect(model.prompts.length).toBe(1); // exactly one real model turn

    const afterFirst = await applications.findByJob(jobId);
    expect(afterFirst?.stage).toBe("ready"); // a successful preparation moves it off "saved"
    const documentsAfterFirst = afterFirst?.documents.length ?? 0;
    expect(documentsAfterFirst).toBeGreaterThan(0);

    // Nothing new was saved: the schedule's own eligibility scan (Saved-stage only) is what must keep this a
    // no-op, not a "same inputs, already prepared" branch — a correct daily-prepare finds zero eligible jobs
    // here, since the one job it prepared is now "ready". M6 (also re-prepares "ready" jobs, with a cover
    // letter) breaks exactly this.
    const second = await runDailyPrepare(ctx, { isCatchUp: false });
    expect(second.attempted).toBe(0);
    expect(second.outcomes.started).toBe(0);
    expect(model.prompts.length).toBe(1); // zero *new* model turns

    const afterSecond = await applications.findByJob(jobId);
    expect(afterSecond?.documents.length).toBe(documentsAfterFirst); // zero new documents
  });

  it("Acceptance: a runner down across several missed daily fires still runs exactly one catch-up — proved by the exact claim files, not just the last-attempt fields (defeats M1b/M1)", async () => {
    const { ctx, workspace, clock, model } = await baseContext();
    // Kept out of this probe: runDueSchedules dispatches both schedules every check, and weekly-review's own
    // turn would otherwise add unrelated calls to `model.prompts`.
    await pauseSchedule(workspace, clock, "weekly-review", "kept out of this probe");
    const applicationsForSeed = new ApplicationsStore(workspace, clock);

    const jobA = await seedSavedApplication(applicationsForSeed, workspace, clock, platformLeadJob());
    const first = await runDueSchedules(ctx, new Date("2026-09-20T09:00:00.000Z")); // on time
    const dailyFirst = first.find((outcome) => outcome.id === "daily-prepare");
    expect(dailyFirst?.ran).toBe(true);
    expect(dailyFirst?.isCatchUp).toBe(false);
    expect(model.prompts.length).toBe(1);

    // The runner is down 09-21..09-24: no calls happen at all (a stopped process makes none — this loop never
    // calls runDueSchedules for those dates). A second job is saved during the outage: the exact thing the
    // catch-up must still pick up, so "the run count" below is a real, non-trivial assertion.
    const jobB = await seedSavedApplication(applicationsForSeed, workspace, clock, secondJob());

    const second = await runDueSchedules(ctx, new Date("2026-09-25T12:00:00.000Z")); // several days late
    const dailySecond = second.find((outcome) => outcome.id === "daily-prepare");
    expect(dailySecond?.ran).toBe(true);
    expect(dailySecond?.isCatchUp).toBe(true); // more than 5 minutes past the 09:00 UTC fire
    expect(model.prompts.length).toBe(2); // exactly one more real turn: job B, once

    // The exact claim files: never 09-21, 09-22, 09-23 or 09-24 — the precise bug M1b/M1 introduce (a loop over
    // every missed slot, not just the latest one). getScheduleState's own lastSlotId/lastAttemptAt cannot tell
    // "ran once" from "ran five times" apart, since recordAttempt overwrites both on every call; the claim
    // files on disk are the one place that distinction is visible.
    const claims = await workspace.list("scheduler", "claims");
    expect(claims).toEqual(["daily-prepare--2026-09-20.json", "daily-prepare--2026-09-25.json"]);

    const applications = new ApplicationsStore(workspace, clock);
    expect((await applications.findByJob(jobA))?.stage).toBe("ready");
    expect((await applications.findByJob(jobB))?.stage).toBe("ready");
  });

  it("Acceptance: the per-run item cap stops the run — remaining items stay Saved, and the reason is in both the run summary and a captured log (defeats M3b)", async () => {
    const logs: string[] = [];
    const { ctx, workspace, clock } = await baseContext({ log: { ...silentLogger, info: (message) => logs.push(message) } });
    await setBudgetLimits(workspace, { dailyRunLimit: 10, itemCap: 1 });
    await pauseSchedule(workspace, clock, "weekly-review", "kept out of this probe");
    const applicationsForSeed = new ApplicationsStore(workspace, clock);

    const jobA = await seedSavedApplication(applicationsForSeed, workspace, clock, platformLeadJob());
    const jobB = await seedSavedApplication(applicationsForSeed, workspace, clock, secondJob());

    const outcomes = await runDueSchedules(ctx, new Date("2026-09-22T09:00:00.000Z"));
    expect(outcomes.find((outcome) => outcome.id === "daily-prepare")?.ran).toBe(true);

    // The reason surfaces in two independent places, in two different sentence positions (the log line is its
    // own standalone sentence, lower-case "stopped"; the recorded summary appends it after other clauses,
    // capitalized) — M3b drops one line or the other (or both) without failing anything else in the suite.
    expect(logs.some((line) => line.includes("stopped at the per-run cap (1); 1 job stay Saved."))).toBe(true);
    const state = await getScheduleState(workspace, "daily-prepare");
    expect(state.lastSummary).toContain("Stopped at the per-run cap (1); 1 job stay Saved.");

    const applications = new ApplicationsStore(workspace, clock);
    const stages = (await Promise.all([applications.findByJob(jobA), applications.findByJob(jobB)])).map((application) => application?.stage).sort();
    expect(stages).toEqual(["ready", "saved"]); // one prepared, one left Saved by the cap — not refused, not skipped
  });
});
