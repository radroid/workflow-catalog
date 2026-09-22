import { z } from "zod";
import {
  httpUrlSchema,
  isoDateTimeSchema,
  MAX_APPLICATION_GROUP_SIZE,
  nonEmptyStringSchema,
  protocolVersionSchema,
  uuidSchema,
} from "./primitives";

/**
 * CONTEXT.md: "Session manifest: The declarative list of browser tasks
 * (task ID, job revision, URL) the extension opens as a tab group." Shared
 * shape with `OpenApplicationGroupPayload.items` in `bridge-envelopes.ts` —
 * the command is how a session manifest reaches the extension.
 */
export const sessionManifestItemSchema = z
  .object({
    taskId: uuidSchema,
    jobRevision: z.number().int().positive(),
    url: httpUrlSchema,
  })
  .strict();
export type SessionManifestItem = z.infer<typeof sessionManifestItemSchema>;

/**
 * mvp-spec §5: `sessions/<sessionId>.json`. The runner-side record an
 * `OpenApplicationGroup` command is derived from — `protocol` and the
 * `MAX_APPLICATION_GROUP_SIZE` ceiling on `items` deliberately match that
 * command's envelope (`OpenApplicationGroupPayload`, `bridge-envelopes.ts`)
 * so a manifest that's valid here can never fail to derive a valid command.
 */
export const sessionManifestSchema = z
  .object({
    protocol: protocolVersionSchema,
    sessionId: uuidSchema,
    title: nonEmptyStringSchema,
    items: z.array(sessionManifestItemSchema).min(1).max(MAX_APPLICATION_GROUP_SIZE),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export type SessionManifest = z.infer<typeof sessionManifestSchema>;
