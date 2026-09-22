import { z } from "zod";
import { DAILY_RUN_LIMIT_MAX, DAILY_RUN_LIMIT_MIN, getBudgetState, getBudgetStatus, ITEM_CAP_MAX, ITEM_CAP_MIN, resumeBudget, setBudgetLimits } from "../../store/budget.ts";
import { getRun, listRuns } from "../../store/runs.ts";
import { errorResponse, readBoundedJson, validationErrorResponse } from "../http.ts";
import { defineRouteModule } from "../route-modules.ts";

/**
 * The Runs page and the Settings Budget section (F10/F11, mvp-spec §5),
 * behind the local-UI guard (Host, cookie, same-origin) already applied to
 * everything under /api — none of these handlers re-check it.
 *
 *   GET  /api/runs                 the run log, newest first, bounded ({ runs, invalidCount })
 *   GET  /api/runs/:runId          one run record + its file path; 404 without touching the
 *                                  filesystem when :runId is not a uuid
 *   GET  /api/runs/budget          the full internal budget state (limits, usage, pause)
 *   POST /api/runs/budget          { dailyRunLimit, itemCap }: saves new limits, preserving any pause
 *   POST /api/runs/budget/resume   clears the pause
 *
 * The literal /budget routes are registered before the /:runId route so a
 * request for "budget" is never mistaken for a run id (it wouldn't validate
 * as a uuid anyway, but this keeps route resolution obvious either way).
 */

/** Well under the 1 KiB a `{dailyRunLimit, itemCap}` body ever needs; bounds the request before it is parsed. */
const MAX_BUDGET_BODY_BYTES = 1024;

const setBudgetRequestSchema = z
  .object({
    dailyRunLimit: z.number().int().min(DAILY_RUN_LIMIT_MIN).max(DAILY_RUN_LIMIT_MAX),
    itemCap: z.number().int().min(ITEM_CAP_MIN).max(ITEM_CAP_MAX),
  })
  .strict();

function budgetResponse(state: Awaited<ReturnType<typeof getBudgetState>>) {
  return {
    dailyRunLimit: state.dailyRunLimit,
    itemCap: state.itemCap,
    runsUsedToday: state.runsUsedToday,
    paused: state.paused,
    pausedReason: state.pausedReason ?? null,
    pausedSince: state.pausedSince ?? null,
  };
}

export default defineRouteModule({
  api(router, ctx) {
    router.get("/budget", async (c) => {
      const state = await getBudgetState(ctx.workspace, ctx.clock);
      return c.json(budgetResponse(state));
    });

    router.post("/budget", async (c) => {
      const body = await readBoundedJson(c.req.raw, MAX_BUDGET_BODY_BYTES);
      if (!body.ok) return body.response;
      const parsed = setBudgetRequestSchema.safeParse(body.value);
      if (!parsed.success) return validationErrorResponse(parsed.error);
      await setBudgetLimits(ctx.workspace, parsed.data);
      ctx.log.info("Saved new budget limits.");
      const state = await getBudgetState(ctx.workspace, ctx.clock);
      return c.json(budgetResponse(state));
    });

    router.post("/budget/resume", async (c) => {
      await resumeBudget(ctx.workspace);
      ctx.log.info("Resumed the budget.");
      const state = await getBudgetState(ctx.workspace, ctx.clock);
      return c.json(budgetResponse(state));
    });

    router.get("/", async (c) => {
      const { records, invalidCount } = await listRuns(ctx.workspace, ctx.clock);
      return c.json({ runs: records, invalidCount });
    });

    router.get("/:runId", async (c) => {
      const record = await getRun(ctx.workspace, c.req.param("runId"));
      if (!record) return errorResponse(404, "run_not_found", "No such run.");
      return c.json(record);
    });
  },
  async status(ctx) {
    return { budget: await getBudgetStatus(ctx.workspace, ctx.clock) };
  },
});
