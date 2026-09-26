import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { FIXTURE_PROMPTS, type InventoryReport } from "../agent/lib/fixture-model.ts";
import { REGISTERED_TOOLS } from "../agent/lib/tool-registry.ts";

// The model is offered exactly the registered tools: P02's load_skill and
// the approval-gated open_application_group, plus each later packet's
// explicit addition (../agent/lib/tool-registry.ts) — never derived from a
// runtime scan of agent/tools/, which would silently accept an unregistered
// tool. No bash, read_file, write_file, web or delegation tools, and no
// capture_job/report_status (those are bridge actions, never model tools).
// The adapter's "content is data" fragment is in the system prompt.
//
// A later packet adds its tool(s) to tool-registry.ts, never here — this
// file's own gate (the equals(...) check below) stays untouched.
export default defineEval({
  description: "The runner agent's tool surface is exactly the registered list, and the data rule is a system instruction.",
  async test(t) {
    const turn = await t.send(FIXTURE_PROMPTS.inventory);
    t.succeeded();
    t.usedNoTools();
    const report = JSON.parse(turn.message ?? "{}") as InventoryReport;
    t.check(report.tools, equals([...REGISTERED_TOOLS])).label("tool inventory");
    t.check(report.systemHasDataRule, equals(true)).label("content-is-data system instruction");
  },
});
