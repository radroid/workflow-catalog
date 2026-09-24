import { access } from "node:fs/promises";
import path from "node:path";
import type { ModelSettings } from "../agent/lib/model.ts";
import { DeviceRegistry } from "../store/devices.ts";
import { readModelCheck, type ModelCheck } from "../store/model-check.ts";
import { Workspace } from "../store/workspace.ts";
import type { Clock } from "./clock.ts";
import { codexLoginStatus, findOnPath, type CodexLoginStatus } from "./codex.ts";
import { checkEvePin, EVE_PIN, type EvePinCheck } from "./package-info.ts";
import { RUNNER_DIR } from "./paths.ts";
import { API_KEY_ENV, API_KEY_SECRET_NAME, RUNNER_SECRET_SERVICE, type SecretStore } from "./secret-store.ts";
import type { RunnerSettings } from "./settings.ts";

/**
 * The install checklist, shared by `npm run doctor` and the status page. The
 * first five items are the catalog install page's checklist, same ids and
 * labels (apps/catalog/lib/install-status.ts); the last two are the runner's
 * own conditions (mvp-spec §8). Every item is required: doctor exits 1 while
 * any is "fail". A "warn" is not a failure (an unverified model, or an
 * ambient RUNNER_WORKSPACE that .env.local's workspace overrides, P02.2).
 */
export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorItem {
  readonly id: "node" | "runner" | "provider" | "workspace" | "extension" | "privacy" | "eve";
  readonly label: string;
  readonly status: DoctorStatus;
  readonly detail: string;
  readonly required: boolean;
  readonly fix?: string;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly items: readonly DoctorItem[];
}

export const MIN_NODE_MAJOR = 24;

export interface DoctorDeps {
  readonly settings: RunnerSettings;
  readonly clock: Clock;
  readonly secrets: SecretStore;
  readonly nodeVersion?: string;
  readonly runnerDir?: string;
  readonly findCodex?: (settings: RunnerSettings) => Promise<string | undefined>;
  readonly codexStatus?: (codexPath: string) => Promise<CodexLoginStatus>;
  readonly evePin?: () => Promise<EvePinCheck>;
  readonly dependenciesInstalled?: (runnerDir: string) => Promise<string[]>;
}

/** Where codex is: RUNNER_CODEX_DIR from setup first, then PATH. */
export async function locateCodex(settings: RunnerSettings): Promise<string | undefined> {
  if (settings.codexDir) {
    const found = await findOnPath("codex", settings.codexDir);
    if (found) return found;
  }
  return findOnPath("codex");
}

const REQUIRED_PACKAGES = ["eve", "hono", "@hono/node-server", "@workflow-catalog/contracts", "@workflow-catalog/job-assistant-eve", "ai", "zod"];

/** The runtime packages missing from runner/node_modules. */
export async function missingDependencies(runnerDir: string): Promise<string[]> {
  const missing: string[] = [];
  for (const name of REQUIRED_PACKAGES) {
    try {
      await access(path.join(runnerDir, "node_modules", name, "package.json"));
    } catch {
      missing.push(name);
    }
  }
  return missing;
}

function nodeItem(version: string): DoctorItem {
  const major = Number(version.split(".")[0]);
  const label = "Node 24 present";
  if (Number.isInteger(major) && major >= MIN_NODE_MAJOR) return { id: "node", label, status: "ok", detail: `Node ${version}`, required: true };
  return {
    id: "node",
    label,
    status: "fail",
    detail: `Node ${version} is running; the runner needs Node ${MIN_NODE_MAJOR} or newer.`,
    required: true,
    fix: `Install Node ${MIN_NODE_MAJOR} (https://nodejs.org), then run \`corepack enable\` and \`pnpm install\` at the repo root.`,
  };
}

async function runnerItem(deps: DoctorDeps): Promise<DoctorItem> {
  const label = "Runner installed";
  const missing = await (deps.dependenciesInstalled ?? missingDependencies)(deps.runnerDir ?? RUNNER_DIR);
  if (missing.length > 0) {
    return {
      id: "runner",
      label,
      status: "fail",
      detail: `Missing packages: ${missing.join(", ")}.`,
      required: true,
      fix: "Run `corepack enable` and `pnpm install --frozen-lockfile` at the repo root.",
    };
  }
  const { settings } = deps;
  if (!settings.envFileFound || !settings.routePassword || !settings.uiToken) {
    return {
      id: "runner",
      label,
      status: "fail",
      detail: "Packages are installed, but setup has not finished (runner/.env.local is missing its secrets).",
      required: true,
      fix: "Run `npm run setup` in runner/.",
    };
  }
  return { id: "runner", label, status: "ok", detail: "Packages installed and setup done.", required: true };
}

/** A successful live check of exactly this provider and model. */
export function isVerified(check: ModelCheck | undefined, model: ModelSettings): boolean {
  return check !== undefined && check.ok && check.provider === model.provider && check.model === model.model;
}

async function providerItem(deps: DoctorDeps, workspace: Workspace | undefined): Promise<DoctorItem> {
  const label = "Provider connected";
  const { settings } = deps;
  const model = settings.model;
  if (!model) {
    return { id: "provider", label, status: "fail", detail: settings.modelError ?? "No model is configured.", required: true, fix: "Run `npm run setup` in runner/." };
  }
  const name = `${model.provider} ${model.model}`;
  let connected: string;
  if (model.provider === "chatgpt") {
    const codex = await (deps.findCodex ?? locateCodex)(settings);
    if (!codex) {
      return {
        id: "provider",
        label,
        status: "fail",
        detail: `${name}: the Codex CLI is not installed or not on PATH. ChatGPT sign-in runs through it.`,
        required: true,
        fix: "Install the Codex CLI (`npm install -g @openai/codex` or `brew install codex`), run `codex login`, then `npm run setup` again.",
      };
    }
    const status = await (deps.codexStatus ?? ((p: string) => codexLoginStatus(p)))(codex);
    if (!status.loggedIn) {
      return { id: "provider", label, status: "fail", detail: `${name}: Codex is not signed in (${status.detail}).`, required: true, fix: "Run `codex login` and sign in with your ChatGPT account." };
    }
    connected = `${name}, signed in through Codex${status.method ? ` (${status.method})` : ""}`;
  } else {
    const envName = API_KEY_ENV[model.provider];
    const inEnv = Boolean(settings.values[envName] ?? process.env[envName]);
    const inStore = inEnv ? false : await deps.secrets.has(RUNNER_SECRET_SERVICE, API_KEY_SECRET_NAME[model.provider]).catch(() => false);
    if (!inEnv && !inStore) {
      return {
        id: "provider",
        label,
        status: "fail",
        detail: `${name}: no API key found in the keychain or in ${envName}.`,
        required: true,
        fix: `Run \`npm run setup -- --provider ${model.provider}\` to store a key.`,
      };
    }
    connected = `${name}, API key in ${inEnv ? envName : "the OS keychain"}`;
  }
  const check = workspace ? await readModelCheck(workspace).catch(() => undefined) : undefined;
  if (isVerified(check, model)) {
    return { id: "provider", label, status: "ok", detail: `${connected}; model verified ${check?.checkedAt}.`, required: true };
  }
  const failed = check && check.provider === model.provider && check.model === model.model && !check.ok;
  return {
    id: "provider",
    label,
    status: failed ? "fail" : "warn",
    detail: failed ? `${connected}; the last model check failed: ${check.detail ?? "no detail"}` : `${connected}; the model has not been verified yet.`,
    required: true,
    fix: failed ? "Check the model slug (`npm run setup -- --model <slug>`), then `npm run doctor -- --live`." : "Run `npm run doctor -- --live` (one short model call).",
  };
}

async function workspaceItem(settings: RunnerSettings): Promise<{ item: DoctorItem; workspace?: Workspace }> {
  const label = "Workspace chosen";
  if (!settings.workspace) {
    return { item: { id: "workspace", label, status: "fail", detail: "No workspace folder is configured.", required: true, fix: "Run `npm run setup` in runner/." } };
  }
  try {
    const workspace = await Workspace.open(settings.workspace);
    // P02.2's one warning: an ambient RUNNER_WORKSPACE that .env.local's
    // workspace overrode. Not a failure — the runner already resolved and
    // uses .env.local's value (lib/settings.ts), so this only ever flags a
    // stale or leftover environment variable.
    const override = settings.workspaceEnvOverride;
    if (override) {
      return {
        item: {
          id: "workspace",
          label,
          status: "warn",
          detail: `${workspace.root}. The environment also sets RUNNER_WORKSPACE=${override}, which is ignored: the runner uses runner/.env.local's ${workspace.root}.`,
          required: true,
          fix: "Unset RUNNER_WORKSPACE in the environment, or run `npm run setup` to change runner/.env.local's workspace to it.",
        },
        workspace,
      };
    }
    return { item: { id: "workspace", label, status: "ok", detail: workspace.root, required: true }, workspace };
  } catch (error) {
    return { item: { id: "workspace", label, status: "fail", detail: (error as Error).message, required: true, fix: "Run `npm run setup` in runner/." } };
  }
}

async function extensionItem(workspace: Workspace | undefined, clock: Clock): Promise<DoctorItem> {
  const label = "Extension paired";
  const fix = "Run `npm run pair` in runner/ and enter the code on the extension's options page.";
  if (!workspace) return { id: "extension", label, status: "fail", detail: "No workspace yet, so no paired browser.", required: true, fix };
  const active = await new DeviceRegistry(workspace, clock).active();
  if (active.length === 0) return { id: "extension", label, status: "fail", detail: "No browser extension is paired.", required: true, fix };
  return { id: "extension", label, status: "ok", detail: `${active.length} paired device${active.length === 1 ? "" : "s"}.`, required: true };
}

function privacyItem(settings: RunnerSettings): DoctorItem {
  const label = "Privacy settings";
  const missing = [
    ...(settings.privacy.telemetryDisabled ? [] : ["EVE_TELEMETRY_DISABLED=1"]),
    ...(settings.privacy.tracesOff ? [] : ["EVE_TRACES_CONTENT=off"]),
  ];
  if (missing.length === 0) return { id: "privacy", label, status: "ok", detail: "eve telemetry off; trace content off.", required: true };
  return { id: "privacy", label, status: "fail", detail: `Not set: ${missing.join(", ")}.`, required: true, fix: "Run `npm run setup` in runner/." };
}

async function eveItem(deps: DoctorDeps): Promise<DoctorItem> {
  const label = `eve pinned to ${EVE_PIN}`;
  const pin = await (deps.evePin ?? (() => checkEvePin()))();
  if (pin.ok) return { id: "eve", label, status: "ok", detail: `eve ${pin.installed} installed, pinned exactly.`, required: true };
  return { id: "eve", label, status: "fail", detail: pin.problems.join(" "), required: true, fix: "Restore the exact pin and run `pnpm install --frozen-lockfile` at the repo root." };
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const { item: workspace, workspace: opened } = await workspaceItem(deps.settings);
  const items: DoctorItem[] = [
    nodeItem(deps.nodeVersion ?? process.versions.node),
    await runnerItem(deps),
    await providerItem(deps, opened),
    workspace,
    await extensionItem(opened, deps.clock),
    privacyItem(deps.settings),
    await eveItem(deps),
  ];
  return {
    ok: items.every((item) => !item.required || item.status !== "fail"),
    checkedAt: deps.clock.now().toISOString(),
    items,
  };
}

/** Plain-text checklist for the terminal. */
export function formatDoctorReport(report: DoctorReport): string {
  const mark: Record<DoctorStatus, string> = { ok: "[ok]  ", warn: "[warn]", fail: "[FAIL]" };
  const lines = report.items.flatMap((item) => [
    `${mark[item.status]} ${item.label}: ${item.detail}`,
    ...(item.fix && item.status !== "ok" ? [`       fix: ${item.fix}`] : []),
  ]);
  lines.push("", report.ok ? "All required checks pass." : "Some required checks fail; see the fixes above.");
  return lines.join("\n");
}
