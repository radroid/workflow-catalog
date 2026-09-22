import { z } from "zod";
import { nonEmptyStringSchema } from "./primitives.js";

/**
 * The seven source categories from mvp-spec §3 F4 ("Onboarding by
 * accounting"), in the order the spec lists them. `CareerProfile.sources`
 * (see `career-profile.ts`) is a single object keyed by every one of these —
 * never a partial record — so a category can never be silently absent.
 */
export const SOURCE_CATEGORIES = [
  "resume",
  "previousCoverLetters",
  "portfolioSite",
  "repositories",
  "socialProfiles",
  "workSamples",
  "targetRolesAndPreferences",
] as const;

export type SourceCategory = (typeof SOURCE_CATEGORIES)[number];

export const sourceCategorySchema = z.enum(SOURCE_CATEGORIES);

/**
 * F4: "Each is provided, unavailable, or not applicable; nothing is skipped
 * silently." Values (including the `not_applicable` spelling) are fixed by
 * packet P01's own spec text, verbatim. There is deliberately no default
 * value anywhere a `sourceStatusSchema` is used — see `sourceEntrySchema`
 * below — so the accounting can't be completed by omission.
 */
export const sourceStatusSchema = z.enum(["provided", "unavailable", "not_applicable"]);

export type SourceStatus = z.infer<typeof sourceStatusSchema>;

/** One category's accounting entry: its status, plus an optional human note (e.g. why a source is unavailable). */
export const sourceEntrySchema = z
  .object({
    status: sourceStatusSchema,
    note: nonEmptyStringSchema.optional(),
  })
  .strict();

export type SourceEntry = z.infer<typeof sourceEntrySchema>;

/**
 * The full onboarding accounting: every one of the seven `SOURCE_CATEGORIES`
 * is a *required* key (no `.optional()`, no default). A profile object
 * missing even one key fails validation, which is the mechanism hard-problems.md
 * #1 relies on ("every source category is explicitly provided, unavailable,
 * or not applicable"). Written out explicitly (rather than built
 * programmatically from `SOURCE_CATEGORIES`) so the required-key list is
 * visible to a reader and to `z.toJSONSchema`'s `required` array without
 * relying on `Object.fromEntries` inference; `source.test.ts` asserts the
 * two lists never drift apart.
 */
export const sourceSchema = z
  .object({
    resume: sourceEntrySchema,
    previousCoverLetters: sourceEntrySchema,
    portfolioSite: sourceEntrySchema,
    repositories: sourceEntrySchema,
    socialProfiles: sourceEntrySchema,
    workSamples: sourceEntrySchema,
    targetRolesAndPreferences: sourceEntrySchema,
  })
  .strict();

export type Source = z.infer<typeof sourceSchema>;
