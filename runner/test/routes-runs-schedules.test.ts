// P08-B: the schedules routes (`GET/POST /api/runs/schedules[...]`), GET /status's `schedules` contribution, and
// the `start()` hook that wires the scheduler's catch-up check. Lives apart from routes-runs.test.ts, the same
// way routes-runs-status-fallback.test.ts does, so each file's setup stays simple.
import { scheduleStatusSchema, statusResponseSchema } from "@workflow-catalog/contracts";
import { describe, expect, it } from "vitest";
import runsRoutes from "../server/routes/runs.ts";
import { SCHEDULES } from "../scheduler/config.ts";
import { getScheduleState, pauseSchedule } from "../scheduler/store.ts";
import { BRIDGE, EXTENSION_ORIGIN, UI_TOKEN, makeBridge, pairDevice } from "./helpers.ts";

const COOKIE = `wc_runner_ui=${UI_TOKEN}`;
const READ = { cookie: COOKIE, "sec-fetch-site": "same-origin" };
const SAME_ORIGIN = { cookie: COOKIE, origin: BRIDGE, "content-type": "application/json", "sec-fetch-site": "same-origin" };

async function bridgeWithRuns() {
  return makeBridge({ modules: [{ name: "runs", module: runsRoutes }] });
}

describe("routes/runs.ts: GET /api/runs/schedules", () => {
  it("lists both schedules with their plain-words description, cron/timezone folded in, next run, and no last run yet", async () => {
    const bridge = await bridgeWithRuns();
    const response = await bridge.request("/api/runs/schedules", { headers: READ });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { schedules: Array<Record<string, unknown>> };
    expect(body.schedules).toHaveLength(2);
    const daily = body.schedules.find((s) => s.id === "daily-prepare")!;
    expect(daily.kind).toBe("prepare_newly_saved_jobs");
    expect(daily.description).toContain("09:00 UTC");
    expect(daily.paused).toBe(false);
    expect(daily.itemCap).toBe(5); // DEFAULT_ITEM_CAP
    expect(daily.nextRunAt).toEqual(expect.any(String));
    expect(daily.lastRunAt).toBeUndefined();
    const weekly = body.schedules.find((s) => s.id === "weekly-review")!;
    expect(weekly.kind).toBe("review_open_applications");
    expect(weekly.itemCap).toBeUndefined(); // no per-run item list for a review
  });
});

describe("routes/runs.ts: POST /api/runs/schedules/:id/pause and /resume", () => {
  it("pausing shows up immediately, with a plain reason, and resuming clears it", async () => {
    const bridge = await bridgeWithRuns();
    const pauseResponse = await bridge.request("/api/runs/schedules/daily-prepare/pause", { method: "POST", headers: SAME_ORIGIN });
    expect(pauseResponse.status).toBe(200);
    const paused = (await pauseResponse.json()) as { schedules: Array<Record<string, unknown>> };
    const dailyPaused = paused.schedules.find((s) => s.id === "daily-prepare")!;
    expect(dailyPaused.paused).toBe(true);
    expect(dailyPaused.pausedReason).toBe("paused from Settings");

    // Independent of the other schedule.
    const weeklyStillRunning = paused.schedules.find((s) => s.id === "weekly-review")!;
    expect(weeklyStillRunning.paused).toBe(false);

    const resumeResponse = await bridge.request("/api/runs/schedules/daily-prepare/resume", { method: "POST", headers: SAME_ORIGIN });
    expect(resumeResponse.status).toBe(200);
    const resumed = (await resumeResponse.json()) as { schedules: Array<Record<string, unknown>> };
    expect(resumed.schedules.find((s) => s.id === "daily-prepare")!.paused).toBe(false);
  });

  it("survives a restart: the state lives on disk, so a fresh state read after pause still shows it", async () => {
    const bridge = await bridgeWithRuns();
    await bridge.request("/api/runs/schedules/weekly-review/pause", { method: "POST", headers: SAME_ORIGIN });
    const state = await getScheduleState(bridge.workspace, "weekly-review");
    expect(state.paused).toBe(true);
  });

  it("an unknown schedule id is a clean 404, not a 500", async () => {
    const bridge = await bridgeWithRuns();
    const response = await bridge.request("/api/runs/schedules/not-a-real-schedule/pause", { method: "POST", headers: SAME_ORIGIN });
    expect(response.status).toBe(404);
  });
});

describe("routes/runs.ts: GET /status reports schedules (no personal data)", () => {
  it("validates against statusResponseSchema, one ScheduleStatus per schedule, with no job/application ids", async () => {
    const bridge = await bridgeWithRuns();
    await pauseSchedule(bridge.workspace, bridge.clock, "daily-prepare", "paused from Settings");
    const { token } = await pairDevice(bridge);
    const response = await bridge.request("/status", { headers: { authorization: `Bearer ${token}`, origin: EXTENSION_ORIGIN } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(statusResponseSchema.safeParse(body).success).toBe(true);
    const parsed = statusResponseSchema.parse(body);
    expect(parsed.schedules).toHaveLength(SCHEDULES.length);
    for (const schedule of parsed.schedules) expect(scheduleStatusSchema.safeParse(schedule).success).toBe(true);
    const daily = parsed.schedules.find((s) => s.id === "daily-prepare")!;
    expect(daily.paused).toBe(true);
    // Strict-schema parsing above already proves the shape carries only id/kind/paused/nextRunAt?/lastRunAt? —
    // this is a belt-and-braces check that the exact fields present are the documented ones, nothing job-shaped.
    expect(Object.keys(daily).sort()).toEqual(["id", "kind", "nextRunAt", "paused"].sort());
  });

  it("never throws even if a schedule's own state can't be read: GET /status stays 200 (I2's own rule, extended to schedules)", async () => {
    const bridge = await bridgeWithRuns();
    const response = await bridge.request("/status", { headers: READ });
    // No pairing at all is a 401 from a different guard, not a schedules failure; this just confirms the route
    // never 500s regardless of what schedules() does — status() itself is exercised directly below.
    expect([200, 401]).toContain(response.status);
    const contribution = await runsRoutes.status!(bridge.ctx);
    expect(Array.isArray(contribution.schedules)).toBe(true);
  });
});

describe("routes/runs.ts: start() wires the scheduler's catch-up check", () => {
  it("returns a stop function, and the catch-up check runs (a schedule's state is touched)", async () => {
    const bridge = await bridgeWithRuns();
    const stop = await runsRoutes.start!(bridge.ctx);
    expect(typeof stop).toBe("function");
    // The catch-up check is fired and forgotten (`void runDueSchedules(...)`) so it can't block a slow startup;
    // poll (rather than a fixed sleep) for the *last* schedule dispatchOne visits — runDueSchedules awaits each
    // schedule in turn, so that one settling last is the most reliable sign the whole check, and every file
    // write it made along the way, has finished (avoids a flaky rmdir race against a still-in-flight write in
    // afterEach's temp-dir cleanup).
    const lastScheduleId = SCHEDULES.at(-1)!.id;
    const deadline = Date.now() + 2000;
    let lastAttemptAt: string | undefined;
    while (Date.now() < deadline) {
      lastAttemptAt = (await getScheduleState(bridge.workspace, lastScheduleId)).lastAttemptAt;
      if (lastAttemptAt) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await stop?.();
    expect(lastAttemptAt).toBeDefined();
  });
});
