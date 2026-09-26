import { defineRouteModule } from "../../../../server/route-modules.ts";

// Fixture: status contribution and a start hook with a stop function.
export const started: string[] = [];

export default defineRouteModule({
  status: () => ({ schedules: [] }),
  start: () => {
    started.push("beta-two");
    return () => {
      started.push("beta-two stopped");
    };
  },
});
