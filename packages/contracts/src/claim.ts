import { z } from "zod";
import { isoDateTimeSchema, nonEmptyStringSchema, uuidSchema } from "./primitives.js";
import { sourceCategorySchema } from "./source.js";

/**
 * mvp-spec §5, verbatim: "Claim `{ id, text, kind: fact|metric|title|date|credential,
 * status: candidate|disputed|confirmed|excluded, source, evidence: {kind:
 * passage|statement, ref, quote}, question?, answeredAt? }`."
 *
 * hard-problems.md #2: preparation may only cite confirmed claim IDs;
 * excluded claims are removed from the prompt context entirely. #1: a claim
 * is a *candidate* until the person confirms, disputes, or excludes it —
 * `status` is never defaulted to `confirmed`.
 */
export const claimKindSchema = z.enum(["fact", "metric", "title", "date", "credential"]);
export type ClaimKind = z.infer<typeof claimKindSchema>;

export const claimStatusSchema = z.enum(["candidate", "disputed", "confirmed", "excluded"]);
export type ClaimStatus = z.infer<typeof claimStatusSchema>;

export const claimEvidenceKindSchema = z.enum(["passage", "statement"]);
export type ClaimEvidenceKind = z.infer<typeof claimEvidenceKindSchema>;

/**
 * "Evidence: A source passage or explicit user statement supporting a
 * claim. Evidence records origin, not independent verification of truth."
 * (CONTEXT.md). `ref` locates the passage/statement (e.g. a source file
 * path plus a paragraph anchor, or a question-answer record ID); `quote` is
 * the exact text.
 */
export const claimEvidenceSchema = z
  .object({
    kind: claimEvidenceKindSchema,
    ref: nonEmptyStringSchema,
    quote: nonEmptyStringSchema,
  })
  .strict();
export type ClaimEvidence = z.infer<typeof claimEvidenceSchema>;

export const claimSchema = z
  .object({
    id: uuidSchema,
    text: nonEmptyStringSchema,
    kind: claimKindSchema,
    status: claimStatusSchema,
    /** Which of the seven source categories (source.ts) surfaced this claim. */
    source: sourceCategorySchema,
    evidence: claimEvidenceSchema,
    /**
     * F4: "Metrics and superlatives always trigger a question." Present
     * only while the claim needs a decision from the person; a confirmed or
     * excluded claim normally has no open `question`.
     */
    question: nonEmptyStringSchema.optional(),
    /** When the open `question` was answered, resolving the claim to `disputed`, `confirmed`, or `excluded`. */
    answeredAt: isoDateTimeSchema.optional(),
  })
  .strict();

export type Claim = z.infer<typeof claimSchema>;
