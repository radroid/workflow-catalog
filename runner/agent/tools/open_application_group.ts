import { MAX_APPLICATION_GROUP_SIZE, uuidSchema } from "@workflow-catalog/contracts";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

// The one model-callable action (packages/job-assistant/adapters/eve/README.md).
// P02 ships it as a stub; P06 owns this file and replaces the body.
//
// - Input is task IDs only, never a URL. The body P06 writes resolves each ID
//   to the job URL the runner already stored, so nothing a hostile posting
//   says can become a navigation target. `.strict()` rejects any extra field.
// - approval: always(): the person approves every single call, never once()
//   or auto(). Omitting `approval` would mean never().
export const openApplicationGroupInputSchema = z
  .object({
    taskIds: z.array(uuidSchema).min(1).max(MAX_APPLICATION_GROUP_SIZE),
  })
  .strict();

export default defineTool({
  description:
    "Ask the paired Chrome extension to open one tab group for applications that are ready, identified by their task IDs. The person approves every call before anything opens.",
  inputSchema: openApplicationGroupInputSchema,
  approval: always(),
  async execute({ taskIds }) {
    return {
      status: "not_implemented" as const,
      requestedTasks: taskIds.length,
      message: "open_application_group is not implemented yet. Nothing was opened.",
    };
  },
});
