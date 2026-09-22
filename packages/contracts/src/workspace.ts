import { z } from "zod";
import { isoDateTimeSchema, nonEmptyStringSchema, semverSchema } from "./primitives";

/**
 * mvp-spec §5: `workspace.json` — `{ workspaceId, workflowInstanceId,
 * packageVersion, createdAt }`. `workspaceId`/`workflowInstanceId` are
 * opaque local identifiers (not necessarily UUIDs — the boundary doc only
 * requires UUIDs for records that cross the bridge; these two never leave
 * the local machine), assigned once at `npm run setup` and never reissued.
 */
export const workspaceManifestSchema = z
  .object({
    workspaceId: nonEmptyStringSchema,
    workflowInstanceId: nonEmptyStringSchema,
    packageVersion: semverSchema,
    createdAt: isoDateTimeSchema,
  })
  .strict();

export type WorkspaceManifest = z.infer<typeof workspaceManifestSchema>;
