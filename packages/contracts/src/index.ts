/**
 * `@workflow-catalog/contracts` — every shape shared across the catalog,
 * runner, and extension, as zod schemas plus their inferred types. See
 * `docs/spec/mvp-spec.md` §5 for the authoritative shapes and
 * `docs/spec/research/browser-boundary.md` for the bridge envelopes. An
 * internal workspace package (exports → this file); `pnpm --filter contracts
 * build` additionally emits JSON Schema for each entry in `registry.ts` into
 * `packages/job-assistant/schemas/`.
 */
export * from "./primitives.js";
export * from "./claim.js";
export * from "./source.js";
export * from "./career-profile.js";
export * from "./workspace.js";
export * from "./job-snapshot.js";
export * from "./application.js";
export * from "./session.js";
export * from "./run.js";
export * from "./bridge-envelopes.js";
export * from "./bridge-http.js";
export * from "./workflow-manifest.js";
export * from "./registry.js";
