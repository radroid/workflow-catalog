import { systemClock } from "../lib/clock.ts";
import { formatDoctorReport, runDoctor } from "../lib/doctor.ts";
import { liveModelCheck } from "../lib/live-check.ts";
import { API_KEY_ENV, API_KEY_SECRET_NAME, createOsSecretStore, RUNNER_SECRET_SERVICE } from "../lib/secret-store.ts";
import { loadSettings } from "../lib/settings.ts";
import { writeModelCheck } from "../store/model-check.ts";
import { Workspace } from "../store/workspace.ts";
import { fail, parseFlags } from "./args.ts";

/**
 * npm run doctor [-- --json] [-- --live]
 *
 * The install checklist (lib/doctor.ts). Exits 1 while any required item
 * fails. --live first makes one short model call ("Reply with exactly: ok")
 * and records the outcome, so the provider item can turn fully green.
 */
async function main(): Promise<void> {
  let flags: Record<string, string | boolean | undefined>;
  try {
    flags = parseFlags(process.argv.slice(2), { json: { type: "boolean" }, live: { type: "boolean" }, help: { type: "boolean" } }, ["json", "live"]);
  } catch (error) {
    fail(`${(error as Error).message}\n\nnpm run doctor [-- --json] [-- --live]`);
  }
  if (flags.help) {
    console.log("npm run doctor [-- --json] [-- --live]\n\n  --json  machine-readable output\n  --live  also make one short model call to verify the model");
    return;
  }
  const secrets = createOsSecretStore();
  const settings = await loadSettings();

  if (flags.live === true) {
    if (!settings.model || !settings.workspace) {
      if (flags.json !== true) console.log("Skipping the live check: run `npm run setup` first.");
    } else {
      const model = settings.model;
      const apiKey =
        model.provider === "chatgpt"
          ? undefined
          : (settings.values[API_KEY_ENV[model.provider]] ??
            process.env[API_KEY_ENV[model.provider]] ??
            (await secrets.get(RUNNER_SECRET_SERVICE, API_KEY_SECRET_NAME[model.provider]).catch(() => null)) ??
            undefined);
      if (flags.json !== true) console.log(`Checking ${model.provider} ${model.model} with one short call...`);
      const result = await liveModelCheck(model, { apiKey, codexDir: settings.codexDir });
      try {
        const workspace = await Workspace.open(settings.workspace);
        await writeModelCheck(workspace, {
          provider: model.provider,
          model: model.model,
          ok: result.ok,
          checkedAt: systemClock.now().toISOString(),
          via: "doctor",
          ...(result.detail ? { detail: result.detail.slice(0, 500) } : {}),
        });
      } catch {
        // No workspace yet: the workspace item reports that.
      }
      if (flags.json !== true) console.log(result.ok ? "The model answered.\n" : `The model check failed: ${result.detail ?? "no detail"}\n`);
    }
  }

  const report = await runDoctor({ settings, clock: systemClock, secrets });
  console.log(flags.json === true ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
  process.exitCode = report.ok ? 0 : 1;
}

await main();
