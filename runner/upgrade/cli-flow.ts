import type { Workspace } from "../store/workspace.ts";
import type { UpgradeFetchDeps } from "./release-source.ts";
import { applyUpgrade, checkForUpgrade, currentWorkspaceVersion, type UpgradeApplyResult, type UpgradeCheckState } from "./upgrade.ts";

/**
 * `npm run upgrade`'s actual decision logic, kept here (not in
 * `cli/upgrade.ts`) so it is testable without a real terminal, `process.argv`,
 * or `process.stdin` (P10 packet Owns: "a thin top-level CLI entry
 * `runner/cli/upgrade.ts` (logic lives in `runner/upgrade/`)"). The CLI's
 * confirmation had no test at all before this (gate review round 1, B1a):
 * `ask` is the one injectable seam a test needs to prove that a "no", and a
 * non-interactive run without `--yes`, both leave the workspace exactly as
 * they found it.
 */
export interface UpgradeCliDeps extends UpgradeFetchDeps {
  /** `true` for `--yes`: confirms without asking, same as answering "yes" to `ask`. */
  readonly yes: boolean;
  /** `false` when there is no terminal to ask in (a script, a pipe, CI). */
  readonly isTTY: boolean;
  /** Never called when `yes` is true, and never called when `isTTY` is false. */
  readonly ask: (nextVersion: string) => Promise<boolean>;
  readonly print?: (line: string) => void;
}

export type UpgradeCliOutcome =
  | { readonly kind: "up_to_date"; readonly currentVersion: string }
  | { readonly kind: "check_error"; readonly message: string }
  | { readonly kind: "check_refused"; readonly nextVersion: string; readonly message: string }
  | { readonly kind: "confirmation_unavailable"; readonly message: string }
  | { readonly kind: "declined" }
  | { readonly kind: "applied"; readonly result: Extract<UpgradeApplyResult, { status: "upgraded" }> }
  | { readonly kind: "apply_failed"; readonly result: Exclude<UpgradeApplyResult, { status: "upgraded" }> };

function printChangelog(print: (line: string) => void, check: Extract<UpgradeCheckState, { status: "available" }>): void {
  print(`\nAn update is available: ${check.currentVersion} -> ${check.nextVersion}\n`);
  print(check.releaseNotes.trim().length > 0 ? check.releaseNotes : "(the release has no notes)");
  print("");
}

/**
 * Checks for an update, shows it, and — only after `ask`/`yes` genuinely
 * confirms it — applies it. Every early return (`up_to_date`, `check_error`,
 * `check_refused`, `confirmation_unavailable`, `declined`) happens before
 * `applyUpgrade` is ever called, so the workspace is untouched in every one
 * of those cases; `apply_failed` covers every way `applyUpgrade` itself can
 * decline (`refused`, `stale`, `up_to_date` discovered again, or a plain
 * `error`), which is `applyUpgrade`'s own guarantee, not this function's.
 */
export async function runUpgradeCli(workspace: Workspace, deps: UpgradeCliDeps): Promise<UpgradeCliOutcome> {
  const print = deps.print ?? (() => {});
  const currentVersion = await currentWorkspaceVersion(workspace);
  print(`Checking for a release newer than ${currentVersion}...`);
  const check = await checkForUpgrade(currentVersion, deps);

  if (check.status === "up_to_date") return { kind: "up_to_date", currentVersion };
  if (check.status === "error") return { kind: "check_error", message: check.message };
  if (check.status === "refused") return { kind: "check_refused", nextVersion: check.nextVersion, message: check.message };

  printChangelog(print, check);

  if (!deps.yes && !deps.isTTY) {
    return { kind: "confirmation_unavailable", message: "Confirm with --yes in a script, or run this in a terminal." };
  }
  const confirmed = deps.yes || (await deps.ask(check.nextVersion));
  if (!confirmed) return { kind: "declined" };

  const result = await applyUpgrade(workspace, check.nextVersion, deps);
  if (result.status === "upgraded") return { kind: "applied", result };
  return { kind: "apply_failed", result };
}
