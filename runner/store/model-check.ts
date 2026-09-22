import { z } from "zod";
import type { Workspace } from "./workspace.ts";

/**
 * The last live check of the configured model (`npm run doctor -- --live`, or
 * "Check the model" on the status page), in `.runner/model-check.json`. Doctor
 * reports the model as verified only when this record is a success for the
 * provider and model configured now. No prompt or reply text is kept.
 */
export const modelCheckSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
    ok: z.boolean(),
    checkedAt: z.string(),
    via: z.enum(["doctor", "runner"]),
    /** A short reason when ok is false. */
    detail: z.string().max(500).optional(),
  })
  .strict();
export type ModelCheck = z.infer<typeof modelCheckSchema>;

const SEGMENTS = [".runner", "model-check.json"] as const;

export async function readModelCheck(workspace: Workspace): Promise<ModelCheck | undefined> {
  const parsed = modelCheckSchema.safeParse(await workspace.readJson(...SEGMENTS));
  return parsed.success ? parsed.data : undefined;
}

export async function writeModelCheck(workspace: Workspace, check: ModelCheck): Promise<void> {
  await workspace.writeJson(SEGMENTS, modelCheckSchema.parse(check));
}
