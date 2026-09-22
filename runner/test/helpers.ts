import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { JobCapture } from "@workflow-catalog/contracts";
import { afterEach } from "vitest";
import { ManualClock } from "../lib/clock.ts";
import type { DoctorReport } from "../lib/doctor.ts";
import { createBridgeApp } from "../server/app.ts";
import { createRunnerContext, silentLogger, type RunnerContext } from "../server/context.ts";
import type { EveGateway } from "../server/eve-gateway.ts";
import type { LoadedRouteModule } from "../server/route-modules.ts";
import { Workspace } from "../store/workspace.ts";

/** Fictional data only (docs/spec/implementation/fixtures-policy.md). */
export const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
export const OTHER_EXTENSION_ORIGIN = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
export const BRIDGE = "http://127.0.0.1:4310";
export const HOST = "127.0.0.1:4310";
export const UI_TOKEN = "ui-token-for-tests-0123456789abcdefghijklmn";

const temps: string[] = [];

/** A fresh temp directory, removed after the test. */
export async function tempDir(prefix = "wc-runner-test-"): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

export async function newWorkspace(clock = new ManualClock()): Promise<Workspace> {
  const root = await tempDir("wc-ws-");
  return Workspace.create(path.join(root, "JobAssistant"), { packageVersion: "0.1.0", clock });
}

export interface TestBridge {
  readonly ctx: RunnerContext;
  readonly clock: ManualClock;
  readonly workspace: Workspace;
  readonly app: ReturnType<typeof createBridgeApp>;
  readonly logs: string[];
  /** Sends a request to the bridge with the right Host unless the test overrides it. */
  request(pathname: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<Response>;
}

export interface BridgeOptions {
  readonly modules?: readonly LoadedRouteModule[];
  readonly uiDir?: string;
  readonly uiToken?: string | null;
  readonly eve?: EveGateway;
  readonly checklist?: () => Promise<DoctorReport>;
}

export async function makeBridge(options: BridgeOptions = {}): Promise<TestBridge> {
  const clock = new ManualClock();
  const workspace = await newWorkspace(clock);
  const logs: string[] = [];
  const ctx = createRunnerContext({
    workspace,
    clock,
    packageVersion: "0.1.0",
    eve: options.eve,
    model: { provider: "chatgpt", model: "gpt-5.6-luna" },
    checklist: options.checklist,
    log: { ...silentLogger, error: (message) => logs.push(message), warn: (message) => logs.push(message) },
  });
  const app = createBridgeApp({
    ctx,
    modules: options.modules ?? [],
    uiToken: options.uiToken === null ? undefined : (options.uiToken ?? UI_TOKEN),
    ...(options.uiDir ? { uiDir: options.uiDir } : {}),
  });
  return {
    ctx,
    clock,
    workspace,
    app,
    logs,
    request: async (pathname, init = {}) => app.request(`${BRIDGE}${pathname}`, { ...init, headers: { host: HOST, ...(init.headers ?? {}) } }),
  };
}

/** Issues a pairing code and redeems it through POST /pair. */
export async function pairDevice(bridge: TestBridge, origin = EXTENSION_ORIGIN): Promise<{ deviceId: string; token: string }> {
  const { code } = await bridge.ctx.pairing.issue();
  const response = await bridge.request("/pair", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (response.status !== 200) throw new Error(`pairing failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as { deviceId: string; token: string };
}

export function authed(token: string, origin = EXTENSION_ORIGIN, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, origin, ...extra };
}

/** A valid job_capture built from the contract: fictional posting, correct contentHash. */
export function jobCapture(overrides: Partial<JobCapture> = {}): JobCapture {
  const text = overrides.text ?? "Northwind Labs is hiring a Staff Platform Engineer. Remote within the EU. Fictional posting for tests.";
  return {
    protocol: 1,
    type: "job_capture",
    eventId: randomUUID(),
    url: "https://jobs.example/northwind-labs/staff-platform-engineer",
    text,
    extractorVersion: "extractor@1.0.0",
    contentHash: createHash("sha256").update(text, "utf8").digest("hex"),
    occurredAt: "2026-09-22T08:59:00.000Z",
    ...overrides,
  };
}

export async function postEvent(bridge: TestBridge, token: string, event: unknown, origin = EXTENSION_ORIGIN): Promise<Response> {
  return bridge.request("/events", {
    method: "POST",
    headers: authed(token, origin, { "content-type": "application/json" }),
    body: JSON.stringify(event),
  });
}
