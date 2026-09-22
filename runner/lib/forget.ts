import { access, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../store/workspace.ts";
import { API_KEY_SECRET_NAME, EVE_SECRET_NAMES, EVE_SECRET_SERVICE, RUNNER_SECRET_SERVICE, type SecretStore } from "./secret-store.ts";
import { realpathNearest } from "./setup.ts";
import type { RunnerSettings } from "./settings.ts";

/**
 * `npm run setup -- --forget`: everything the runner stored, found and
 * removed. What exists anywhere because of the runner:
 *
 *   runner/.env.local                 settings and this install's secrets
 *   runner/.eve/, runner/.output/     eve's build output and local state
 *   runner/.nitro/                    (session content, traces, logs: personal data)
 *   runner/eval-agent/.eve/, .output/ the fixture agent's build (no personal data)
 *   the workspace folder              your data (only when its workspace.json is valid)
 *   OS keychain, "workflow-catalog-runner": openai-key, anthropic-key, ai-gateway-key
 *   OS keychain, "eve": chatgpt, openai-key, anthropic-key, ai-gateway-key, vercel
 *   ~/.eve/connection.json, ~/.eve/auth/chatgpt.json
 *                                     eve's own sign-in state; shared by every eve
 *                                     project on this computer, so listed separately
 *
 * The Codex CLI's ChatGPT sign-in belongs to Codex, not the runner: forget
 * never touches it and explains `codex logout` instead.
 */
export interface ForgetItem {
  readonly owner: "runner" | "eve";
  readonly label: string;
  readonly path?: string;
  readonly secret?: { readonly service: string; readonly name: string };
}

export interface ForgetPlan {
  readonly items: readonly ForgetItem[];
  /** Things forget leaves alone, and why. */
  readonly notes: readonly string[];
}

export interface ForgetDeps {
  readonly runnerDir: string;
  readonly envFile: string;
  readonly settings: RunnerSettings;
  readonly secrets: SecretStore;
  readonly homeDir?: string;
  readonly keepWorkspace?: boolean;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export const RUNNER_LOCAL_STATE: ReadonlyArray<readonly [string, string]> = [
  [".eve", "eve's local state and build: session content and traces"],
  [".output", "eve's built server"],
  [".nitro", "eve's build cache"],
  [path.join("eval-agent", ".eve"), "the eval fixture's eve state"],
  [path.join("eval-agent", ".output"), "the eval fixture's build"],
];

export async function planForget(deps: ForgetDeps): Promise<ForgetPlan> {
  const items: ForgetItem[] = [];
  const notes: string[] = [];
  const homeDir = deps.homeDir ?? os.homedir();

  if (await exists(deps.envFile)) items.push({ owner: "runner", label: "runner/.env.local (settings, route password, local-UI token)", path: deps.envFile });
  for (const [relative, what] of RUNNER_LOCAL_STATE) {
    const target = path.join(deps.runnerDir, relative);
    if (await exists(target)) items.push({ owner: "runner", label: `runner/${relative}/ (${what})`, path: target });
  }

  const workspaceDir = deps.settings.workspace;
  if (workspaceDir && (await exists(workspaceDir))) {
    if (deps.keepWorkspace) {
      notes.push(`Kept the workspace ${workspaceDir} (--keep-workspace).`);
    } else {
      try {
        const workspace = await Workspace.open(workspaceDir);
        const root = workspace.root;
        const home = await realpathNearest(homeDir);
        const runnerReal = await realpathNearest(deps.runnerDir);
        const relativeToRoot = path.relative(root, runnerReal);
        const containsRunner = relativeToRoot === "" || (!relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot));
        if (root === path.parse(root).root || root === home || containsRunner) {
          notes.push(`Not removing ${root}: it is the disk root, your home folder, or contains the runner.`);
        } else {
          items.push({ owner: "runner", label: `the workspace ${root} (your profile, jobs, applications, sessions, runs)`, path: root });
        }
      } catch {
        notes.push(`Not removing ${workspaceDir}: it has no valid workspace.json, so it may not be the runner's. Delete it yourself if it is.`);
      }
    }
  }

  if (deps.secrets.available) {
    for (const name of Object.values(API_KEY_SECRET_NAME)) {
      if (await deps.secrets.has(RUNNER_SECRET_SERVICE, name).catch(() => false)) {
        items.push({ owner: "runner", label: `keychain entry ${RUNNER_SECRET_SERVICE} / ${name}`, secret: { service: RUNNER_SECRET_SERVICE, name } });
      }
    }
    for (const name of EVE_SECRET_NAMES) {
      if (await deps.secrets.has(EVE_SECRET_SERVICE, name).catch(() => false)) {
        items.push({ owner: "eve", label: `keychain entry ${EVE_SECRET_SERVICE} / ${name} (eve's sign-in, shared by every eve project here)`, secret: { service: EVE_SECRET_SERVICE, name } });
      }
    }
  } else {
    notes.push("No OS credential store on this platform, so no keychain entries to remove.");
  }
  for (const relative of [path.join(".eve", "connection.json"), path.join(".eve", "auth", "chatgpt.json")]) {
    const target = path.join(homeDir, relative);
    if (await exists(target)) items.push({ owner: "eve", label: `~/${relative} (eve's sign-in state, shared by every eve project here)`, path: target });
  }

  notes.push("Codex keeps its own ChatGPT sign-in (in ~/.codex); the runner never stored it. Run `codex logout` to remove it.");
  return { items, notes };
}

export interface ForgetOutcome {
  readonly removed: readonly string[];
  readonly failed: ReadonlyArray<{ readonly label: string; readonly error: string }>;
}

export async function executeForget(plan: ForgetPlan, secrets: SecretStore): Promise<ForgetOutcome> {
  const removed: string[] = [];
  const failed: Array<{ label: string; error: string }> = [];
  for (const item of plan.items) {
    try {
      if (item.path) await rm(item.path, { recursive: true, force: true });
      else if (item.secret) await secrets.delete(item.secret.service, item.secret.name);
      removed.push(item.label);
    } catch (error) {
      failed.push({ label: item.label, error: (error as Error).message });
    }
  }
  return { removed, failed };
}
