import { defineAgent } from "eve";
import { resolveModel } from "./lib/model.ts";

export default defineAgent({
  // From runner/.env.local, read at runtime (see lib/model.ts).
  model: resolveModel(),
  // No optional built-in tools: no bash, read_file, write_file, web_fetch,
  // web_search, todo, ask_question, agent or task_cancel. Hostile content can
  // only reach the tools the runner authors under agent/tools/. load_skill is
  // added back explicitly in tools/load_skill.ts so the package's skills load.
  defaultTools: false,
});
