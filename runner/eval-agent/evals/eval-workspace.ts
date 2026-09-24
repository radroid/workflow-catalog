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
 * `openOrCreateEvalWorkspace` is therefore idempotent by checking the
 * environment variable itself, not by relying on being imported only once:
 * the first call in the run (from whichever file's top-level code reaches
 * it first — discovery imports files one at a time, fully awaiting each
 * before the next, so this is never a race) creates the workspace and
 * claims the variable; every later call, from either file's own copy of
 * this module, sees it already set and opens that same workspace rather
 * than creating a competing one. Both calls still happen at each file's own
 * top level (never inside `test()`), so both still resolve before either
 * file's `test()` runs — discovery completes first, same as always.
 */
export async function openOrCreateEvalWorkspace(): Promise<Workspace> {
  const existing = process.env.RUNNER_WORKSPACE;
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
  process.env.RUNNER_WORKSPACE = workspace.root;
  return workspace;
}
