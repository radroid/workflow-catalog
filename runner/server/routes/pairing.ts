import { defineRouteModule } from "../route-modules.ts";

/**
 * Pairing codes from the local UI, the same codes `npm run pair` prints.
 *
 *   GET  /api/pairing         { outstanding }: codes that can still be used
 *   POST /api/pairing/codes   { code, expiresAt }: a new code, 10 minutes, single use
 */
export default defineRouteModule({
  api(router, ctx) {
    router.get("/", async (c) => c.json({ outstanding: await ctx.pairing.outstanding() }));

    router.post("/codes", async (c) => {
      const { code, expiresAt } = await ctx.pairing.issue();
      return c.json({ code, expiresAt: expiresAt.toISOString() });
    });
  },
});
