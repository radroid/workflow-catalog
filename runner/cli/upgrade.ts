import { loadSettings } from "../lib/settings.ts";
import { terminalPrompter } from "../lib/prompt.ts";
import { Workspace, WorkspaceError } from "../store/workspace.ts";
import { applyUpgrade, checkForUpgrade, currentWorkspaceVersion } from "../upgrade/upgrade.ts";
import { fail, parseFlags } from "./args.ts";

/**
 * `npm run upgrade` (F12): checks the workspace's recorded packageVersion
 * against the latest GitHub release, shows the changelog, asks to confirm,
 * then migrates the workspace and records the new version. Thin by design
 * (CLAUDE.md/Owns: "logic lives in runner/upgrade/") — every real decision
 * (what counts as newer, checksum verification, the migration chain) is in
 * `../upgrade/upgrade.ts` and its own tests; this file is only argv, the
 * terminal prompt, and printing the result.
 */
const USAGE = `npm run upgrade [-- options]

  --yes   confirm without asking (fails if the check itself was refused, same as a "no")`;

function printChangelog(changelog: ReadonlyArray<{ version: string; date: string; notes: readonly string[] }>): void {
  for (const entry of changelog) {
    console.log(`  ${entry.version} (${entry.date}):`);
    for (const note of entry.notes) console.log(`    - ${note}`);
  }
}

async function main(): Promise<void> {
  let flags: Record<string, string | boolean | undefined>;
  try {
    flags = parseFlags(process.argv.slice(2), { yes: { type: "boolean" }, help: { type: "boolean" } }, ["yes"]);
  } catch (error) {
    fail(`${(error as Error).message}\n\n${USAGE}`);
  }
  if (flags.help) {
    console.log(USAGE);
    return;
  }

  const settings = await loadSettings();
  if (!settings.workspace) fail("No workspace is set up yet. Run `npm run setup` in runner/ first.");
  let workspace: Workspace;
  try {
    workspace = await Workspace.open(settings.workspace);
  } catch (error) {
    fail(error instanceof WorkspaceError ? error.message : `Could not open the workspace: ${(error as Error).message}`);
  }

  const currentVersion = await currentWorkspaceVersion(workspace);
  console.log(`Checking for a release newer than ${currentVersion}...`);
  const check = await checkForUpgrade(currentVersion);

  if (check.status === "up_to_date") {
    console.log(`Already on the latest release (${currentVersion}). Nothing to do.`);
    return;
  }
  if (check.status === "error") fail(`Could not check for an update: ${check.message}`);
  if (check.status === "refused") fail(`The ${check.nextVersion} update was refused: ${check.message}`);

  console.log(`\nAn update is available: ${check.currentVersion} -> ${check.nextVersion}\n`);
  console.log("Changelog:");
  printChangelog(check.changelog);
  console.log("");

  const yes = flags.yes === true;
  let confirmed = yes;
  if (!confirmed) {
    if (!process.stdin.isTTY) fail("Confirm with --yes in a script, or run this in a terminal.");
    confirmed = await terminalPrompter().confirm(`Update the workspace to ${check.nextVersion}?`, false);
  }
  if (!confirmed) {
    console.log("Not upgraded. Nothing was changed.");
    return;
  }

  const result = await applyUpgrade(workspace, check.nextVersion);
  if (result.status === "upgraded") {
    console.log(`Upgraded ${result.fromVersion} -> ${result.toVersion} (${result.ranSteps.length} migration step${result.ranSteps.length === 1 ? "" : "s"} applied).`);
    return;
  }
  if (result.status === "refused") fail(`Update refused: ${result.message}`);
  if (result.status === "stale") fail(result.message);
  if (result.status === "up_to_date") {
    console.log(`Already on the latest release (${currentVersion}). Nothing to do.`);
    return;
  }
  fail(`Could not complete the update: ${result.message}`);
}

await main();
