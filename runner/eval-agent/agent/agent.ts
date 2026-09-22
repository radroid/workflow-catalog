import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
import { RUNNER_AGENT_OPTIONS } from "../../agent/lib/agent-options.ts";
import { respond } from "./lib/fixture-model.ts";

// The runner's agent options with a deterministic model instead of the one
// from settings. Everything else the evals check (tools, sandbox, extension
// mount) is re-exported from runner/agent, not copied.
export default defineAgent({
  ...RUNNER_AGENT_OPTIONS,
  model: mockModel(respond),
  // A mock model has no AI Gateway context-window metadata, and eve refuses to
  // compile compaction without one.
  modelContextWindowTokens: 200_000,
});
