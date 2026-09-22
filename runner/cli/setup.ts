import { systemClock } from "../lib/clock.ts";
import { codexLoginStatus, findOnPath } from "../lib/codex.ts";
import { executeForget, planForget } from "../lib/forget.ts";
import { readPackageVersion } from "../lib/package-info.ts";
import { ENV_FILE, REPO_ROOT, RUNNER_DIR } from "../lib/paths.ts";
import { noPrompter, PromptUnavailableError, terminalPrompter } from "../lib/prompt.ts";
import { createOsSecretStore } from "../lib/secret-store.ts";
import { loadSettings } from "../lib/settings.ts";
import { runSetup, SetupError } from "../lib/setup.ts";
import { fail, parseFlags } from "./args.ts";

const USAGE = `npm run setup [-- options]

  --workspace <folder>   where your data lives (default ~/JobAssistant)
  --provider <name>      chatgpt | openai | anthropic | gateway
  --model <slug>         the model; ChatGPT needs one explicitly (e.g. gpt-5.6-luna)
  --api-key-env <VAR>    store the API key held in environment variable VAR
  --yes                  never ask; fail if something required is missing

  --forget               remove everything the runner stored (asks first)
    --keep-workspace     ...but keep the workspace folder
    --dry-run            ...only list what would be removed
    --yes                ...without asking`;

async function forget(flags: Record<string, string | boolean | undefined>): Promise<void> {
  const secrets = createOsSecretStore();
  const settings = await loadSettings();
  const plan = await planForget({
    runnerDir: RUNNER_DIR,
    envFile: ENV_FILE,
    settings,
    secrets,
    keepWorkspace: flags["keep-workspace"] === true,
  });
  const runnerItems = plan.items.filter((item) => item.owner === "runner");
  const eveItems = plan.items.filter((item) => item.owner === "eve");
  if (plan.items.length === 0) console.log("The runner has nothing stored on this computer.");
  if (runnerItems.length > 0) {
    console.log("The runner stored:");
    for (const item of runnerItems) console.log(`  - ${item.label}`);
  }
  if (eveItems.length > 0) {
    console.log("eve's own sign-in (used by every eve project on this computer):");
    for (const item of eveItems) console.log(`  - ${item.label}`);
  }
  for (const note of plan.notes) console.log(`Note: ${note}`);
  if (flags["dry-run"] === true || plan.items.length === 0) return;
  const confirmed = flags.yes === true || (process.stdin.isTTY && (await terminalPrompter().confirm("Remove all of the above?", false)));
  if (!confirmed) {
    console.log("Nothing removed.");
    return;
  }
  const outcome = await executeForget(plan, secrets);
  for (const label of outcome.removed) console.log(`Removed ${label}`);
  for (const { label, error } of outcome.failed) console.error(`Could not remove ${label}: ${error}`);
  if (outcome.failed.length > 0) process.exitCode = 1;
  else console.log("Done. The runner's code is still here; delete the repository folder to remove it too.");
}

async function main(): Promise<void> {
  let flags: Record<string, string | boolean | undefined>;
  try {
    flags = parseFlags(
      process.argv.slice(2),
      {
        workspace: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
        "api-key-env": { type: "string" },
        yes: { type: "boolean" },
        forget: { type: "boolean" },
        "keep-workspace": { type: "boolean" },
        "dry-run": { type: "boolean" },
        help: { type: "boolean" },
      },
      ["forget", "dry-run", "keep-workspace"],
    );
  } catch (error) {
    fail(`${(error as Error).message}\n\n${USAGE}`);
  }
  if (flags.help) {
    console.log(USAGE);
    return;
  }
  if (flags.forget === true) return forget(flags);

  const yes = flags.yes === true;
  if (!yes && !process.stdin.isTTY) fail("Setup is interactive. In a script, pass --yes with --workspace, --provider and --model.");
  try {
    await runSetup(
      {
        workspace: flags.workspace as string | undefined,
        provider: flags.provider as string | undefined,
        model: flags.model as string | undefined,
        apiKeyEnv: flags["api-key-env"] as string | undefined,
        yes,
      },
      {
        envFile: ENV_FILE,
        repoRoot: REPO_ROOT,
        clock: systemClock,
        secrets: createOsSecretStore(),
        prompter: yes ? noPrompter : terminalPrompter(),
        out: (line) => console.log(line),
        findCodex: () => findOnPath("codex"),
        codexStatus: (codexPath) => codexLoginStatus(codexPath),
        packageVersion: await readPackageVersion(),
      },
    );
  } catch (error) {
    if (error instanceof SetupError || error instanceof PromptUnavailableError) fail(`Setup stopped: ${error.message}`);
    throw error;
  }
}

await main();
