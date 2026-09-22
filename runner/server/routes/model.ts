import { readModelCheck, writeModelCheck } from "../../store/model-check.ts";
import { isVerified } from "../../lib/doctor.ts";
import type { ModelCheckResult } from "../eve-gateway.ts";
import { errorResponse } from "../http.ts";
import { defineRouteModule } from "../route-modules.ts";

/**
 * The configured model and its live check.
 *
 *   GET  /api/model         { model, lastCheck, verified }
 *   POST /api/model/check   one trivial turn through eve ("Reply with exactly:
 *                           ok"); the outcome is saved to
 *                           .runner/model-check.json, which doctor reads.
 *
 * One check at a time: a second click while one runs shares its result, so
 * a double click never spends two model calls.
 */
export default defineRouteModule({
  api(router, ctx) {
    let running: Promise<ModelCheckResult> | undefined;

    router.get("/", async (c) => {
      const lastCheck = (await readModelCheck(ctx.workspace).catch(() => undefined)) ?? null;
      return c.json({
        model: ctx.model ?? null,
        lastCheck,
        verified: ctx.model ? isVerified(lastCheck ?? undefined, ctx.model) : false,
      });
    });

    router.post("/check", async (c) => {
      const model = ctx.model;
      if (!model) return errorResponse(409, "model_not_configured", "No model is configured. Run `npm run setup` in runner/.");
      const eve = ctx.eve;
      if (!eve) return errorResponse(503, "eve_not_running", "eve is not running. Start the runner with `npm run runner`.");
      running ??= eve.checkModel().finally(() => {
        running = undefined;
      });
      const result = await running;
      const checkedAt = ctx.clock.now().toISOString();
      await writeModelCheck(ctx.workspace, {
        provider: model.provider,
        model: model.model,
        ok: result.ok,
        checkedAt,
        via: "runner",
        ...(result.detail ? { detail: result.detail.slice(0, 500) } : {}),
      });
      return c.json({ ok: result.ok, checkedAt, detail: result.detail ?? null, modelId: result.modelId ?? null });
    });
  },
});
