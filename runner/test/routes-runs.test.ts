import { randomUUID } from "node:crypto";
import { statusResponseSchema } from "@workflow-catalog/contracts";
import { describe, expect, it } from "vitest";
import { ROUTES_DIR } from "../lib/paths.ts";
import { loadRouteModules } from "../server/route-modules.ts";
import { pauseBudget, setBudgetLimits } from "../store/budget.ts";
import { finishRun, startRun, writePausedRun } from "../store/runs.ts";
import { BRIDGE, UI_TOKEN, makeBridge, pairDevice } from "./helpers.ts";

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
    expect(await response.json()).toEqual({ runs: [], invalidCount: 0 });
  });

  it("lists newest first, each with its file path", async () => {
    const bridge = await realBridge();
    const first = randomUUID();
    const { startedAt: startedFirst } = await startRun(bridge.workspace, bridge.clock, { runId: first, kind: "manual", isCatchUp: false, idempotencyKey: "k1", inputs: {} });
    await finishRun(bridge.workspace, bridge.clock, { runId: first, kind: "manual", isCatchUp: false, idempotencyKey: "k1", inputs: {}, startedAt: startedFirst, outcome: "success", model: "m", tokens: { input: 1, output: 1 } });
    bridge.clock.advance(1_000);
    const second = randomUUID();
    await writePausedRun(bridge.workspace, bridge.clock, { runId: second, kind: "manual", isCatchUp: false, idempotencyKey: "k2", inputs: {}, reason: "daily run limit reached (10)" });

    const response = await bridge.request("/api/runs", { headers: READ });
    const body = (await response.json()) as { runs: Array<{ runId: string; path: string; outcome: string }>; invalidCount: number };
    expect(body.runs.map((r) => r.runId)).toEqual([second, first]);
    expect(body.runs[0]!.path).toMatch(/^runs\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]+\.json$/);
    expect(body.invalidCount).toBe(0);
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
    expect(body).toMatchObject({ dailyRunLimit: 10, itemCap: 5, runsUsedToday: 0, paused: false, pausedReason: null, pausedSince: null });
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
});
