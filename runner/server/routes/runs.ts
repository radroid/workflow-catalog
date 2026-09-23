import { z } from "zod";
import type { BudgetStatus } from "@workflow-catalog/contracts";
import {
  BUDGET_UNAVAILABLE_REASON,
  DAILY_RUN_LIMIT_MAX,
  DAILY_RUN_LIMIT_MIN,
  DEFAULT_DAILY_RUN_LIMIT,
  getBudgetState,
  getBudgetStatus,
  ITEM_CAP_MAX,
  ITEM_CAP_MIN,
  resumeBudget,
  setBudgetLimits,
  type BudgetState,
} from "../../store/budget.ts";
import { getRun, listRuns } from "../../store/runs.ts";
import { errorResponse, readBoundedJson, validationErrorResponse } from "../http.ts";
import { defineRouteModule } from "../route-modules.ts";

/**
 * The Runs page and the Settings Budget section (F10/F11, mvp-spec §5),
 * behind the local-UI guard (Host, cookie, same-origin) already applied to
 * everything under /api — none of these handlers re-check it.
 *
 *   GET  /api/runs                 the run log, newest first, bounded ({ runs, invalidCount, skippedFiles })
 *   GET  /api/runs/:runId          one run record + its file path; 404 without touching the
 *                                  filesystem when :runId is not a uuid
 *   GET  /api/runs/budget          the full internal budget state (limits, usage, pause)
 *   POST /api/runs/budget          { dailyRunLimit, itemCap }: saves new limits, preserving any pause
 *   POST /api/runs/budget/resume   clears the stored pause; adds `restoredDefaults`
 *
 * The literal /budget routes are registered before the /:runId route so a
 * request for "budget" is never mistaken for a run id (it wouldn't validate
 * as a uuid anyway, but this keeps route resolution obvious either way).
 *
 * G8 (round-1 revision): every run record here also carries `absolutePath`
 * (store/runs.ts) — local-API-only, never part of `GET /status`'s `budget`
 * contribution below, which stays a plain `BudgetStatus` with no run data.
 */

/** Well under the 1 KiB a `{dailyRunLimit, itemCap}` body ever needs; bounds the request before it is parsed. */
const MAX_BUDGET_BODY_BYTES = 1024;

const setBudgetRequestSchema = z
  .object({
    dailyRunLimit: z.number().int().min(DAILY_RUN_LIMIT_MIN).max(DAILY_RUN_LIMIT_MAX),
    itemCap: z.number().int().min(ITEM_CAP_MIN).max(ITEM_CAP_MAX),
  })
  .strict();

function budgetResponse(state: BudgetState) {
  return {
    dailyRunLimit: state.dailyRunLimit,
    itemCap: state.itemCap,
    runsUsedToday: state.runsUsedToday,
    paused: state.paused,
    pausedReason: state.pausedReason ?? null,
    pausedSince: state.pausedSince ?? null,
    // Which pause is showing (store/budget.ts has the precedence), so Settings words it from the server's state,
    // not from what it saw earlier (I4): "budget_unreadable" (the file is unreadable now; the limits shown are
    // the defaults), "budget_repaired" (a Save rewrote it; paused until Resume), "stored" (e.g. provider limit),
    // "run_log_unreadable" (Resume can't clear it), or null when not paused.
    pauseKind: state.pauseKind ?? null,
    // `corrupt`: the file is unreadable right now. `corruptOrigin`: the pause comes from an unreadable file, now
    // or before a repairing Save.
    corrupt: state.corrupt,
    corruptOrigin: state.pauseKind === "budget_unreadable" || state.pauseKind === "budget_repaired",
    // Today's run folder can't be listed, so runsUsedToday (0) is unknown (I2).
    runLogUnreadable: state.runLogUnreadable,
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
      const { restoredDefaults } = await resumeBudget(ctx.workspace);
      ctx.log.info(restoredDefaults ? "Resumed the budget with the default limits (the file was unreadable)." : "Resumed the budget.");
      const state = await getBudgetState(ctx.workspace, ctx.clock);
      return c.json({ ...budgetResponse(state), restoredDefaults });
    });

    router.get("/", async (c) => {
      const { records, invalidCount, skippedFiles } = await listRuns(ctx.workspace, ctx.clock);
      return c.json({ runs: records, invalidCount, skippedFiles });
    });

    router.get("/:runId", async (c) => {
      const record = await getRun(ctx.workspace, c.req.param("runId"));
      if (!record) return errorResponse(404, "run_not_found", "No such run.");
      return c.json(record);
    });
  },
  // Never throws (I2): GET /status must stay 200 whatever state the workspace is in.
  async status(ctx) {
    let budget: BudgetStatus;
    try {
      budget = await getBudgetStatus(ctx.workspace, ctx.clock);
    } catch (error) {
      ctx.log.error(`GET /status: the budget could not be computed (${error instanceof Error ? error.message : String(error)}); reporting it as paused.`);
      budget = { dailyRunLimit: DEFAULT_DAILY_RUN_LIMIT, runsUsedToday: 0, paused: true, pausedReason: BUDGET_UNAVAILABLE_REASON };
    }
    return { budget };
  },
});
