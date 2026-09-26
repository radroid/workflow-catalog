import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";
import { FIXTURE_PROMPTS } from "../agent/lib/fixture-model.ts";

// defaultTools: false removed load_skill; agent/tools/load_skill.ts adds it
// back. The mounted job-assistant skills load, with no sandbox behind them.
export default defineEval({
  description: "load_skill still works: the mounted jobs__claim-extraction skill loads without a sandbox.",
  async test(t) {
    const turn = await t.send(FIXTURE_PROMPTS.loadSkill);
    t.succeeded();
    t.loadedSkill("jobs__claim-extraction", { count: 1 });
    t.noFailedActions();
    t.check(turn.message, includes('"isError":false')).label("skill result is not an error");
  },
});
