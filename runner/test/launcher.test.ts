import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ManualClock } from "../lib/clock.ts";
import { launchRunner, type EveProcess, type LauncherDeps } from "../lib/launcher.ts";
import type { RunningBridge } from "../server/app.ts";
import { createRunnerContext, silentLogger } from "../server/context.ts";
import { newWorkspace, tempDir, UI_TOKEN } from "./helpers.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(TEST_DIR, "fixtures", "route-modules");
/** For route modules the tests write into a temp routes folder. */
const ROUTE_MODULES = path.join(TEST_DIR, "..", "server", "route-modules.ts");

/** Stands in for the `eve start` child. It exits when sent `exitOn`; null ignores every signal. */
class FakeEve extends EventEmitter implements EveProcess {
  readonly pid = 4242;
  readonly received: NodeJS.Signals[] = [];
  readonly #exitOn: NodeJS.Signals | null;

  constructor(exitOn: NodeJS.Signals | null = "SIGTERM") {
    super();
    this.#exitOn = exitOn;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.received.push(signal);
    if (signal === this.#exitOn) this.exit(null, signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    setImmediate(() => this.emit("exit", code, signal));
  }
}

class FakeSignals extends EventEmitter {
  send(signal: "SIGINT" | "SIGTERM" | "SIGHUP"): void {
    this.emit(signal);
  }
}

interface Harness {
  readonly deps: LauncherDeps;
  readonly spawned: FakeEve[];
  readonly signals: FakeSignals;
  readonly events: string[];
  readonly exits: number[];
  /** Resolves once eve has been spawned. */
  readonly spawnedOnce: Promise<FakeEve>;
  /** SIGINT, SIGTERM and SIGHUP listeners already registered at the moment eve was spawned. */
  readonly listenersAtSpawn: Array<{ SIGINT: number; SIGTERM: number; SIGHUP: number }>;
}

async function harness(overrides: Partial<LauncherDeps> & { eve?: () => FakeEve } = {}): Promise<Harness> {
  const clock = new ManualClock();
  const ctx = createRunnerContext({ workspace: await newWorkspace(clock), clock, packageVersion: "0.1.0", log: silentLogger });
  const spawned: FakeEve[] = [];
  const events: string[] = [];
  const exits: number[] = [];
  const signals = new FakeSignals();
  let announce: (eve: FakeEve) => void = () => undefined;
  const spawnedOnce = new Promise<FakeEve>((resolve) => {
    announce = resolve;
  });
  const { eve: makeEve, ...rest } = overrides;
  const listenersAtSpawn: Array<{ SIGINT: number; SIGTERM: number; SIGHUP: number }> = [];
  const deps: LauncherDeps = {
    ctx,
    routesDir: await tempDir("wc-routes-"),
    uiToken: UI_TOKEN,
    spawnEve: () => {
      listenersAtSpawn.push({ SIGINT: signals.listenerCount("SIGINT"), SIGTERM: signals.listenerCount("SIGTERM"), SIGHUP: signals.listenerCount("SIGHUP") });
      const eve = makeEve ? makeEve() : new FakeEve();
      eve.once("exit", () => events.push("eve exited"));
      spawned.push(eve);
      announce(eve);
      return eve;
    },
    eveReady: async () => true,
    listen: async () => {
      events.push("bridge listening");
      return { url: "http://127.0.0.1:4310", close: async () => void events.push("bridge closed") } satisfies RunningBridge;
    },
    signals,
    exit: (code) => void exits.push(code),
    log: { info: () => undefined, error: () => undefined },
    killGroup: vi.fn(),
    healthIntervalMs: 5,
    stopTimeoutMs: 200,
    ...rest,
  };
  return { deps, spawned, signals, events, exits, spawnedOnce, listenersAtSpawn };
}

describe("launcher: nothing is left running when startup fails", () => {
  it("loads the route modules before spawning eve: one that throws at load leaves no child", async () => {
    for (const dir of ["throws", "bad-key"]) {
      const h = await harness({ routesDir: path.join(FIXTURES, dir) });
      await expect(launchRunner(h.deps)).rejects.toThrow(dir === "throws" ? /boom\.ts failed to load: fixture route module failed to load/ : /unknown key "event"/);
      expect(h.spawned, dir).toHaveLength(0);
      expect(h.signals.listenerCount("SIGTERM")).toBe(0);
    }
  });

  it("builds the bridge before spawning eve: a duplicate event handler leaves no child", async () => {
    const h = await harness({ routesDir: path.join(FIXTURES, "duplicate") });
    await expect(launchRunner(h.deps)).rejects.toThrow(/handle "job_capture" events/);
    expect(h.spawned).toHaveLength(0);
  });

  it("stops eve when a signal arrives while waiting for it to be ready", async () => {
    const listen = vi.fn();
    const h = await harness({ eveReady: async () => false, listen });
    const launching = launchRunner(h.deps);
    const eve = await h.spawnedOnce;
    // The handlers were already registered when eve was spawned, so no signal can fall in between.
    expect(h.listenersAtSpawn).toEqual([{ SIGINT: 1, SIGTERM: 1, SIGHUP: 1 }]);
    h.signals.send("SIGTERM");
    await expect(launching).resolves.toEqual({ state: "stopped" });
    expect(eve.received).toEqual(["SIGTERM"]);
    expect(h.events).toEqual(["eve exited"]);
    expect(listen).not.toHaveBeenCalled();
    expect(h.exits).toEqual([]);
    expect(h.signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("stops eve when the terminal closes (SIGHUP) while waiting for it to be ready", async () => {
    // eve runs in its own process group, so the terminal's SIGHUP reaches only the launcher.
    const listen = vi.fn();
    const h = await harness({ eveReady: async () => false, listen });
    const launching = launchRunner(h.deps);
    const eve = await h.spawnedOnce;
    h.signals.send("SIGHUP");
    await expect(launching).resolves.toEqual({ state: "stopped" });
    expect(eve.received).toEqual(["SIGTERM"]);
    expect(h.events).toEqual(["eve exited"]);
    expect(listen).not.toHaveBeenCalled();
    expect(h.exits).toEqual([]);
    expect(h.signals.listenerCount("SIGHUP")).toBe(0);
  });

  it("sends eve SIGTERM at once when a signal arrives while a health check hangs", async () => {
    // The CLI's health check can take up to 5 s to give up; stopping eve must not wait for it.
    let answer: (ready: boolean) => void = () => undefined;
    let healthChecks = 0;
    const h = await harness({
      eveReady: () =>
        new Promise<boolean>((resolve) => {
          healthChecks += 1;
          answer = resolve;
        }),
    });
    const launching = launchRunner(h.deps);
    const eve = await h.spawnedOnce;
    await vi.waitFor(() => expect(healthChecks).toBe(1));
    h.signals.send("SIGTERM");
    expect(eve.received).toEqual(["SIGTERM"]);
    await vi.waitFor(() => expect(h.events).toEqual(["eve exited"]));
    // eve has stopped while the health check still hangs; when it returns, the launcher gives up.
    answer(false);
    await expect(launching).resolves.toEqual({ state: "stopped" });
    expect(eve.received).toEqual(["SIGTERM"]);
    expect(healthChecks).toBe(1);
  });

  it("removes its signal handlers when eve cannot be spawned at all", async () => {
    const h = await harness({
      spawnEve: () => {
        throw new Error("spawn EAGAIN");
      },
    });
    await expect(launchRunner(h.deps)).rejects.toThrow(/spawn EAGAIN/);
    expect(h.signals.listenerCount("SIGTERM")).toBe(0);
    expect(h.signals.listenerCount("SIGINT")).toBe(0);
    expect(h.signals.listenerCount("SIGHUP")).toBe(0);
  });

  it("stops eve when the bridge cannot listen", async () => {
    const h = await harness({ listen: async () => Promise.reject(new Error("Port 4310 on 127.0.0.1 is already in use.")) });
    await expect(launchRunner(h.deps)).rejects.toThrow(/already in use/);
    expect(h.spawned[0]?.received).toEqual(["SIGTERM"]);
    expect(h.events).toEqual(["eve exited"]);
  });

  it("stops the bridge and eve when a module's start hook fails", async () => {
    const routes = await tempDir("wc-routes-");
    await writeFile(
      path.join(routes, "failing.ts"),
      `import { defineRouteModule } from ${JSON.stringify(ROUTE_MODULES)};\nexport default defineRouteModule({ start: () => { throw new Error("catch-up failed"); } });\n`,
    );
    const h = await harness({ routesDir: routes });
    await expect(launchRunner(h.deps)).rejects.toThrow(/failing\.ts failed to start: catch-up failed/);
    expect(h.events).toEqual(["bridge listening", "bridge closed", "eve exited"]);
  });

  it("reports eve exiting during start, and starts nothing else", async () => {
    const listen = vi.fn();
    const h = await harness({ eveReady: async () => false, listen });
    const launching = launchRunner(h.deps);
    (await h.spawnedOnce).exit(1);
    await expect(launching).rejects.toThrow(/eve exited during start \(exit 1\)/);
    expect(listen).not.toHaveBeenCalled();
    expect(h.spawned[0]?.received).toEqual([]);
  });

  it("gives up after the health timeout and stops eve", async () => {
    const h = await harness({ eveReady: async () => false, healthTimeoutMs: 30 });
    await expect(launchRunner(h.deps)).rejects.toThrow(/did not become ready/);
    expect(h.spawned[0]?.received).toEqual(["SIGTERM"]);
  });

  it("kills eve's process group when it ignores SIGTERM", async () => {
    let eve: FakeEve | undefined;
    const killGroup = vi.fn((pid: number) => {
      expect(pid).toBe(4242);
      eve?.exit(null, "SIGKILL");
    });
    const h = await harness({
      eve: () => (eve = new FakeEve(null)),
      listen: async () => Promise.reject(new Error("listen failed")),
      killGroup,
      stopTimeoutMs: 20,
    });
    await expect(launchRunner(h.deps)).rejects.toThrow(/listen failed/);
    expect(eve?.received).toEqual(["SIGTERM"]);
    expect(killGroup).toHaveBeenCalledOnce();
  });
});

describe("launcher: once ready", () => {
  it("stops the start hooks, the bridge, then eve on a signal, and exits 0", async () => {
    const routes = await tempDir("wc-routes-");
    const marker = path.join(routes, "stopped.txt");
    await writeFile(
      path.join(routes, "hooks.ts"),
      `import { writeFileSync } from "node:fs";\nimport { defineRouteModule } from ${JSON.stringify(ROUTE_MODULES)};\nexport default defineRouteModule({ start: () => () => writeFileSync(${JSON.stringify(marker)}, "stopped") });\n`,
    );
    const h = await harness({ routesDir: routes });
    const result = await launchRunner(h.deps);
    expect(result.state).toBe("ready");
    h.signals.send("SIGINT");
    await vi.waitFor(() => expect(h.exits).toEqual([0]));
    expect(existsSync(marker)).toBe(true);
    expect(h.events).toEqual(["bridge listening", "bridge closed", "eve exited"]);
    // A second Ctrl-C while stopping changes nothing.
    h.signals.send("SIGINT");
    expect(h.spawned[0]?.received).toEqual(["SIGTERM"]);
  });

  it("still closes the bridge and stops eve when a module's stop function throws", async () => {
    const routes = await tempDir("wc-routes-");
    await writeFile(
      path.join(routes, "hooks.ts"),
      `import { defineRouteModule } from ${JSON.stringify(ROUTE_MODULES)};\nexport default defineRouteModule({ start: () => () => { throw new Error("stop failed"); } });\n`,
    );
    const errors: string[] = [];
    const h = await harness({ routesDir: routes, log: { info: () => undefined, error: (line) => void errors.push(line) } });
    expect((await launchRunner(h.deps)).state).toBe("ready");
    h.signals.send("SIGINT");
    await vi.waitFor(() => expect(h.exits).toEqual([0]));
    expect(h.events).toEqual(["bridge listening", "bridge closed", "eve exited"]);
    expect(errors).toEqual(["stop failed"]);
  });

  it("stops the bridge, then eve when the terminal closes (SIGHUP), and exits 0", async () => {
    const h = await harness();
    expect((await launchRunner(h.deps)).state).toBe("ready");
    h.signals.send("SIGHUP");
    await vi.waitFor(() => expect(h.exits).toEqual([0]));
    expect(h.events).toEqual(["bridge listening", "bridge closed", "eve exited"]);
    expect(h.spawned[0]?.received).toEqual(["SIGTERM"]);
  });

  it("stops the bridge and exits 1 when eve stops unexpectedly", async () => {
    const h = await harness();
    expect((await launchRunner(h.deps)).state).toBe("ready");
    h.spawned[0]?.exit(1);
    await vi.waitFor(() => expect(h.exits).toEqual([1]));
    expect(h.events).toEqual(["bridge listening", "eve exited", "bridge closed"]);
  });
});
