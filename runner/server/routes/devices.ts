import { errorResponse } from "../http.ts";
import { defineRouteModule } from "../route-modules.ts";

/**
 * Paired browsers (mvp-spec §7.5: "revocable from Settings").
 *
 *   GET  /api/devices                   the paired devices, expired ones included
 *   POST /api/devices/<deviceId>/revoke removes the device; its token fails on
 *                                       the very next bridge request
 *
 * Token hashes never leave the store.
 */
export default defineRouteModule({
  api(router, ctx) {
    router.get("/", async (c) => {
      const devices = await ctx.devices.list();
      return c.json({
        devices: devices.map((device) => ({
          deviceId: device.deviceId,
          origin: device.origin,
          pairedAt: device.pairedAt,
          expiresAt: device.expiresAt,
          active: ctx.devices.isActive(device),
        })),
      });
    });

    router.post("/:deviceId/revoke", async (c) => {
      const deviceId = c.req.param("deviceId");
      if (!(await ctx.devices.revoke(deviceId))) return errorResponse(404, "device_not_found", "No paired device has that ID.");
      ctx.log.info(`Revoked device ${deviceId}.`);
      return c.json({ ok: true, revoked: deviceId });
    });
  },
});
