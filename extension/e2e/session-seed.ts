/**
 * P07 part C: puts Ready applications and sessions into a harness's scratch
 * workspace through the runner's real stores, the way P06's own tests do
 * (runner/test/session-helpers.ts): a captured job, its structured fields,
 * an application at Ready with one prepared version's documents, then
 * `SessionsStore.create`, which queues the `open_application_group`
 * command for the most recently paired device. Fictional data only
 * (fixtures-policy.md): the companies are Northwind Labs, Fernwood, Harbor,
 * Quill and Ledgerkit, the postings are at jobs.example.
 */
import type { Application } from "@workflow-catalog/contracts";
import { ApplicationsStore, documentPath } from "@workflow-catalog/runner/store/applications.ts";
import { JobsStore } from "@workflow-catalog/runner/store/jobs.ts";
import { SessionsStore, type SessionRecord } from "@workflow-catalog/runner/store/sessions.ts";
import type { BridgeHarness } from "./real-bridge-harness";

export interface FictionalPosting {
  readonly title: string;
  readonly company: string;
}

export const POSTINGS: readonly FictionalPosting[] = [
  { title: "Staff Platform Engineer", company: "Northwind Labs" },
  { title: "Senior Backend Engineer", company: "Fernwood" },
  { title: "Site Reliability Engineer", company: "Harbor" },
  { title: "Data Engineer", company: "Quill" },
  { title: "Product Engineer", company: "Ledgerkit" },
];

export function postingUrl(posting: FictionalPosting, suffix = ""): string {
  const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `https://jobs.example/postings/${slug(posting.company)}-${slug(posting.title)}${suffix}`;
}

/** Ready applications for `postings`, in order; each posting's URL gets `suffix` (to keep URLs unique across sessions). */
export async function seedReady(bridge: BridgeHarness, postings: readonly FictionalPosting[], suffix = ""): Promise<string[]> {
  const { workspace, clock } = bridge.ctx;
  const jobs = new JobsStore(workspace);
  const applications = new ApplicationsStore(workspace, clock);
  const taskIds: string[] = [];
  for (const posting of postings) {
    const url = postingUrl(posting, suffix);
    const captured = await jobs.captureJob({
      url,
      text: `${posting.title} — ${posting.company}\n\n${posting.company} is hiring a ${posting.title}. Fictional posting for tests.`,
      extractorVersion: "extractor@0.1.0",
      capturedAt: clock.now().toISOString(),
    });
    const recorded = await jobs.recordStructured(captured.jobId, captured.revision, { title: posting.title, company: posting.company, requirements: ["Fictional requirement"] });
    if (!recorded.ok) throw new Error(`seedReady: ${recorded.message}`);
    const { application } = await applications.ensureForJob(captured.jobId);
    const createdAt = clock.now().toISOString();
    const documents = (["md", "docx", "pdf"] as const).map((format) => ({
      kind: "resume" as const,
      version: 1,
      format,
      path: documentPath(application.taskId, `resume-v1.${format}`),
      createdAt,
      profileVersion: 1,
      jobRevision: captured.revision,
      idempotencyKey: `${captured.jobId}@${captured.revision}+profile@v1+resume+inputs@000000000000+details@000000000000`,
    }));
    await applications.update(application.taskId, (current) => ({ ...current, stage: "ready", documents }));
    taskIds.push(application.taskId);
  }
  return taskIds;
}

export interface SeededSession {
  readonly sessionId: string;
  readonly commandId: string | undefined;
  readonly taskIds: readonly string[];
}

/** A session for `taskIds`, as the Board's "Start a session" makes it. */
export async function createSession(bridge: BridgeHarness, taskIds: readonly string[], title = "Apply today"): Promise<SeededSession> {
  const result = await new SessionsStore(bridge.ctx.workspace, bridge.ctx.clock).create({ taskIds, title }, bridge.ctx.commands);
  if (!result.ok) throw new Error(`createSession: ${result.code} ${result.taskId ?? ""} ${result.detail ?? ""}`);
  return { sessionId: result.record.sessionId, commandId: result.command?.commandId, taskIds };
}

export async function application(bridge: BridgeHarness, taskId: string): Promise<Application | undefined> {
  return new ApplicationsStore(bridge.ctx.workspace, bridge.ctx.clock).get(taskId);
}

export async function sessionRecord(bridge: BridgeHarness, sessionId: string): Promise<SessionRecord | undefined> {
  return new SessionsStore(bridge.ctx.workspace, bridge.ctx.clock).read(sessionId);
}
