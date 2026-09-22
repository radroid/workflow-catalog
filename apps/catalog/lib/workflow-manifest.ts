import { workflowManifestSchema, type WorkflowManifest } from "@workflow-catalog/contracts";
// A plain relative import reaching outside apps/catalog into a sibling
// workspace package — the same pattern app/globals.css already uses to
// @import docs/spec/visuals/theme.css. `resolveJsonModule` (tsconfig.base.json)
// makes this a real, statically-typed JSON import: Next's bundler inlines
// the parsed object into the compiled output at build time (no runtime fs
// read of a file outside this app's directory, so nothing here needs an
// outputFileTracingIncludes entry the way /learn's on-demand fs reads do —
// see next.config.ts's comment on that one).
import workflowManifestRaw from "../../../packages/job-assistant/workflow.json";

/**
 * Validates a candidate `workflow.json` shape against the contracts
 * package's `workflowManifestSchema`. `.parse` (the throwing form, not
 * `.safeParse`) on purpose: P09-catalog-site.md part B's acceptance is "a
 * validation failure fails the build," and Next has to import every route's
 * module — including this one, transitively, from the template page — while
 * collecting page data during `next build`, dynamic route or not. Exported
 * on its own (rather than only used inline below) so a test can exercise
 * the failure path without corrupting the real workflow.json on disk.
 */
export function parseWorkflowManifest(raw: unknown): WorkflowManifest {
  return workflowManifestSchema.parse(raw);
}

/** `packages/job-assistant/workflow.json`, parsed and validated once at module load. */
export const workflowManifest: WorkflowManifest = parseWorkflowManifest(workflowManifestRaw);
