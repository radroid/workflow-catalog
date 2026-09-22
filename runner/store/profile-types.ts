import {
  SOURCE_CATEGORIES,
  careerProfileSchema,
  type CareerProfile,
  type CareerProfileApproval,
  type CareerProfileRevision,
  type Claim,
  type ProfileStatement,
  type SourceCategory,
  type SourceEntry,
} from "@workflow-catalog/contracts";

export { SOURCE_CATEGORIES };
export type { CareerProfile, CareerProfileApproval, CareerProfileRevision, Claim, ProfileStatement, SourceCategory, SourceEntry };

/**
 * The onboarding profile's shape, identical to `CareerProfile`
 * (`@workflow-catalog/contracts`) except `sources`, which is a *partial* map
 * here. `source.ts`'s `SourceStatus` deliberately has no "not yet accounted
 * for" value (see its doc comment: "There is deliberately no default value
 * anywhere a sourceStatusSchema is used"), so `careerProfileSchema.sources`
 * can only ever validate once every one of the seven `SOURCE_CATEGORIES` is
 * present. An in-progress accounting therefore cannot be a valid
 * `CareerProfile` yet — the missing *key* is how this module represents
 * "not yet accounted for" instead of inventing a fourth status value the
 * contract doesn't define. `isSourcesComplete`/`toCareerProfile` below are
 * the boundary: `ProfileStore` (`profile.ts`) only ever writes
 * `career-profile.json` once accounting is complete, and from then on the
 * file is always a strictly valid `CareerProfile`.
 */
export interface OnboardingProfile {
  readonly claims: readonly Claim[];
  readonly sources: Partial<Record<SourceCategory, SourceEntry>>;
  readonly preferences: readonly ProfileStatement[];
  readonly boundaries: readonly ProfileStatement[];
  readonly presentation: readonly ProfileStatement[];
  readonly approval: CareerProfileApproval | null;
  readonly revisions: readonly CareerProfileRevision[];
}

/** Every one of the seven categories has an accounting entry. */
export function isSourcesComplete(sources: OnboardingProfile["sources"]): sources is Record<SourceCategory, SourceEntry> {
  return SOURCE_CATEGORIES.every((category) => sources[category] !== undefined);
}

/** The categories still missing an accounting entry, in `SOURCE_CATEGORIES` order. */
export function unaccountedCategories(sources: OnboardingProfile["sources"]): SourceCategory[] {
  return SOURCE_CATEGORIES.filter((category) => sources[category] === undefined);
}

/**
 * Converts to the strict `CareerProfile` contract shape, validated. Throws
 * if source accounting is incomplete — callers check `isSourcesComplete` (or
 * `readiness(...).sourcesAccounted`) first; this function is the single
 * place that enforces the contract can never be handed an incomplete
 * `sources` map.
 */
export function toCareerProfile(profile: OnboardingProfile): CareerProfile {
  if (!isSourcesComplete(profile.sources)) {
    throw new Error(
      `Cannot materialize career-profile.json: ${unaccountedCategories(profile.sources).length} source(s) still unaccounted for.`,
    );
  }
  return careerProfileSchema.parse({
    claims: profile.claims,
    sources: profile.sources,
    preferences: profile.preferences,
    boundaries: profile.boundaries,
    presentation: profile.presentation,
    approval: profile.approval,
    revisions: profile.revisions,
  });
}

export function fromCareerProfile(profile: CareerProfile): OnboardingProfile {
  return profile;
}

/** A brand-new onboarding profile: nothing accounted for, the two standard boundary statements seeded (mvp-spec §3 F5's "Boundaries" section; matches `docs/spec/visuals/index.html`'s walkthrough). */
export function createInitialProfile(newId: () => string): OnboardingProfile {
  return {
    claims: [],
    sources: {},
    preferences: [],
    boundaries: [
      { id: newId(), text: "Do not invent metrics, credentials, or responsibilities." },
      { id: newId(), text: "Do not change employment dates or official titles." },
    ],
    presentation: [],
    approval: null,
    revisions: [],
  };
}
