import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROUTES_DIR } from "../lib/paths.ts";
import { startModules } from "../server/app.ts";
import {
  buildEventRegistry,
  defineRouteModule,
  loadRouteModules,
  RouteModuleError,
  validateRouteModule,
  type LoadedRouteModule,
  type RouteModule,
} from "../server/route-modules.ts";
import { jobCapture, makeBridge, pairDevice, postEvent } from "./helpers.ts";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "route-modules");

describe("route modules", () => {
  it("loads *.ts files in name order, skipping _helpers and *.test.ts", async () => {
    const modules = await loadRouteModules(path.join(FIXTURES, "ok"));
    expect(modules.map((m) => m.name)).toEqual(["alpha", "beta-two"]);
  });

  it("mounts a module's API at /api/<file name> and dispatches its event handlers", async () => {
    const modules = await loadRouteModules(path.join(FIXTURES, "ok"));
    const bridge = await makeBridge({ modules });
    const api = await bridge.request("/api/alpha", { headers: { cookie: "wc_runner_ui=ui-token-for-tests-0123456789abcdefghijklmn" } });
    expect(await api.json()).toEqual({ module: "alpha" });
    const { token } = await pairDevice(bridge);
    const event = jobCapture();
    const response = await postEvent(bridge, token, event);
    expect(await response.json()).toMatchObject({ outcome: "handled", result: { seen: event.eventId } });
  });

  it("runs start hooks and returns their stop functions", async () => {
    const modules = await loadRouteModules(path.join(FIXTURES, "ok"));
    const { started } = (await import("./fixtures/route-modules/ok/beta-two.ts")) as { started: string[] };
    const bridge = await makeBridge({ modules });
    const stops = await startModules(bridge.ctx, modules);
    expect(started).toContain("beta-two");
    for (const stop of stops) await stop();
    expect(started).toContain("beta-two stopped");
  });

  it("stops the modules already started, newest first, when a later start hook fails", async () => {
    const calls: string[] = [];
    const starting = (name: string, start: NonNullable<RouteModule["start"]>): LoadedRouteModule => ({ name, module: defineRouteModule({ start }) });
    const modules = [
      starting("alpha", () => {
        calls.push("alpha started");
        return () => void calls.push("alpha stopped");
      }),
      starting("beta", () => {
        calls.push("beta started");
        return () => {
          calls.push("beta stopping");
          throw new Error("beta could not stop");
        };
      }),
      starting("gamma", () => void calls.push("gamma started")), // no stop function
      starting("delta", async () => {
        calls.push("delta started");
        return async () => void calls.push("delta stopped");
      }),
      starting("epsilon", async () => {
        throw new Error("catch-up failed");
      }),
      starting("omega", () => void calls.push("omega started")),
    ];
    const bridge = await makeBridge();
    await expect(startModules(bridge.ctx, modules)).rejects.toThrow(/epsilon\.ts failed to start: catch-up failed/);
    // Newest first; a stop that throws is logged, and the ones before it still run.
    expect(calls).toEqual(["alpha started", "beta started", "gamma started", "delta started", "delta stopped", "beta stopping", "alpha stopped"]);
    expect(bridge.logs).toContain("server/routes/beta.ts failed to stop: beta could not stop");
  });

  it("refuses two modules that handle the same event type", async () => {
    const modules = await loadRouteModules(path.join(FIXTURES, "duplicate"));
    expect(() => buildEventRegistry(modules)).toThrow(/first\.ts and server\/routes\/second\.ts handle "job_capture"/);
  });

  it("refuses a module with an unknown key instead of ignoring it", async () => {
    await expect(loadRouteModules(path.join(FIXTURES, "bad-key"))).rejects.toThrow(/unknown key "event"/);
    expect(() => validateRouteModule("Upper", {})).toThrow(RouteModuleError);
    expect(() => validateRouteModule("x", { events: { run_shell: () => undefined } })).toThrow(/not a bridge event type/);
    expect(() => validateRouteModule("x", { api: "nope" })).toThrow(/must be a function/);
    expect(() => validateRouteModule("x", null)).toThrow(/export default defineRouteModule/);
  });

  it("loads the runner's own modules: status, devices, pairing, model, runs", async () => {
    const modules = await loadRouteModules(ROUTES_DIR);
    expect(modules.map((m) => m.name)).toEqual(["devices", "model", "pairing", "runs", "status"]);
    expect(buildEventRegistry(modules).size).toBe(0);
  });

  it("returns no modules for a missing directory", async () => {
    expect(await loadRouteModules(path.join(FIXTURES, "missing"))).toEqual([]);
  });
});
