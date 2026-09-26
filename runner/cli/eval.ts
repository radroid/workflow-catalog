import { spawn } from "node:child_process";
import { buildAdapter, eveCli } from "../lib/build.ts";
import { EVAL_AGENT_DIR, RUNNER_DIR } from "../lib/paths.ts";
import { PRIVACY_ENV } from "../lib/settings.ts";

/**
 * npm run eval: `eve eval --strict` on the fixture agent (runner/eval-agent/,
 * its own eve app root on mockModel, so no provider or credential is used).
 * The adapter is built first because its skills are copied in at build time
 * and a fresh checkout has none.
 *
 * eve eval always starts its own development server on 127.0.0.1 with an
 * ephemeral port (eve/dist/src/evals/cli/eval.js); it cannot be pinned, and it
 * stops when the eval ends. Extra arguments are passed through to eve eval.
 */
const env = { ...process.env, ...PRIVACY_ENV };
await buildAdapter(env);
const child = spawn(process.execPath, [eveCli(RUNNER_DIR), "eval", "--strict", ...process.argv.slice(2)], {
  cwd: EVAL_AGENT_DIR,
  env,
  stdio: "inherit",
});
child.on("close", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
