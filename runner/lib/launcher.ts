import type { Hono } from "hono";
import { createBridgeApp, startModules, type RunningBridge } from "../server/app.ts";
import type { RunnerContext } from "../server/context.ts";
import { loadRouteModules, type StopFunction } from "../server/route-modules.ts";

/**
 * The second half of `npm run runner`, after its checks and the build: eve
 * and the bridge, started in an order that never leaves eve running when
 * startup fails or is interrupted.
 *
 * 1. Everything that can fail without a child process runs first. The route
 *    modules load and validate, and the bridge app is built; a duplicate
 *    event handler throws there.
 * 2. The SIGINT/SIGTERM/SIGHUP handlers are registered, and eve is spawned
 *    straight after. From then on a signal stops eve, even while waiting for
 *    it to be ready. SIGHUP is the terminal closing: eve runs in its own
 *    process group, so only this launcher gets it, and must stop eve.
 * 3. Wait for eve's health check, listen on 4310, then run the modules'
 *    start hooks.
 *
 * Any failure after the spawn stops whatever started, eve last, and then
 * rethrows. Once ready, a signal (exit 0) or eve dying (exit 1) stops the
 * start hooks, then the bridge, then eve.
 */
export const HEALTH_TIMEOUT_MS = 60_000;
export const HEALTH_INTERVAL_MS = 300;
export const STOP_TIMEOUT_MS = 10_000;

/** The part of a ChildProcess the launcher uses. */
export interface EveProcess {
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

type StopSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

/** Where SIGINT, SIGTERM and SIGHUP come from: `process` in the CLI. */
export interface SignalSource {
  on(signal: StopSignal, listener: () => void): unknown;
  off(signal: StopSignal, listener: () => void): unknown;
}

export interface LauncherDeps {
  readonly ctx: RunnerContext;
  readonly routesDir: string;
  readonly uiToken: string;
  /** Starts `eve start` in its own process group. */
  readonly spawnEve: () => EveProcess;
  /** True once eve answers its health check. */
  readonly eveReady: () => Promise<boolean>;
  readonly listen: (app: Hono) => Promise<RunningBridge>;
  readonly signals: SignalSource;
  /** Ends the process once the runner has stopped after being ready. */
  readonly exit: (code: number) => void;
  readonly log: { info(line: string): void; error(line: string): void };
  /** SIGKILL for eve's process group, when eve ignores SIGTERM. */
  readonly killGroup: (pid: number) => void;
  readonly healthTimeoutMs?: number;
  readonly healthIntervalMs?: number;
  readonly stopTimeoutMs?: number;
}

export type LaunchResult =
  | { readonly state: "ready"; readonly bridge: RunningBridge }
  /** A signal arrived before the runner was ready; eve has been stopped. */
  | { readonly state: "stopped" };

export class StartupError extends Error {
  override readonly name = "StartupError";
}

function sleep(ms: number): { done: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const done = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { done, cancel: () => clearTimeout(timer) };
}

export async function launchRunner(deps: LauncherDeps): Promise<LaunchResult> {
  const healthTimeoutMs = deps.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
  const healthIntervalMs = deps.healthIntervalMs ?? HEALTH_INTERVAL_MS;
  const stopTimeoutMs = deps.stopTimeoutMs ?? STOP_TIMEOUT_MS;

  // 1. Nothing is running yet, so a failure here leaves nothing behind.
  const modules = await loadRouteModules(deps.routesDir);
  const app = createBridgeApp({ ctx: deps.ctx, modules, uiToken: deps.uiToken });

  // 2. The signal handlers, then eve. The handlers go first so that no signal
  // can fall between the spawn and their registration (and kill this process
  // by default, leaving eve running). Node runs them from the event loop, so
  // none runs before the synchronous spawn below has returned.
  let phase: "starting" | "ready" | "stopping" = "starting";
  let interrupted = false;
  const onSignal = (): void => {
    if (phase === "starting") {
      interrupted = true;
      void stopEve();
    } else if (phase === "ready") {
      void shutdown().then(() => deps.exit(0));
    }
  };
  deps.signals.on("SIGINT", onSignal);
  deps.signals.on("SIGTERM", onSignal);
  deps.signals.on("SIGHUP", onSignal);
  const removeSignalHandlers = (): void => {
    deps.signals.off("SIGINT", onSignal);
    deps.signals.off("SIGTERM", onSignal);
    deps.signals.off("SIGHUP", onSignal);
  };
  let spawned: EveProcess;
  try {
    spawned = deps.spawnEve();
  } catch (error) {
    removeSignalHandlers();
    throw error;
  }
  const eve = spawned;

  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const eveExited = new Promise<void>((resolve) =>
    eve.once("exit", (code, signal) => {
      exited = { code, signal };
      resolve();
    }),
  );

  let eveStopping: Promise<void> | undefined;
  function stopEve(): Promise<void> {
    eveStopping ??= (async () => {
      if (exited || eve.pid === undefined) return;
      // SIGTERM to eve's parent process, not its listener: the spike saw a
      // kill of the listener alone exit 1.
      eve.kill("SIGTERM");
      const grace = sleep(stopTimeoutMs);
      const stopped = await Promise.race([eveExited.then(() => true), grace.done.then(() => false)]);
      grace.cancel();
      if (!stopped) {
        deps.log.error(`eve did not stop within ${stopTimeoutMs / 1000} s; killing its process group.`);
        try {
          deps.killGroup(eve.pid);
        } catch {
          // already gone
        }
        await eveExited;
      }
    })();
    return eveStopping;
  }

  let bridge: RunningBridge | undefined;
  let stops: StopFunction[] = [];
  /** Stops what started, in reverse: the start hooks, the bridge, eve. */
  async function stopStarted(): Promise<void> {
    const pending = stops;
    stops = [];
    for (const stop of pending) await Promise.resolve(stop()).catch((error: Error) => deps.log.error(error.message));
    const open = bridge;
    bridge = undefined;
    await open?.close();
    await stopEve();
  }

  let stopping: Promise<void> | undefined;
  function shutdown(): Promise<void> {
    stopping ??= (async () => {
      phase = "stopping";
      deps.log.info("Stopping...");
      await stopStarted();
      deps.log.info("Stopped.");
    })();
    return stopping;
  }

  async function abandon(): Promise<LaunchResult> {
    phase = "stopping";
    await stopStarted();
    removeSignalHandlers();
    return { state: "stopped" };
  }

  const exitedDuringStart = (): StartupError =>
    new StartupError(`eve exited during start (${exited?.signal ?? `exit ${exited?.code}`}). See the [eve] lines above.`);

  try {
    // 3. Ready, listening, started, in that order.
    const since = Date.now();
    for (;;) {
      if (interrupted) return await abandon();
      if (exited) throw exitedDuringStart();
      if (await deps.eveReady()) break;
      if (Date.now() - since > healthTimeoutMs) throw new StartupError(`eve did not become ready within ${healthTimeoutMs / 1000} s.`);
      await sleep(healthIntervalMs).done;
    }
    if (interrupted) return await abandon();
    const listening = await deps.listen(app);
    bridge = listening;
    if (interrupted) return await abandon();
    stops = await startModules(deps.ctx, modules);
    if (interrupted) return await abandon();
    if (exited) throw exitedDuringStart();

    phase = "ready";
    void eveExited.then(() => {
      if (phase !== "ready") return;
      deps.log.error(`eve stopped unexpectedly (${exited?.signal ?? `exit ${exited?.code}`}); stopping the bridge.`);
      void shutdown().then(() => deps.exit(1));
    });
    return { state: "ready", bridge: listening };
  } catch (error) {
    phase = "stopping";
    await stopStarted();
    removeSignalHandlers();
    throw error;
  }
}
