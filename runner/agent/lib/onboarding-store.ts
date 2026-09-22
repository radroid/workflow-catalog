import { systemClock } from "../../lib/clock.ts";
import { ProfileStore } from "../../store/profile.ts";
import { Workspace } from "../../store/workspace.ts";

/**
 * Opens the onboarding `ProfileStore` against the runner's live workspace
 * (`process.env.RUNNER_WORKSPACE`, the documented P02 pattern that
 * `open_application_group.ts` also reads). Every `"use step"` wrapper in
 * `extract_claims` and `ask_follow_up` calls it, in both app roots.
 *
 * It carries no directive, so either root can import it. Directives compile
 * per app root (docs/spec/research/eve-runtime.md §8 item 14): within one
 * root, imports of `"use workflow"` executors and step modules work; across
 * roots, a re-exported workflow tool fails discovery ("requires a compiled
 * workflow executor") and an imported step fails at run time ("Step … is not
 * registered"). Shared logic therefore lives in directive-free modules like
 * this one, and each root keeps a thin executor and step wrapper.
 *
 * Every write through the store takes the profile lock and reconciles
 * career-profile.md first (D8, D9), so a tool step in the eve process and a
 * bridge route never lose each other's updates.
 */
export async function openStore(): Promise<ProfileStore> {
  const dir = process.env.RUNNER_WORKSPACE;
  if (!dir) throw new Error("RUNNER_WORKSPACE is not set; the runner launcher sets it before the agent starts.");
  const workspace = await Workspace.open(dir);
  return new ProfileStore(workspace, systemClock);
}
