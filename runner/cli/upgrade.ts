import { loadSettings } from "../lib/settings.ts";
import { terminalPrompter } from "../lib/prompt.ts";
import { Workspace, WorkspaceError } from "../store/workspace.ts";
import { runUpgradeCli } from "../upgrade/cli-flow.ts";
import { fail, parseFlags } from "./args.ts";

/**
 * `npm run upgrade` (F12): checks the workspace's recorded packageVersion
 * against the latest GitHub release, shows the changelog, asks to confirm,
 * then migrates the workspace and records the new version. Thin by design
 * (CLAUDE.md/Owns: "logic lives in runner/upgrade/") — every real decision
 * (what counts as newer, checksum verification, the migration chain, and
 * the confirm/decline logic itself) is in `../upgrade/cli-flow.ts` and
 * `../upgrade/upgrade.ts` and their own tests; this file is only argv, the
 * terminal prompt, and printing the result.
 */
const USAGE = `npm run upgrade [-- options]

  --yes   confirm without asking (fails if the check itself was refused, same as a "no")`;

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

  const outcome = await runUpgradeCli(workspace, {
    yes: flags.yes === true,
    isTTY: process.stdin.isTTY === true,
    ask: (nextVersion) => terminalPrompter().confirm(`Update the workspace to ${nextVersion}?`, false),
    print: (line) => console.log(line),
  });

  switch (outcome.kind) {
    case "up_to_date":
      console.log(`Already on the latest release (${outcome.currentVersion}). Nothing to do.`);
      return;
    case "check_error":
      fail(`Could not check for an update: ${outcome.message}`);
      return;
    case "check_refused":
      fail(`The ${outcome.nextVersion} update was refused: ${outcome.message}`);
      return;
    case "confirmation_unavailable":
      fail(outcome.message);
      return;
    case "declined":
      console.log("Not upgraded. Nothing was changed.");
      return;
    case "applied":
      console.log(`Upgraded ${outcome.result.fromVersion} -> ${outcome.result.toVersion} (${outcome.result.ranSteps.length} migration step${outcome.result.ranSteps.length === 1 ? "" : "s"} applied).`);
      return;
    case "apply_failed":
      if (outcome.result.status === "refused") fail(`Update refused: ${outcome.result.message}`);
      else if (outcome.result.status === "stale") fail(outcome.result.message);
      else if (outcome.result.status === "up_to_date") console.log(`Already on the latest release (${outcome.result.currentVersion}). Nothing to do.`);
      else fail(`Could not complete the update: ${outcome.result.message}`);
      return;
  }
}

await main();
