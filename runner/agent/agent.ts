import { defineAgent } from "eve";
import { RUNNER_AGENT_OPTIONS } from "./lib/agent-options.ts";
import { resolveModel } from "./lib/model.ts";

export default defineAgent({
  // No optional built-in tools (no shell, file or web tools); see lib/agent-options.ts.
  ...RUNNER_AGENT_OPTIONS,
  // From runner/.env.local, read at runtime; see lib/model.ts.
  model: resolveModel(),
});
