import type { z } from "zod";
import { claimSchema } from "./claim";
import { sourceSchema } from "./source";
import { careerProfileSchema } from "./career-profile";
import { workspaceManifestSchema } from "./workspace";
import { jobSnapshotSchema } from "./job-snapshot";
import { applicationSchema } from "./application";
import { sessionManifestSchema } from "./session";
import { runRecordSchema } from "./run";
import {
  applicationStatusChangedSchema,
  browserCommandResultSchema,
  jobCaptureSchema,
  openApplicationGroupSchema,
} from "./bridge-envelopes";
import {
  commandsResponseSchema,
  eventsRequestSchema,
  pairRequestSchema,
  pairResponseSchema,
  statusResponseSchema,
} from "./bridge-http";
import { workflowManifestSchema } from "./workflow-manifest";

/**
 * Every schema this package publishes as JSON Schema, keyed by the file
 * name (without `.schema.json`) it is emitted to under
 * `packages/job-assistant/schemas/`. `scripts/emit-schemas.ts` (the build
 * step) and `schema-drift.test.ts` (the plain-`pnpm test` regression test)
 * both walk this same list, so the two can never name a different set of
 * schemas.
 *
 * Order is the order schemas appear in the P01 packet spec, domain schemas
 * first, then the bridge envelopes, then the bridge HTTP bodies, then the
 * workflow manifest.
 */
export const SCHEMA_REGISTRY: ReadonlyArray<{ readonly name: string; readonly schema: z.ZodType }> = [
  { name: "claim", schema: claimSchema },
  { name: "source", schema: sourceSchema },
  { name: "career-profile", schema: careerProfileSchema },
  { name: "workspace-manifest", schema: workspaceManifestSchema },
  { name: "job-snapshot", schema: jobSnapshotSchema },
  { name: "application", schema: applicationSchema },
  { name: "session-manifest", schema: sessionManifestSchema },
  { name: "run-record", schema: runRecordSchema },
  { name: "open-application-group", schema: openApplicationGroupSchema },
  { name: "browser-command-result", schema: browserCommandResultSchema },
  { name: "job-capture", schema: jobCaptureSchema },
  { name: "application-status-changed", schema: applicationStatusChangedSchema },
  { name: "pair-request", schema: pairRequestSchema },
  { name: "pair-response", schema: pairResponseSchema },
  { name: "commands-response", schema: commandsResponseSchema },
  { name: "events-request", schema: eventsRequestSchema },
  { name: "status-response", schema: statusResponseSchema },
  { name: "workflow", schema: workflowManifestSchema },
];

export type SchemaRegistryEntry = (typeof SCHEMA_REGISTRY)[number];
