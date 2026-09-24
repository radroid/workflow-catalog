import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ManualClock } from "../../lib/clock.ts";
import { Workspace } from "../../store/workspace.ts";

/**
 * Round-1 review L9: the one place that knows how to create — or reuse —
 * `RUNNER_WORKSPACE` for the whole `eve eval` run. Both `job-extraction.eval.ts`
 * and `onboarding-extraction.eval.ts` call `openOrCreateEvalWorkspace()` from
 * their own module top level; neither assigns `process.env.RUNNER_WORKSPACE`
 * itself, or decides fresh-vs-reuse itself.
 *
 * `eve eval` discovers a `*.eval.ts` file by importing it (it must read the
 * file's `description` before it can decide what to run), and every
 * discovered eval then runs concurrently against one shared dev-host
 * process with one process-wide environment, snapshotted once before any
 * file's `test()` function ever runs. Setting `process.env.RUNNER_WORKSPACE`
 * reactively, inside `test()`, is invisible to that process — confirmed
 * empirically in an earlier version of `onboarding-extraction.eval.ts`
 * (P03's own report): the dev host's own error changed from
 * "RUNNER_WORKSPACE is not set" to a `WorkspaceError` naming the exact path
 * only once the assignment moved to module top level. So the decision has
 * to happen at import time, in each file's own top-level code.
 *
 * This module is *not* a plain "runs once because ESM caches it" singleton
 * the way a shared module normally would be — confirmed empirically (by
 * logging its own pid and `RUNNER_WORKSPACE` on entry) that "eve eval loads
 * this file from a build cache" means each `*.eval.ts` file's own dependency
 * graph is loaded independently: this module's top-level code ran twice in
 * the very same process, back to back, once per importing eval file, not
 * once for the whole run. Relying on plain module-caching ("compute the
 * workspace once, export the value") silently created two different
 * temporary directories and pointed `RUNNER_WORKSPACE` at whichever one
 * happened to finish last — exactly the original bug this file exists to
 * fix, just moved one level down.
 *
 * `openOrCreateEvalWorkspace` is therefore idempotent by checking an
 * environment variable itself, not by relying on being imported only once:
 * the first call in the run (from whichever file's top-level code reaches
 * it first — discovery imports files one at a time, fully awaiting each
 * before the next, so this is never a race) creates the workspace and
 * claims the variable; every later call, from either file's own copy of
 * this module, sees it already set and opens that same workspace rather
 * than creating a competing one. Both calls still happen at each file's own
 * top level (never inside `test()`), so both still resolve before either
 * file's `test()` runs — discovery completes first, same as always.
 *
 * That coordination variable is deliberately *not* `RUNNER_WORKSPACE` itself,
 * even though this function still sets `RUNNER_WORKSPACE` too (the real
 * tool code — `agent/lib/extract-job-logic.ts`, `agent/lib/onboarding-store.ts`
 * — reads only that name, matching the production launcher's contract, and
 * must keep seeing it). Found while chasing a CI-only failure this revision
 * (round-1 review didn't catch it; no local run ever reproduced it): GitHub
 * Actions sets its own `RUNNER_WORKSPACE` for every job, ambiently, before
 * anything in this repo runs — the path to the runner's work folder (one
 * level above the checkout), e.g. `/home/runner/work/workflow-catalog`. Using
 * that same name as the "did I already create one this run" check meant the
 * very first call in a CI run saw a pre-set value it had never written,
 * treated it as an already-created eval workspace, and called
 * `Workspace.open()` on GitHub's checkout-parent folder — which has no
 * `workspace.json`, so it failed with "Run `npm run setup` in runner/."
 * every time, on every commit, invisible locally because a plain shell never
 * has `RUNNER_WORKSPACE` set ambiently. `EVAL_WORKSPACE_COORDINATION_VAR`
 * below is a name of our own invention that nothing else — GitHub Actions
 * reserves several other `RUNNER_*` names too (`RUNNER_TEMP`, `RUNNER_OS`,
 * `RUNNER_ARCH`, ...), so this avoids that whole prefix — could ever set
 * ambiently, so its mere presence really does mean "this module already ran
 * in this process."
 */
const EVAL_WORKSPACE_COORDINATION_VAR = "WORKFLOW_CATALOG_EVAL_WORKSPACE";

export async function openOrCreateEvalWorkspace(): Promise<Workspace> {
  const existing = process.env[EVAL_WORKSPACE_COORDINATION_VAR];
  if (existing) return Workspace.open(existing);
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "wc-eval-workspace-"));
  process.once("exit", () => {
    try {
      rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {
      // Best-effort: this process is exiting either way.
    }
  });
  const workspace = await Workspace.create(path.join(workspaceRoot, "JobAssistant"), { packageVersion: "0.1.0", clock: new ManualClock() });
  process.env[EVAL_WORKSPACE_COORDINATION_VAR] = workspace.root;
  process.env.RUNNER_WORKSPACE = workspace.root;
  return workspace;
}
