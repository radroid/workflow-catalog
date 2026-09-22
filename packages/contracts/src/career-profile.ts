import { z } from "zod";
import { isoDateTimeSchema, nonEmptyStringSchema, uuidSchema } from "./primitives.js";
import { claimSchema } from "./claim.js";
import { sourceSchema } from "./source.js";

/**
 * A single preference or boundary statement the person owns. mvp-spec §5
 * doesn't give an inner shape for `preferences`/`boundaries` beyond naming
 * the two fields; modelled the same way as a claim's identity (an id plus
 * text) so a revision or a template can cite a specific entry, matching the
 * "every claim rendered with its ID so P03 can round-trip it" requirement
 * for the career-profile template — extended here to preferences and
 * boundaries for the same round-trip reason. Assumption to revisit in P03.
 */
export const profileStatementSchema = z
  .object({
    id: uuidSchema,
    text: nonEmptyStringSchema,
  })
  .strict();
export type ProfileStatement = z.infer<typeof profileStatementSchema>;

/**
 * "Readiness" (CONTEXT.md): approval is null until the person has approved
 * the profile at least once. `version` is the profile's own revision
 * counter (distinct from `workflow.json`'s semver package version).
 */
export const careerProfileApprovalSchema = z
  .object({
    version: z.number().int().positive(),
    at: isoDateTimeSchema,
  })
  .strict();
export type CareerProfileApproval = z.infer<typeof careerProfileApprovalSchema>;

export const careerProfileRevisionStatusSchema = z.enum(["proposed", "accepted", "rejected"]);
export type CareerProfileRevisionStatus = z.infer<typeof careerProfileRevisionStatusSchema>;

/**
 * "Revision: A proposed change to an approved career profile that takes
 * effect only when the person accepts it, producing a new profile version."
 * (CONTEXT.md). `resultingVersion`/`decidedAt` are present once the
 * proposal has been accepted or rejected.
 */
export const careerProfileRevisionSchema = z
  .object({
    id: uuidSchema,
    summary: nonEmptyStringSchema,
    proposedAt: isoDateTimeSchema,
    status: careerProfileRevisionStatusSchema,
    resultingVersion: z.number().int().positive().optional(),
    decidedAt: isoDateTimeSchema.optional(),
  })
  .strict();
export type CareerProfileRevision = z.infer<typeof careerProfileRevisionSchema>;

/**
 * mvp-spec §5: "career-profile.json claims[], sources{}, preferences,
 * boundaries, approval{version, at}, revisions[]." `approval` is nullable
 * (never generated/approved yet is a real, common state — see hard-problems.md
 * #1, "generation is locked until readiness").
 */
export const careerProfileSchema = z
  .object({
    claims: z.array(claimSchema),
    sources: sourceSchema,
    preferences: z.array(profileStatementSchema),
    boundaries: z.array(profileStatementSchema),
    approval: careerProfileApprovalSchema.nullable(),
    revisions: z.array(careerProfileRevisionSchema),
  })
  .strict();

export type CareerProfile = z.infer<typeof careerProfileSchema>;
