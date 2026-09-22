import { readdir } from "node:fs/promises";
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

  it("loads exactly the *.ts files server/routes/ contains today, whatever packet added them (P04/P06/P08/P10 never need to edit this test)", async () => {
    const modules = await loadRouteModules(ROUTES_DIR);

    // "Expected" is derived from an independent, low-level readdir of
    // ROUTES_DIR, filtered by the *exact same rule* loadRouteModules itself
    // applies (server/route-modules.ts: "*.ts files, skipping tests
    // (*.test.ts), type declarations and names starting with _ or .") —
    // copied rather than imported because server/route-modules.ts is P02's
    // (not in this packet's Owns), so this cannot share a symbol with it.
    // Because "expected" is computed from the directory's actual contents
    // rather than a hand-maintained literal, a future packet dropping in
    // server/routes/<name>.ts needs no edit here: this test still passes,
    // and still fails if loadRouteModules's own filtering ever drifts from
    // that rule (a name it should include gets dropped, or vice versa).
    const entries = await readdir(ROUTES_DIR);
    const expectedNames = entries
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith(".d.ts") && !/^[_.]/.test(file))
      .map((file) => file.slice(0, -".ts".length))
      .sort();
    expect(modules.map((m) => m.name)).toEqual(expectedNames);

    // P02's four modules must always be among them, named explicitly so an
    // accidental deletion of one is still caught even though the assertion
    // above is now directory-driven rather than a hardcoded full list.
    expect(modules.map((m) => m.name)).toEqual(expect.arrayContaining(["devices", "model", "pairing", "status"]));

    // The event registry's keys must be exactly the union of every loaded
    // module's own declared `events` — not a hardcoded count. A module that
    // declares events.foo but never ends up registered (or a stray key that
    // ends up registered without any module declaring it) fails this,
    // whatever the current module set is.
    const declaredEventTypes = new Set<string>();
    for (const { module } of modules) {
      for (const type of Object.keys(module.events ?? {})) declaredEventTypes.add(type);
    }
    const registry = buildEventRegistry(modules);
    expect(new Set(registry.keys())).toEqual(declaredEventTypes);
  });

  it("returns no modules for a missing directory", async () => {
    expect(await loadRouteModules(path.join(FIXTURES, "missing"))).toEqual([]);
  });
});
