import { defineRouteModule } from "../../../../server/route-modules.ts";

// Fixture: handles job_capture, like second.ts. Loading both is a startup error.
export default defineRouteModule({ events: { job_capture: () => undefined } });
