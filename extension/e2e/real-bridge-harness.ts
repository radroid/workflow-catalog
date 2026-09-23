/**
 * Shared "start a real, listening P02 bridge in an isolated scratch
 * workspace" harness for P07-B's acceptance-gate tests. Used by both
 * `src/shared/bridge-client.realbridge.test.ts` (vitest, drives the bridge
 * client library directly, no browser) and `e2e/bridge-e2e.spec.ts`
 * (Playwright, drives the real options/popup pages against it). One
 * implementation so the HOME/keychain isolation this depends on is audited
 * in exactly one place, not two copies that could quietly drift apart.
 *
 * `@workflow-catalog/runner` is an allowed devDependency for exactly this
 * (P07 packet allowlist: "A devDependency on @workflow-catalog/runner
 * (workspace:*) is fine if you drive the real bridge in tests"). Nothing
 * here touches the real HOME, the OS keychain, or a live model:
 * `Workspace.create` below writes only under a fresh `os.tmpdir()`
 * subdirectory (never `~/JobAssistant`), `RunnerContext` is built directly
 * (bypassing `cli/setup.ts`, `cli/doctor.ts`, `cli/runner.ts`, and
 * `lib/secret-store.ts` entirely -- none of those are imported by anything
 * this file imports), and no `eve`/model gateway is ever passed to
 * `createRunnerContext`, so nothing reachable from here can dispatch a real
 * model call or touch the real keychain. Mirrors `runner/test/helpers.ts`'s
 * own `makeBridge()`, with a real listening socket (127.0.0.1:4310, the one
 * port the manifest's host permission allows, and the one this repo's
 * rules say this session is the only agent using this iteration) instead
 * of Hono's in-process `app.request`, since a real extension -- and
 * Playwright driving its real pages -- can only ever reach the bridge over
 * that socket.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { JobCapture } from "@workflow-catalog/contracts";
import { ManualClock } from "@workflow-catalog/runner/lib/clock.ts";
import { createBridgeApp, listen, type RunningBridge } from "@workflow-catalog/runner/server/app.ts";
import { createRunnerContext, silentLogger, type RunnerContext } from "@workflow-catalog/runner/server/context.ts";
import { Workspace } from "@workflow-catalog/runner/store/workspace.ts";
import { createBridgeClient, type BridgeClient } from "../src/shared/bridge-client";

/** The one port the manifest's host permission allows, and the one
 * `BRIDGE_ORIGIN` in `shared/bridge-client.ts` is hard-coded to -- the
 * extension's own singleton `bridgeClient` can only ever reach a bridge
 * listening here, so `e2e/bridge-e2e.spec.ts` (which drives the real
 * extension pages) must keep asking for exactly this port. */
export const BRIDGE_PORT = 4310;

type BridgeApp = ReturnType<typeof createBridgeApp>;

/** The slice of `@hono/node-server`'s `serve` this file uses -- the same
 * adapter `runner/server/app.ts`'s `listen()` serves the bridge with. */
type NodeServe = (
  options: { fetch: BridgeApp["fetch"]; port: number; hostname: string },
  listeningListener?: (info: AddressInfo) => void,
) => Server;

/** `@hono/node-server` is the runner's dependency, not this package's
 * (pnpm doesn't hoist it), so it is resolved from the runner package --
 * the one version the real bridge runs on. */
async function loadNodeServe(): Promise<NodeServe> {
  const requireHere = createRequire(import.meta.url);
  const requireFromRunner = createRequire(requireHere.resolve("@workflow-catalog/runner/package.json"));
  const loaded = (await import(pathToFileURL(requireFromRunner.resolve("@hono/node-server")).href)) as {
    serve?: NodeServe;
    default?: { serve?: NodeServe };
  };
  const serve = loaded.serve ?? loaded.default?.serve;
  if (!serve) throw new Error("real-bridge-harness: @hono/node-server has no serve()");
  return serve;
}

/**
 * Serves a bridge on 127.0.0.1 port 0 and reads back the port the OS
 * assigned, holding it from the first moment. P07-B revision 1, B1:
 * `src/shared/bridge-client.realbridge.test.ts` never drives a real
 * browser and has no reason to claim 4310 specifically -- doing so anyway
 * was a real, observed failure (11/11 of that file's tests failing twice,
 * plus an afterEach TypeError) when something else already held it, e.g.
 * an owner's own `npm run runner` during the smoke test.
 *
 * P07-B revision 2 (reviewer nit): revision 1 found a free port by binding
 * a throwaway server to port 0, closing it, then binding the bridge to
 * that number -- anything else could take the port in between. The
 * runner's own `listen()` can't be asked for port 0 (it builds its `url`
 * from the port it was given and never exposes the bound one), so this
 * binds with the same `serve` itself. The app is built once the port is
 * known, because the bridge's Host-header allowlist needs it; the server's
 * fetch reaches it through a late binding. No request can arrive before
 * then: nothing knows the port until the listening callback has run.
 */
async function listenOnEphemeralPort(buildApp: (port: number) => BridgeApp): Promise<{ app: BridgeApp; port: number; bridge: RunningBridge }> {
  const serve = await loadNodeServe();
  let app: BridgeApp | undefined;
  return new Promise((resolve, reject) => {
    const server = serve(
      {
        fetch: (...args) => (app ? app.fetch(...args) : new Response(null, { status: 503 })),
        port: 0,
        hostname: "127.0.0.1",
      },
      (info) => {
        server.off("error", reject);
        const built = buildApp(info.port);
        app = built;
        resolve({
          app: built,
          port: info.port,
          bridge: {
            url: `http://127.0.0.1:${info.port}`,
            close: () =>
              new Promise<void>((done) => {
                server.close(() => done());
                // Idle keep-alive sockets must not hold the shutdown open
                // (the same as runner/server/app.ts's listen()).
                server.closeAllConnections();
              }),
          },
        });
      },
    );
    server.once("error", reject);
  });
}

export interface BridgeHarness {
  readonly ctx: RunnerContext;
  readonly clock: ManualClock;
  readonly app: BridgeApp;
  readonly port: number;
  /** Mutable: closed and re-`listen()`-ed in place by the offline/reconnect
   * gate-4 scenario, reusing the same `app`/`ctx` so the device stays
   * paired and the journal persists across the restart. */
  bridge: RunningBridge;
}

const workspaceDirs: string[] = [];

export interface StartBridgeHarnessOptions {
  /** Defaults to BRIDGE_PORT (4310). `"ephemeral"` binds port 0 and uses
   * whichever port the OS assigned (`listenOnEphemeralPort`) -- for a
   * vitest-only harness that never needs to be the one real extension's
   * fixed bridge origin (P07-B revision 1, B1). */
  readonly port?: number | "ephemeral";
}

export async function startBridgeHarness(options: StartBridgeHarnessOptions = {}): Promise<BridgeHarness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wc-p07b-bridge-"));
  workspaceDirs.push(root);
  const clock = new ManualClock();
  const workspace = await Workspace.create(path.join(root, "JobAssistant"), { packageVersion: "0.1.0-test", clock });
  const ctx = createRunnerContext({ workspace, clock, packageVersion: "0.1.0-test", log: silentLogger });
  // No route modules: job_capture has no handler until P04 (runner/README.md
  // "The bridge": "journals a job_capture with no handler as no_handler"),
  // which is exactly the real, shipped P02 behaviour this repo is at right
  // now -- not a stand-in for a handler this harness doesn't have.
  const buildApp = (port: number): BridgeApp => createBridgeApp({ ctx, modules: [], uiToken: undefined, port });
  if (options.port === "ephemeral") {
    const { app, port, bridge } = await listenOnEphemeralPort(buildApp);
    return { ctx, clock, app, port, bridge };
  }
  const port = options.port ?? BRIDGE_PORT;
  const app = buildApp(port);
  const bridge = await listen(app, port);
  return { ctx, clock, app, port, bridge };
}

/** Deletes every scratch workspace `startBridgeHarness` has created so far
 * in this process. Call once, from the last `afterEach`/`afterAll` in
 * whichever suite owns it -- safe to call with nothing pending. */
export async function cleanScratchWorkspaces(): Promise<void> {
  const dirs = workspaceDirs.splice(0, workspaceDirs.length);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
}

/** A `BridgeClient` bound to `baseUrl` for one origin/token pair -- the
 * same `createBridgeClient()` the popup/options pages use, just pointed at
 * a harness's own `bridge.url` (still 127.0.0.1:4310; see `BRIDGE_PORT`)
 * instead of the hard-coded default, and (unlike the extension's own
 * singleton) able to hold a token this process picked, not
 * `chrome.storage.session`. Only for the Node-side pairing helper below --
 * `bridge-e2e.spec.ts`'s real UI-driving tests use the extension's actual
 * `bridgeClient` singleton via the real pages, never this.
 *
 * `onTokenInvalid`/`onOriginMismatch` (P07-B revision 1, B3) default to
 * `shared/storage.ts`'s real `chrome.storage.session`-backed functions,
 * which don't exist in this file's plain Node environment -- both are
 * no-ops here on purpose: this helper never held a token in
 * `chrome.storage` to begin with (see above), so there's nothing for
 * either hook to clear/flag, and the vitest gate tests that drive 401/403
 * through this client assert on the HTTP response itself, not any
 * storage side effect. */
export function clientForOrigin(baseUrl: string, origin: string, token: string | null): BridgeClient {
  return createBridgeClient({
    baseUrl,
    getToken: () => Promise.resolve(token ? { token } : null),
    onTokenInvalid: () => Promise.resolve(),
    onOriginMismatch: () => Promise.resolve(),
  });
}

/** Wraps `fetch` just for the duration of `run()` so every request through
 * it carries `origin` the way Chrome would (POST/PUT/etc: its own
 * chrome-extension:// origin; GET/HEAD: none at all). Real browsers forbid
 * scripts from setting Origin; this Node-side helper stands in for what
 * Chrome already guarantees on the wire (runner/README.md "Origin as
 * Chrome sends it"), so the bridge's real Origin-checking code path is
 * genuinely exercised. Used only to mint tokens paired under a chosen
 * origin from Node (see `pairFictionalDevice`) -- never to fake what a real
 * browser page itself sends; `bridge-e2e.spec.ts`'s pages send their own,
 * real `Origin` header, which Chrome sets and no test code touches. */
export function withChromeOrigin<T>(origin: string, run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    if (method !== "GET" && method !== "HEAD") headers.set("origin", origin);
    return realFetch(input, { ...init, headers });
  }) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = realFetch;
  });
}

/** Issues a fresh pairing code from `harness` and redeems it as `origin`
 * would, from Node (see `withChromeOrigin`). */
export async function pairFictionalDevice(harness: BridgeHarness, origin: string): Promise<{ deviceId: string; token: string }> {
  const { code } = await harness.ctx.pairing.issue();
  const result = await withChromeOrigin(origin, () => clientForOrigin(harness.bridge.url, origin, null).pair({ code }));
  if (!result.ok) throw new Error(`pairFictionalDevice(${origin}) failed: ${result.error.code} ${result.error.message}`);
  return result.value;
}

/** A fictional job_capture (fixtures-policy.md: fictional company/URL),
 * shaped and sized like a real one, for tests that need a `JobCapture`
 * without driving the real popup/extractor to build one. */
export function fictionalJobCapture(overrides: Partial<JobCapture> = {}): JobCapture {
  const text = overrides.text ?? "Northwind Labs is hiring a Staff Platform Engineer. Remote within the EU. Fictional posting for tests.";
  return {
    protocol: 1,
    type: "job_capture",
    eventId: randomUUID(),
    url: "https://jobs.example/northwind-labs/staff-platform-engineer",
    text,
    extractorVersion: "extractor@1.0.0",
    contentHash: "a".repeat(64),
    occurredAt: "2026-09-22T08:59:00.000Z",
    ...overrides,
  };
}
