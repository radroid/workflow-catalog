import { defineWorkflowTool } from "eve/tools";
import { checkPreparation, openPreparationStores } from "../../../agent/lib/prepare-logic.ts";
import {
  prepareApplicationInputSchema,
  prepareApplicationOutputSchema,
  prepareApplicationToolDescription,
  type PrepareApplicationInput,
  type PrepareApplicationOutput,
} from "../../../agent/lib/prepare-schema.ts";

// The eval agent's own thin wrapper around the shared prepare_application
// logic (P05). Directives compile per app root (docs/spec/research/
// eve-runtime.md §8 item 14): within one root, imports of "use workflow"
// executors and step modules work; across roots, a re-exported workflow tool
// fails discovery and an imported step fails at run time. So this root keeps
// its own executor and a one-line step wrapper that calls the directive-free
// runner/agent/lib/prepare-logic.ts, exactly as
// runner/agent/tools/prepare_application.ts does. The logic is never copied
// here, and like the production tool it checks and returns, never writes.

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
