import { defineRouteModule } from "../../../../server/route-modules.ts";

// Fixture: a module with an API route and a job_capture handler.
export default defineRouteModule({
  api(router) {
    router.get("/", (c) => c.json({ module: "alpha" }));
  },
  events: {
    job_capture: (event) => ({ seen: event.eventId }),
  },
});
