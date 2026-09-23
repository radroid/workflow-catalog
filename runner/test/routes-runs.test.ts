import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { statusResponseSchema } from "@workflow-catalog/contracts";
import { describe, expect, it } from "vitest";
import { ROUTES_DIR } from "../lib/paths.ts";
import { loadRouteModules } from "../server/route-modules.ts";
import { CORRUPT_BUDGET_REASON, pauseBudget, REPAIRED_BUDGET_REASON, runLogUnreadableReason, setBudgetLimits } from "../store/budget.ts";
import { finishRun, localDateString, startRun, writePausedRun } from "../store/runs.ts";
import { BRIDGE, EXTENSION_ORIGIN, UI_TOKEN, makeBridge, pairDevice } from "./helpers.ts";

/** chmod can only deny access to a non-root user on a POSIX filesystem; CI (ubuntu, non-root) and macOS qualify. */
const canDenyAccess = process.platform !== "win32" && process.getuid?.() !== 0;

const COOKIE = `wc_runner_ui=${UI_TOKEN}`;
const SAME_ORIGIN = { cookie: COOKIE, origin: BRIDGE, "content-type": "application/json", "sec-fetch-site": "same-origin" };
const READ = { cookie: COOKIE, "sec-fetch-site": "same-origin" };

async function realBridge() {
  return makeBridge({ modules: await loadRouteModules(ROUTES_DIR) });
}

describe("routes/runs.ts: GET /api/runs", () => {
  it("empty state: no runs yet", async () => {
    const bridge = await realBridge();
    const response = await bridge.request("/api/runs", { headers: READ });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ runs: [], invalidCount: 0, skippedFiles: [] });
  });

  it("lists newest first, each with its file path and absolute path (G8)", async () => {
    const bridge = await realBridge();
    const first = randomUUID();
    const { startedAt: startedFirst } = await startRun(bridge.workspace, bridge.clock, { runId: first, kind: "manual", isCatchUp: false, idempotencyKey: "k1", inputs: {} });
    await finishRun(bridge.workspace, bridge.clock, { runId: first, kind: "manual", isCatchUp: false, idempotencyKey: "k1", inputs: {}, startedAt: startedFirst, outcome: "success", model: "m", tokens: { input: 1, output: 1 } });
    bridge.clock.advance(1_000);
    const second = randomUUID();
    await writePausedRun(bridge.workspace, bridge.clock, { runId: second, kind: "manual", isCatchUp: false, idempotencyKey: "k2", inputs: {}, reason: "daily run limit reached (10)" });

    const response = await bridge.request("/api/runs", { headers: READ });
    const body = (await response.json()) as { runs: Array<{ runId: string; path: string; absolutePath: string; outcome: string }>; invalidCount: number; skippedFiles: string[] };
    expect(body.runs.map((r) => r.runId)).toEqual([second, first]);
    expect(body.runs[0]!.path).toMatch(/^runs\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]+\.json$/);
    expect(body.runs[0]!.absolutePath).toBe(bridge.workspace.resolve(...body.runs[0]!.path.split("/")));
    expect(body.invalidCount).toBe(0);
    expect(body.skippedFiles).toEqual([]);
  });

  it("G9: skippedFiles names invalid files as relative paths, up to 10", async () => {
    const bridge = await realBridge();
    const good = randomUUID();
    await writePausedRun(bridge.workspace, bridge.clock, { runId: good, kind: "manual", isCatchUp: false, idempotencyKey: "good", inputs: {}, reason: "r" });
    const date = localDateString(bridge.clock.now());
    const badFile = `${randomUUID()}.json`;
    await writeFile(bridge.workspace.resolve("runs", date, badFile), "{ not json", "utf8");

    const response = await bridge.request("/api/runs", { headers: READ });
    const body = (await response.json()) as { runs: unknown[]; invalidCount: number; skippedFiles: string[] };
    expect(body.invalidCount).toBe(1);
    expect(body.skippedFiles).toEqual([`runs/${date}/${badFile}`]);
  });

  it("401 without the cookie, 403 for a cross-site request", async () => {
    const bridge = await realBridge();
    expect((await bridge.request("/api/runs")).status).toBe(401);
    expect((await bridge.request("/api/runs", { headers: { cookie: COOKIE, "sec-fetch-site": "cross-site" } })).status).toBe(403);
  });
});

describe("routes/runs.ts: GET /api/runs/:runId", () => {
  it("returns the full record plus its path", async () => {
    const bridge = await realBridge();
    const runId = randomUUID();
    const { startedAt } = await startRun(bridge.workspace, bridge.clock, { runId, kind: "manual", isCatchUp: false, idempotencyKey: "k", inputs: { note: "x" } });
    await finishRun(bridge.workspace, bridge.clock, { runId, kind: "manual", isCatchUp: false, idempotencyKey: "k", inputs: { note: "x" }, startedAt, outcome: "success", model: "gpt-5.6-luna", tokens: { input: 4, output: 2 } });

    const response = await bridge.request(`/api/runs/${runId}`, { headers: READ });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { runId: string; outcome: string; model: string; path: string };
    expect(body).toMatchObject({ runId, outcome: "success", model: "gpt-5.6-luna" });
    expect(body.path).toContain(`${runId}.json`);
  });

  it("404 for a well-formed uuid with no run", async () => {
    const bridge = await realBridge();
    const response = await bridge.request(`/api/runs/${randomUUID()}`, { headers: READ });
    expect(response.status).toBe(404);
  });

  it("404 for a runId that is not a uuid", async () => {
    const bridge = await realBridge();
    const response = await bridge.request("/api/runs/not-a-uuid", { headers: READ });
    expect(response.status).toBe(404);
  });
});

describe("routes/runs.ts: GET/POST /api/runs/budget", () => {
  it("GET reports the defaults with no runs used", async () => {
    const bridge = await realBridge();
    const response = await bridge.request("/api/runs/budget", { headers: READ });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ dailyRunLimit: 10, itemCap: 5, runsUsedToday: 0, paused: false, pausedReason: null, pausedSince: null, corrupt: false, corruptOrigin: false });
  });

  it("G9/I4: a corrupt file reports corrupt and corruptOrigin true; a Save-repair keeps the pause with a reason that's true now, and the Resume that follows keeps the saved limits", async () => {
    const bridge = await realBridge();
    await writeFile(bridge.workspace.resolve("runs", "budget.json"), "{ broken", "utf8");
    const corrupt = await bridge.request("/api/runs/budget", { headers: READ });
    expect(await corrupt.json()).toMatchObject({ paused: true, pausedReason: CORRUPT_BUDGET_REASON, pauseKind: "budget_unreadable", corrupt: true, corruptOrigin: true, dailyRunLimit: 10, itemCap: 5 });

    const saved = await bridge.request("/api/runs/budget", { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({ dailyRunLimit: 12, itemCap: 4 }) });
    // Decision 2: Save repairs the file (now schema-valid) but keeps the pause until Resume. The file is readable
    // now, so the reason says it *was* unreadable (I4), and pauseKind tells Settings which notice to show.
    expect(await saved.json()).toMatchObject({ paused: true, pausedReason: REPAIRED_BUDGET_REASON, pauseKind: "budget_repaired", corrupt: false, corruptOrigin: true, dailyRunLimit: 12, itemCap: 4 });

    const resumed = await bridge.request("/api/runs/budget/resume", { method: "POST", headers: SAME_ORIGIN, body: "{}" });
    // The file was readable when Resume ran, so no defaults were written: the saved 12 and 4 stand (I4).
    expect(await resumed.json()).toMatchObject({ paused: false, pauseKind: null, corrupt: false, corruptOrigin: false, restoredDefaults: false, dailyRunLimit: 12, itemCap: 4 });
  });

  it("I4: Resume on a file that is unreadable at that moment writes the defaults and reports restoredDefaults", async () => {
    const bridge = await realBridge();
    await writeFile(bridge.workspace.resolve("runs", "budget.json"), "{ broken", "utf8");
    const resumed = await bridge.request("/api/runs/budget/resume", { method: "POST", headers: SAME_ORIGIN, body: "{}" });
    expect(await resumed.json()).toMatchObject({ paused: false, restoredDefaults: true, dailyRunLimit: 10, itemCap: 5 });
  });

  it("POST saves new limits within bounds", async () => {
    const bridge = await realBridge();
    const response = await bridge.request("/api/runs/budget", { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({ dailyRunLimit: 25, itemCap: 7 }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ dailyRunLimit: 25, itemCap: 7 });
    const reread = await bridge.request("/api/runs/budget", { headers: READ });
    expect(await reread.json()).toMatchObject({ dailyRunLimit: 25, itemCap: 7 });
  });

  it("400 for an out-of-range value", async () => {
    const bridge = await realBridge();
    const tooHigh = await bridge.request("/api/runs/budget", { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({ dailyRunLimit: 51, itemCap: 5 }) });
    expect(tooHigh.status).toBe(400);
    const tooLow = await bridge.request("/api/runs/budget", { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({ dailyRunLimit: 10, itemCap: 0 }) });
    expect(tooLow.status).toBe(400);
    const unknownKey = await bridge.request("/api/runs/budget", { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({ dailyRunLimit: 10, itemCap: 5, extra: true }) });
    expect(unknownKey.status).toBe(400);
  });

  it("413 for an oversized body", async () => {
    const bridge = await realBridge();
    const response = await bridge.request("/api/runs/budget", {
      method: "POST",
      headers: SAME_ORIGIN,
      body: JSON.stringify({ dailyRunLimit: 10, itemCap: 5, padding: "x".repeat(4096) }),
    });
    expect(response.status).toBe(413);
  });

  it("Save keeps an existing pause until Resume, which then clears it", async () => {
    const bridge = await realBridge();
    await pauseBudget(bridge.workspace, bridge.clock, "provider limit");
    const saved = await bridge.request("/api/runs/budget", { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({ dailyRunLimit: 12, itemCap: 4 }) });
    expect(await saved.json()).toMatchObject({ paused: true, pausedReason: "provider limit", dailyRunLimit: 12, itemCap: 4 });

    const resumed = await bridge.request("/api/runs/budget/resume", { method: "POST", headers: SAME_ORIGIN, body: "{}" });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ paused: false, dailyRunLimit: 12, itemCap: 4 });
  });

  it("401/403 protect the budget routes the same as every other /api route", async () => {
    const bridge = await realBridge();
    expect((await bridge.request("/api/runs/budget")).status).toBe(401);
    expect((await bridge.request("/api/runs/budget", { headers: { cookie: COOKIE, "sec-fetch-site": "same-site" } })).status).toBe(403);
  });
});

describe("routes/runs.ts: status(ctx) contributes budget to GET /status", () => {
  it("validates against statusResponseSchema and reflects the current budget", async () => {
    const bridge = await realBridge();
    await setBudgetLimits(bridge.workspace, { dailyRunLimit: 17, itemCap: 6 });
    const { token } = await pairDevice(bridge);
    const response = await bridge.request("/status", { headers: { authorization: `Bearer ${token}`, origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" } });
    expect(response.status).toBe(200);
    const body = await response.json();
    const parsed = statusResponseSchema.safeParse(body);
    expect(parsed.success, parsed.success ? "" : JSON.stringify((parsed as { error: { issues: unknown } }).error.issues)).toBe(true);
    expect((body as { budget: { dailyRunLimit: number; itemCap?: number } }).budget).toMatchObject({ dailyRunLimit: 17, runsUsedToday: 0, paused: false });
  });

  it.skipIf(!canDenyAccess)("I2: with today's run folder unreadable, /status stays 200 and reports the pause; the budget and list routes stay 200", async () => {
    const bridge = await realBridge();
    const { token } = await pairDevice(bridge);
    const date = localDateString(bridge.clock.now());
    const today = bridge.workspace.resolve("runs", date);
    await mkdir(today, { recursive: true });
    await chmod(today, 0o000);
    try {
      const status = await bridge.request("/status", { headers: { authorization: `Bearer ${token}`, origin: EXTENSION_ORIGIN } });
      expect(status.status).toBe(200);
      const body = await status.json();
      expect(statusResponseSchema.safeParse(body).success).toBe(true);
      expect((body as { budget: unknown }).budget).toEqual({ dailyRunLimit: 10, runsUsedToday: 0, paused: true, pausedReason: runLogUnreadableReason(date) });

      const budget = await bridge.request("/api/runs/budget", { headers: READ });
      expect(budget.status).toBe(200);
      expect(await budget.json()).toMatchObject({ paused: true, pauseKind: "run_log_unreadable", runLogUnreadable: true, pausedReason: `run log unreadable (runs/${date}/)` });

      const list = await bridge.request("/api/runs", { headers: READ });
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual({ runs: [], invalidCount: 1, skippedFiles: [`runs/${date}/`] });
    } finally {
      await chmod(today, 0o700);
    }
  });

  it.skipIf(!canDenyAccess)("I2: with all of runs/ unreadable, /status and the run list both stay 200", async () => {
    const bridge = await realBridge();
    const { token } = await pairDevice(bridge);
    const runs = bridge.workspace.resolve("runs");
    await chmod(runs, 0o000);
    try {
      const status = await bridge.request("/status", { headers: { authorization: `Bearer ${token}`, origin: EXTENSION_ORIGIN } });
      expect(status.status).toBe(200);
      expect(statusResponseSchema.safeParse(await status.json()).success).toBe(true);
      const list = await bridge.request("/api/runs", { headers: READ });
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual({ runs: [], invalidCount: 1, skippedFiles: ["runs/"] });
    } finally {
      await chmod(runs, 0o700);
    }
  });

  it("G8: /status's budget never carries corrupt/corruptOrigin/absolutePath — statusResponseSchema is .strict()", async () => {
    // statusResponseSchema (and budgetStatusSchema nested inside it) are .strict(): the safeParse above already
    // proves no extra field is present, but this spells out the specific fields G8 says must never leak here.
    const bridge = await realBridge();
    const { token } = await pairDevice(bridge);
    const response = await bridge.request("/status", { headers: { authorization: `Bearer ${token}`, origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" } });
    const body = (await response.json()) as { budget: Record<string, unknown> };
    expect(body.budget.corrupt).toBeUndefined();
    expect(body.budget.corruptOrigin).toBeUndefined();
    expect(body.budget.absolutePath).toBeUndefined();
  });
});
