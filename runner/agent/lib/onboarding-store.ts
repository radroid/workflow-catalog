import { systemClock } from "../../lib/clock.ts";
import { ProfileStore } from "../../store/profile.ts";
import { Workspace } from "../../store/workspace.ts";

/**
 * Opens the onboarding `ProfileStore` against the runner's live workspace
 * (`process.env.RUNNER_WORKSPACE`, the documented P02 pattern —
 * `open_application_group.ts` reads the same variable). Shared by
 * `extract_claims`'s and `ask_follow_up`'s `"use step"` functions, each
 * inlined once per tool module (`agent/tools/extract_claims.ts`'s header
 * comment explains why: eve's workflow bundler needs both the `"use
 * workflow"` executor and, empirically, each `"use step"` function it calls,
 * declared directly in the file it discovers under `agent/tools/` — a step
 * reached only via a cross-eve-app-root import was left unregistered at
 * runtime, "Step function not registered, failing step"; see the P03
 * report). This helper itself carries no workflow/step directive, so unlike
 * those it is freely importable from anywhere, including across app roots.
 */
export async function openStore(): Promise<ProfileStore> {
  const dir = process.env.RUNNER_WORKSPACE;
  if (!dir) throw new Error("RUNNER_WORKSPACE is not set; the runner launcher sets it before the agent starts.");
  const workspace = await Workspace.open(dir);
  return new ProfileStore(workspace, systemClock);
}
