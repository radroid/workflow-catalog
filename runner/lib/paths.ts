import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fixed locations, all derived from this file's place in the repo. The
 * runner is used from a whole-repo clone (README "Install"), so the adapter
 * and the job-assistant package are always at these relative paths.
 */
export const RUNNER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(RUNNER_DIR, "..");

/** Secrets and settings for this install (gitignored, mode 0600). eve start loads it too. */
export const ENV_FILE = path.join(RUNNER_DIR, ".env.local");

export const UI_DIR = path.join(RUNNER_DIR, "ui");
export const UI_ASSETS_DIR = path.join(UI_DIR, "assets");
export const ROUTES_DIR = path.join(RUNNER_DIR, "server", "routes");

/** eve's build output and local state. Personal data once the runner has run (README "Privacy"). */
export const EVE_STATE_DIR = path.join(RUNNER_DIR, ".eve");
export const EVE_OUTPUT_DIR = path.join(RUNNER_DIR, ".output");
export const EVAL_AGENT_DIR = path.join(RUNNER_DIR, "eval-agent");

export const JOB_ASSISTANT_DIR = path.join(REPO_ROOT, "packages", "job-assistant");
export const WORKFLOW_MANIFEST_FILE = path.join(JOB_ASSISTANT_DIR, "workflow.json");
export const ADAPTER_DIR = path.join(JOB_ASSISTANT_DIR, "adapters", "eve");

/** The eve CLI installed for this package by pnpm. */
export const EVE_BIN = path.join(RUNNER_DIR, "node_modules", ".bin", process.platform === "win32" ? "eve.cmd" : "eve");
