import { defineEval } from "eve/evals";
import { FIXTURE_PROMPTS, FIXTURE_TASK_ID } from "../agent/lib/fixture-model.ts";

// open_application_group is approval: always(). A call raises an approval
// request and parks the turn; nothing executes until the person answers.
export default defineEval({
  description: "open_application_group raises an approval request instead of executing.",
  async test(t) {
    const turn = await t.send(FIXTURE_PROMPTS.openGroup);
    t.parked();
    turn.calledTool("open_application_group", { status: "pending", input: { taskIds: [FIXTURE_TASK_ID] }, count: 1 });
    turn.calledTool("open_application_group", { status: "completed", count: 0 });
    turn.session.requireInputRequest({ toolName: "open_application_group" });
  },
});
