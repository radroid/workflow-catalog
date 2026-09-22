import { defineEval } from "eve/evals";
import { equals, includes } from "eve/evals/expect";
import { FIXTURE_PROMPTS, MISSING_TOOL_CALLS } from "../agent/lib/fixture-model.ts";

// The scripted model asks for bash, read_file and jobs__capture_job, none of
// which exist in the runner. eve answers each with an error result, so the
// model learns the tool is unavailable, and none of them becomes a tool
// request in any lifecycle state: nothing runs.
export default defineEval({
  description: "Calls to tools that do not exist (bash, read_file, jobs__capture_job) never become tool requests and never execute.",
  async test(t) {
    const turn = await t.send(FIXTURE_PROMPTS.missingTools);
    t.succeeded();
    for (const call of MISSING_TOOL_CALLS) {
      turn.notCalledTool(call.name);
      t.check(turn.message, includes(`{"name":"${call.name}","isError":true}`)).label(`${call.name} answered with an error`);
    }
    t.check(turn.toolCalls.length, equals(0)).label("no tool requests at all");
  },
});
