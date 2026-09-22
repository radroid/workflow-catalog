import { z } from "zod";
import { isoDateSchema, nonEmptyStringSchema, semverSchema } from "./primitives";
import { sourceCategorySchema } from "./source";

function noDuplicates<T>(arr: T[]): boolean {
  return new Set(arr).size === arr.length;
}

/** mvp-spec §4, the five MVP-supported connections ("yes" column) — Gmail/calendars/ATS accounts are explicitly "no" and never appear here. */
export const WORKFLOW_CONNECTIONS = [
  "file_upload",
  "pasted_text",
  "url_import",
  "github",
  "social_export_files",
] as const;
export const workflowConnectionSchema = z.enum(WORKFLOW_CONNECTIONS);
export type WorkflowConnection = z.infer<typeof workflowConnectionSchema>;

/** mvp-spec §7.3 / CLAUDE.md: the extension's permissions, exactly. Order matches the proposed manifest in browser-boundary.md. */
export const BROWSER_PERMISSIONS = [
  "activeTab",
  "scripting",
  "tabGroups",
  "storage",
  "sidePanel",
  "alarms",
] as const;
export const browserPermissionSchema = z.enum(BROWSER_PERMISSIONS);
export type BrowserPermission = z.infer<typeof browserPermissionSchema>;

/** browser-boundary.md, "Allowlisted commands are capture after local invocation, open approved group, and report explicit status." */
export const WORKFLOW_ACTIONS = ["capture_job", "open_application_group", "report_status"] as const;
export const workflowActionSchema = z.enum(WORKFLOW_ACTIONS);
export type WorkflowAction = z.infer<typeof workflowActionSchema>;

/** mvp-spec non-goals: "no second runtime adapter" — the adapter enum has exactly one member so the schema itself forecloses a second. */
export const workflowAdapterSchema = z.enum(["eve"]);
export type WorkflowAdapter = z.infer<typeof workflowAdapterSchema>;

/** F12: "npm run upgrade fetches the release, shows the changelog, requires confirmation." */
export const workflowChangelogEntrySchema = z
  .object({
    version: semverSchema,
    date: isoDateSchema,
    notes: z.array(nonEmptyStringSchema).min(1),
  })
  .strict();
export type WorkflowChangelogEntry = z.infer<typeof workflowChangelogEntrySchema>;

/**
 * `packages/job-assistant/workflow.json`'s own shape. Not itself one of the
 * "domain" contracts (Claim, CareerProfile, ...) but the manifest that
 * names them (`schemas`) and the package's capabilities. P01's acceptance:
 * "`workflow.json` validates against `schemas/workflow.schema.json`;
 * version is semver" plus a dedicated test that `browserPermissions` and
 * `actions` equal their exact sets (see `workflow-manifest.test.ts` and
 * `packages/job-assistant/test/workflow.test.ts`) — this schema allows any
 * *subset* of the allowlisted values so it stays useful if a future package
 * version legitimately ships fewer permissions/actions; the exact-set
 * requirement for *this* version's `workflow.json` is asserted as data, not
 * baked into the type.
 */
export const workflowManifestSchema = z
  .object({
    name: nonEmptyStringSchema,
    version: semverSchema,
    description: nonEmptyStringSchema,
    requiredSources: z
      .array(sourceCategorySchema)
      .refine(noDuplicates, "requiredSources must not contain duplicates"),
    connections: z
      .array(workflowConnectionSchema)
      .min(1)
      .refine(noDuplicates, "connections must not contain duplicates"),
    browserPermissions: z
      .array(browserPermissionSchema)
      .refine(noDuplicates, "browserPermissions must not contain duplicates"),
    actions: z.array(workflowActionSchema).refine(noDuplicates, "actions must not contain duplicates"),
    schemas: z.array(nonEmptyStringSchema).refine(noDuplicates, "schemas must not contain duplicates"),
    adapters: z
      .array(workflowAdapterSchema)
      .min(1)
      .refine(noDuplicates, "adapters must not contain duplicates"),
    changelog: z.array(workflowChangelogEntrySchema).min(1),
  })
  .strict();

export type WorkflowManifest = z.infer<typeof workflowManifestSchema>;
