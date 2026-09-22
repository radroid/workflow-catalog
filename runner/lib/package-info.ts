import { readFile } from "node:fs/promises";
import path from "node:path";
import { semverSchema } from "@workflow-catalog/contracts";
import { ADAPTER_DIR, EVAL_AGENT_DIR, RUNNER_DIR, WORKFLOW_MANIFEST_FILE } from "./paths.ts";

/** eve is pinned exactly (mvp-spec §8). Bump deliberately, with the changelog open. */
export const EVE_PIN = "0.63.0";

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The installed job-assistant package version (packages/job-assistant/workflow.json). */
export async function readPackageVersion(file = WORKFLOW_MANIFEST_FILE): Promise<string> {
  const manifest = await readJson(file);
  const parsed = semverSchema.safeParse(manifest?.version);
  if (!parsed.success) throw new Error(`${file} has no valid "version".`);
  return parsed.data;
}

export interface EvePinCheck {
  readonly ok: boolean;
  readonly installed?: string;
  readonly problems: readonly string[];
}

function dependencyRange(pkg: Record<string, unknown> | undefined, field: "dependencies" | "devDependencies", name: string): unknown {
  const deps = pkg?.[field];
  return deps && typeof deps === "object" ? (deps as Record<string, unknown>)[name] : undefined;
}

/**
 * eve pinned exactly everywhere it is declared, and the installed copy is that
 * version: runner/package.json, the adapter's devDependency, the eval fixture's
 * app root, and runner/node_modules/eve.
 */
export async function checkEvePin(runnerDir = RUNNER_DIR, adapterDir = ADAPTER_DIR, evalAgentDir = EVAL_AGENT_DIR): Promise<EvePinCheck> {
  const problems: string[] = [];
  const declared: Array<[string, unknown]> = [
    ["runner/package.json", dependencyRange(await readJson(path.join(runnerDir, "package.json")), "dependencies", "eve")],
    ["the eve adapter's package.json", dependencyRange(await readJson(path.join(adapterDir, "package.json")), "devDependencies", "eve")],
    ["runner/eval-agent/package.json", dependencyRange(await readJson(path.join(evalAgentDir, "package.json")), "dependencies", "eve")],
  ];
  for (const [where, range] of declared) {
    if (range !== EVE_PIN) problems.push(`${where} declares eve ${JSON.stringify(range ?? null)}, not exactly ${EVE_PIN}.`);
  }
  const installedPkg = await readJson(path.join(runnerDir, "node_modules", "eve", "package.json"));
  const installed = typeof installedPkg?.version === "string" ? installedPkg.version : undefined;
  if (installed === undefined) problems.push("eve is not installed in runner/node_modules. Run `pnpm install` at the repo root.");
  else if (installed !== EVE_PIN) problems.push(`runner/node_modules has eve ${installed}, not ${EVE_PIN}. Run \`pnpm install --frozen-lockfile\`.`);
  return { ok: problems.length === 0, installed, problems };
}
