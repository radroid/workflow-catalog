import { defineWorkflowTool } from "eve/tools";
import { checkPreparation, openPreparationStores } from "../lib/prepare-logic.ts";
import {
  prepareApplicationInputSchema,
  prepareApplicationOutputSchema,
  prepareApplicationToolDescription,
  type PrepareApplicationInput,
  type PrepareApplicationOutput,
} from "../lib/prepare-schema.ts";

/**
 * The tool module eve discovers under `agent/tools/` (P05).
 *
 * Checks one application's preparation: how each of the job's requirements
 * is met, and the draft, every sentence of which cites confirmed claims by
 * label. Thin and typed, per the P02 rule (README "Extending the runner" §4)
 * and the iter-003 decision (model tools take IDs only): the model passes
 * the application's `taskId`, never a URL, a path or anyone's text but its
 * own draft; the tool reads the preparation the bridge started, and the job
 * snapshot, from the stores. The bridge delivers the claims and the
 * posting's fields as user-turn data in the same prompt, never in a system
 * prompt (mvp-spec §7.2, hard-problems.md #3). It checks and returns, and
 * never writes; the applications route exports and saves after the turn
 * ends ok. Durable (`defineWorkflowTool`).
 *
 * The logic lives in `../lib/prepare-logic.ts` and the schemas in
 * `../lib/prepare-schema.ts`, shared with
 * `eval-agent/agent/tools/prepare_application.ts`. Directives compile per
 * app root (docs/spec/research/eve-runtime.md §8 item 14), so each root
 * keeps this thin executor and a one-line step wrapper, and the logic is
 * written and tested once.
 */

async function checkDraft(input: PrepareApplicationInput): Promise<PrepareApplicationOutput> {
  "use step";
  return checkPreparation(input, await openPreparationStores());
}

export default defineWorkflowTool({
  description: prepareApplicationToolDescription,
  inputSchema: prepareApplicationInputSchema,
  outputSchema: prepareApplicationOutputSchema,
  async execute(input) {
    "use workflow";
    return checkDraft(input);
  },
});
