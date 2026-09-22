import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { buildAdapter, buildRunner, computeBuildStamp, eveCli, needsBuild, recordBuildStamp } from "../lib/build.ts";
import { systemClock } from "../lib/clock.ts";
import { evePathEnv } from "../lib/codex.ts";
import { runDoctor } from "../lib/doctor.ts";
import { readPackageVersion } from "../lib/package-info.ts";
import { ROUTES_DIR, RUNNER_DIR } from "../lib/paths.ts";
import { API_KEY_ENV, API_KEY_SECRET_NAME, createOsSecretStore, RUNNER_SECRET_SERVICE } from "../lib/secret-store.ts";
import { loadSettings, PRIVACY_ENV } from "../lib/settings.ts";
import { Workspace } from "../store/workspace.ts";
import { BRIDGE_HOST, BRIDGE_ORIGIN, BRIDGE_PORT, createBridgeApp, listen, startModules } from "../server/app.ts";
import { consoleLogger, createRunnerContext } from "../server/context.ts";
import { createEveGateway, EVE_HOST, EVE_PORT } from "../server/eve-gateway.ts";
import { loadRouteModules } from "../server/route-modules.ts";
import { fail } from "./args.ts";

/**
 * npm run runner: mode A (eve-spike.md). Builds when needed, starts
 * `eve start` on 127.0.0.1:3210 and the bridge on 127.0.0.1:4310, both
 * loopback only, and stops both on Ctrl-C or SIGTERM.
 *
 * eve's output is prefixed [eve] and goes to this terminal only; it is never
 * written to a file. It can contain personal data (a failed model call prints
 * its request), so do not paste it anywhere public.
 */
const STOP_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 60_000;

function portInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function pipeWithPrefix(child: ChildProcess, prefix: string): void {
  if (child.stdout) createInterface({ input: child.stdout }).on("line", (line) => process.stdout.write(`${prefix}${line}\n`));
  if (child.stderr) createInterface({ input: child.stderr }).on("line", (line) => process.stderr.write(`${prefix}${line}\n`));
}

const settings = await loadSettings();
const model = settings.model;
if (!model) fail(settings.modelError ?? "No model is configured. Run `npm run setup`.");
if (!settings.routePassword || !settings.uiToken || !settings.workspace) fail("Setup has not finished. Run `npm run setup` first.");
const routePassword = settings.routePassword;
const workspace = await Workspace.open(settings.workspace).catch((error: Error) => fail(error.message));

for (const [host, port, what] of [
  [EVE_HOST, EVE_PORT, "eve"],
  [BRIDGE_HOST, BRIDGE_PORT, "the bridge"],
] as const) {
  if (await portInUse(host, port)) fail(`Port ${port} on ${host} is already in use, and ${what} needs it. Is another runner running? Stop it first.`);
}

// The eve process's environment: our settings, the privacy switches, codex on
// PATH, and the provider's API key from the keychain (in memory only).
const secrets = createOsSecretStore();
const childEnv: NodeJS.ProcessEnv = { ...process.env, ...settings.values, ...PRIVACY_ENV, PATH: evePathEnv(settings.codexDir) };
delete childEnv.PORT;
delete childEnv.HOST;
if (model.provider !== "chatgpt") {
  const envName = API_KEY_ENV[model.provider];
  const key = childEnv[envName] ?? (await secrets.get(RUNNER_SECRET_SERVICE, API_KEY_SECRET_NAME[model.provider]).catch(() => null)) ?? undefined;
  if (!key) fail(`No ${model.provider} API key: none in the keychain and ${envName} is not set. Run \`npm run setup\`.`);
  childEnv[envName] = key;
}

const stamp = await computeBuildStamp(model);
if (await needsBuild(stamp)) {
  console.log("[runner] Building (first start, or the agent, adapter, skills or model changed)...");
  await buildAdapter(childEnv).catch((error: Error) => fail(`[runner] The adapter build failed: ${error.message}`));
  await buildRunner(childEnv).catch((error: Error) => fail(`[runner] eve build failed: ${error.message}`));
  await recordBuildStamp(stamp);
}

console.log(`[runner] Starting eve on http://${EVE_HOST}:${EVE_PORT} (${model.provider} ${model.model})...`);
const eve = spawn(process.execPath, [eveCli(RUNNER_DIR), "start", "--host", EVE_HOST, "--port", String(EVE_PORT)], {
  cwd: RUNNER_DIR,
  env: childEnv,
  stdio: ["ignore", "pipe", "pipe"],
  // Its own process group, so Ctrl-C reaches only this launcher and the
  // shutdown below stops eve in order: SIGTERM to eve's parent process (the
  // spike saw a kill of the listener alone exit 1), then the group if needed.
  detached: true,
});
pipeWithPrefix(eve, "[eve] ");
let eveExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
const eveExited = new Promise<void>((resolve) =>
  eve.once("exit", (code, signal) => {
    eveExit = { code, signal };
    resolve();
  }),
);

async function stopEve(): Promise<void> {
  if (eveExit || eve.pid === undefined) return;
  eve.kill("SIGTERM");
  const stopped = await Promise.race([eveExited.then(() => true), delay(STOP_TIMEOUT_MS).then(() => false)]);
  if (!stopped) {
    console.error("[runner] eve did not stop within 10 s; killing its process group.");
    try {
      process.kill(-eve.pid, "SIGKILL");
    } catch {
      // already gone
    }
    await eveExited;
  }
}

const gateway = createEveGateway({ password: routePassword });
const started = Date.now();
for (;;) {
  if (eveExit) fail(`[runner] eve exited during start (${eveExit.signal ?? `exit ${eveExit.code}`}). See the [eve] lines above.`);
  if ((await gateway.health()).ok) break;
  if (Date.now() - started > HEALTH_TIMEOUT_MS) {
    await stopEve();
    fail("[runner] eve did not become ready within 60 s.");
  }
  await delay(300);
}

const ctx = createRunnerContext({
  workspace,
  clock: systemClock,
  packageVersion: await readPackageVersion(),
  eve: gateway,
  model,
  checklist: async () => runDoctor({ settings: await loadSettings(), clock: systemClock, secrets }),
  log: consoleLogger,
});
const modules = await loadRouteModules(ROUTES_DIR);
const bridge = await listen(createBridgeApp({ ctx, modules, uiToken: settings.uiToken })).catch(async (error: Error) => {
  await stopEve();
  return fail(`[runner] ${error.message}`);
});
const stops = await startModules(ctx, modules).catch(async (error: Error) => {
  await bridge.close();
  await stopEve();
  return fail(`[runner] ${error.message}`);
});

let stopping = false;
async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log("[runner] Stopping...");
  for (const stop of stops) await Promise.resolve(stop()).catch((error: Error) => console.error(`[runner] ${error.message}`));
  await bridge.close();
  await stopEve();
  console.log("[runner] Stopped.");
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
void eveExited.then(() => {
  if (!stopping) {
    console.error(`[runner] eve stopped unexpectedly (${eveExit?.signal ?? `exit ${eveExit?.code}`}); stopping the bridge.`);
    void shutdown(1);
  }
});

const { url, expiresAt } = await ctx.uiLogin.issue(BRIDGE_ORIGIN);
const paired = (await ctx.devices.active()).length;
console.log(`[runner] Ready. Bridge on ${bridge.url} (loopback only), eve on http://${EVE_HOST}:${EVE_PORT}.`);
console.log(`[runner] Local UI sign-in link (works once, until ${expiresAt.toLocaleTimeString()}; \`npm run ui\` prints a new one):`);
console.log(`[runner]   ${url}`);
if (paired === 0) console.log("[runner] No browser is paired yet: run `npm run pair` and enter the code on the extension's options page.");
console.log("[runner] Press Ctrl-C to stop.");
