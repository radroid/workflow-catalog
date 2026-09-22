import { defineRouteModule } from "../route-modules.ts";

/**
 * GET /api/status: what the status page shows. The install checklist (the
 * same items as `npm run doctor`), the workspace, and whether eve answers.
 * The workspace path is shown only here, on the person's own signed-in page.
 */
export default defineRouteModule({
  api(router, ctx) {
    router.get("/", async (c) => {
      const [checklist, eve] = await Promise.all([ctx.checklist ? ctx.checklist() : undefined, ctx.eve ? ctx.eve.health() : undefined]);
      return c.json({
        packageVersion: ctx.packageVersion,
        workspace: {
          root: ctx.workspace.root,
          workspaceId: ctx.workspace.manifest.workspaceId,
          createdAt: ctx.workspace.manifest.createdAt,
        },
        eve: ctx.eve && eve ? { url: ctx.eve.url, ok: eve.ok, detail: eve.detail ?? null } : null,
        checklist: checklist ?? null,
      });
    });
  },
});
