/**
 * `@workflow-catalog/contracts` — every shape shared across the catalog,
 * runner, and extension, as zod schemas plus their inferred types. See
 * `docs/spec/mvp-spec.md` §5 for the authoritative shapes and
 * `docs/spec/research/browser-boundary.md` for the bridge envelopes. An
 * internal workspace package (exports → this file); `pnpm --filter contracts
 * build` additionally emits JSON Schema for each entry in `registry.ts` into
 * `packages/job-assistant/schemas/`.
 */
export * from "./primitives";
export * from "./claim";
export * from "./source";
export * from "./career-profile";
export * from "./workspace";
export * from "./job-snapshot";
export * from "./application";
export * from "./session";
export * from "./run";
export * from "./bridge-envelopes";
export * from "./bridge-http";
export * from "./workflow-manifest";
export * from "./registry";
