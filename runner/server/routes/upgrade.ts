import { z } from "zod";
import { applyUpgrade, checkForUpgrade, currentWorkspaceVersion, type UpgradeCheckState } from "../../upgrade/upgrade.ts";
import type { UpgradeFetchDeps } from "../../upgrade/release-source.ts";
import { errorResponse, readBoundedJson, validationErrorResponse } from "../http.ts";
import { defineRouteModule } from "../route-modules.ts";

/**
 * Settings' Upgrade section (F12), mounted at `/api/upgrade`:
 *
 *   GET  /api/upgrade/status    the workspace's own recorded packageVersion,
 *                                read off disk. Makes no network request at
 *                                all — this is what a Settings page load (or
 *                                any later re-poll of "what version is this")
 *                                calls (gate review round 1, F11: loading
 *                                Settings must never reach the network).
 *   GET  /api/upgrade           checks for a release newer than this
 *                                workspace's recorded packageVersion and
 *                                reports it — one GitHub API call (the
 *                                release lookup), never a download, and
 *                                never applies anything. Only the "Check for
 *                                updates" button calls this.
 *   POST /api/upgrade/confirm   { nextVersion }: applies the upgrade the
 *                                person just confirmed, for exactly that
 *                                version (a stale confirmation, built from
 *                                an older GET, is refused — see
 *                                upgrade.ts's `applyUpgrade`). This is the
 *                                first and only request that ever downloads
 *                                the release's tarball and `.sha256`.
 *
 * A factory, not module-level state directly (round-1 pattern from
 * `captures.ts`'s `createCapturesRouteModule`): production wiring (the
 * default export below) always gets the real GitHub fetch; a test builds
 * its own module instance with a fake `UpgradeFetchDeps` in its place, so no
 * test ever touches the network (P10 packet Decisions).
 *
 * One check or one apply at a time per bridge process (the `running` guard,
 * same shape as `model.ts`'s `POST /check`): a double click while one is in
 * flight shares its result rather than firing a second GitHub fetch.
 */
const confirmRequestSchema = z
  .object({
    nextVersion: z.string().min(1),
  })
  .strict();

const MAX_CONFIRM_BODY_BYTES = 256;

function checkResponse(currentVersion: string, check: UpgradeCheckState) {
  return { ...check, currentVersion };
}

export function createUpgradeRouteModule(deps: UpgradeFetchDeps = {}) {
  let runningCheck: Promise<UpgradeCheckState> | undefined;
  let runningApply: Promise<unknown> | undefined;

  return defineRouteModule({
    api(router, ctx) {
      // Zero network: reads workspace.json off disk only, never `deps`. The only path a Settings page load (or
      // any later re-poll) is allowed to call.
      router.get("/status", async (c) => {
        const currentVersion = await currentWorkspaceVersion(ctx.workspace);
        return c.json({ currentVersion });
      });

      router.get("/", async (c) => {
        const currentVersion = await currentWorkspaceVersion(ctx.workspace);
        runningCheck ??= checkForUpgrade(currentVersion, deps).finally(() => {
          runningCheck = undefined;
        });
        const check = await runningCheck;
        if (check.status === "error") ctx.log.warn(`Upgrade check could not complete: ${check.message}`);
        return c.json(checkResponse(currentVersion, check));
      });

      router.post("/confirm", async (c) => {
        const body = await readBoundedJson(c.req.raw, MAX_CONFIRM_BODY_BYTES);
        if (!body.ok) return body.response;
        const parsed = confirmRequestSchema.safeParse(body.value);
        if (!parsed.success) return validationErrorResponse(parsed.error);

        if (runningApply) {
          return errorResponse(409, "upgrade_in_progress", "An upgrade is already being applied.");
        }
        const run = applyUpgrade(ctx.workspace, parsed.data.nextVersion, deps).finally(() => {
          runningApply = undefined;
        });
        runningApply = run;
        const result = await run;

        if (result.status === "upgraded") {
          ctx.log.info(`Upgraded the workspace from ${result.fromVersion} to ${result.toVersion} (${result.ranSteps.length} migration step(s)).`);
          return c.json(result);
        }
        if (result.status === "stale") return errorResponse(409, "upgrade_stale", result.message);
        if (result.status === "up_to_date") return errorResponse(409, "already_up_to_date", "No update is available to confirm.");
        if (result.status === "refused") {
          ctx.log.warn(`Upgrade refused (${result.reason}): ${result.message}`);
          // The standard { ok: false, error: { code, message } } shape (http.ts's errorResponse), not a bespoke
          // one: the Settings page's postJson (ui/assets/runner.js) reads error.message generically for every
          // route, and a refusal should surface in the UI exactly like any other rejected request.
          return errorResponse(422, result.reason, result.message);
        }
        ctx.log.error(`Upgrade could not complete: ${result.message}`);
        return errorResponse(502, "upgrade_failed", result.message);
      });
    },
  });
}

export default createUpgradeRouteModule();
