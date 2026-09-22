import { defineExtension } from "eve/extension";

// The job-assistant eve extension takes no configuration. The runner mounts it
// as `jobs` (runner/agent/extensions/jobs.ts), so its skills appear to the
// model as `jobs__<skill>`. It contributes skills and one instruction fragment
// only: no tools, channels, schedules or hooks. See ../README.md.
export default defineExtension();
