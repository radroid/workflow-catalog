import { z } from "zod";
import { httpUrlSchema, isoDateTimeSchema, nonEmptyStringSchema, uuidSchema } from "./primitives.js";

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

/** mvp-spec §5: `sessions/<sessionId>.json`. The runner-side record an `OpenApplicationGroup` command is derived from. */
export const sessionManifestSchema = z
  .object({
    sessionId: uuidSchema,
    title: nonEmptyStringSchema,
    items: z.array(sessionManifestItemSchema).min(1),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export type SessionManifest = z.infer<typeof sessionManifestSchema>;
