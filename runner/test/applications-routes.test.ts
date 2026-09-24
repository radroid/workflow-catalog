import { randomUUID } from "node:crypto";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { actionsOutsidePreparation, requestedActions } from "../agent/lib/prepare-schema.ts";
import { UI_COOKIE } from "../server/local-ui.ts";
import applicationsModule, { EXCLUDED_PROBLEM_MESSAGE, INTERRUPTED_MESSAGE, keptProblems, waitForPreparationQueue } from "../server/routes/applications.ts";
import type { LoadedRouteModule } from "../server/route-modules.ts";
import { ApplicationsStore } from "../store/applications.ts";
import { getBudgetState, pauseBudget } from "../store/budget.ts";
import { JobsStore } from "../store/jobs.ts";
import { ProfileStore } from "../store/profile.ts";
import { listRuns } from "../store/runs.ts";
import { citedLabels } from "../validate/text.ts";
import { docxAllText, docxText, flat, pdfText } from "./document-text.ts";
import { BRIDGE, makeBridge, UI_TOKEN, type TestBridge } from "./helpers.ts";
import {
  DRAFT_WITH_EXCLUDED_METRIC,
  EXCLUDED_METRIC,
  FERNWOOD_JOB,
  fixtureJob,
  GOOD_COVER_LETTER,
  GOOD_RESUME,
  HOSTILE_JOB,
  INJECTION_PHRASES,
  parsePreparationPrompt,
  PERSON,
  platformLeadJob,
  profileFilesHash,
  scriptedModel,
  seedDetails,
  seedJob,
  seedReadyProfile,
  type ParsedPrompt,
  type Planner,
  type ScriptedInput,
  type ScriptedModel,
  type SeedProfileOptions,
  type TurnPlan,
} from "./preparation-helpers.ts";

/**
 * `/api/applications` (P05): the preparation pipeline end to end, through a
 * fake eve gateway whose scripted model calls the real `prepare_application`
 * check (test/preparation-helpers.ts). No live model and no network: every
 * turn is scripted, and every document is read back from the bridge's own
 * download route. Fictional data only (Ada Quill; Northwind Labs, Fernwood,
 * Harbor, Quill, Ledgerkit).
 */

const COOKIE = `${UI_COOKIE}=${UI_TOKEN}`;
const SAME_ORIGIN = { cookie: COOKIE, origin: BRIDGE, "content-type": "application/json", "sec-fetch-site": "same-origin" };
const MODULES: readonly LoadedRouteModule[] = [{ name: "applications", module: applicationsModule }];

// --- The views the tests read ---------------------------------------------------

interface StateView {
  readonly status: string;
  readonly message: string;
  readonly open?: number;
}

interface FileView {
  readonly kind: string;
  readonly format: string;
  readonly name: string;
  readonly label: string;
  readonly href: string;
  readonly download: string;
  readonly missing: string[];
}

interface StatementView {
  readonly part: string;
  readonly heading?: string;
  readonly text: string;
  readonly labels: string[];
  readonly sources: Array<{ readonly label: string; readonly kind: string; readonly text: string }>;
  readonly change: string;
}

interface VersionView {
  readonly version: number;
  readonly replaces: number | null;
  readonly replacedBy: number | null;
  readonly sameDraftAs: number | null;
  readonly olderDetails: boolean;
  readonly profileVersion: number;
  readonly jobRevision: number;
  readonly coverLetter: boolean;
  readonly files: FileView[];
  readonly statements: StatementView[];
  readonly changes: Array<{ readonly kind: string; readonly text?: string; readonly labels: string[]; readonly noLongerConfirmed?: string[] }>;
  readonly olderProfile: boolean;
  readonly noLongerConfirmed: string[];
}

interface DetailView {
  readonly taskId: string;
  readonly jobId: string;
  readonly jobName: string;
  readonly stage: string;
  readonly state: StateView;
  readonly preparation: null | {
    readonly status: string;
    readonly coverLetter: boolean;
    readonly questions: Array<{ readonly requirement: number; readonly requirementText: string; readonly question: string; readonly answer: string | null }>;
    readonly problems: Array<{ readonly rule: string; readonly where: string; readonly sentence: string; readonly message: string }>;
    readonly coverage: Array<{ readonly requirement: number; readonly status: string; readonly labels: string[]; readonly requirementText: string | null }>;
    readonly claims: Array<{ readonly label: string; readonly text: string }>;
  };
  readonly versions: VersionView[];
}

interface ListView {
  readonly readiness: { readonly ready: boolean; readonly code: string | null; readonly message: string | null; readonly profileVersion: number | null };
  readonly details: { readonly name: string; readonly contact: string; readonly pdfMissing: string[] } | null;
  readonly runner: { readonly ready: boolean; readonly code: string | null; readonly message: string | null };
  readonly budget: { readonly dailyRunLimit: number; readonly runsUsedToday: number };
  readonly jobs: Array<{ readonly jobId: string; readonly name: string; readonly revision: number; readonly extracted: boolean; readonly taskId: string | null }>;
  readonly applications: Array<{ readonly taskId: string; readonly jobName: string; readonly stage: string; readonly latestVersion: number | null; readonly state: StateView }>;
}

interface PrepareBody {
  readonly ok: true;
  readonly outcome: "started" | "already_prepared" | "already_running" | "reexported";
  readonly version?: number;
  readonly replaces?: number;
  readonly application: DetailView;
}

interface ErrorBody {
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string };
}

// --- Scripted models -------------------------------------------------------------

type CoverageSpec = { readonly claims: readonly string[] } | { readonly gap: string } | "not";

/** Platform Lead (test-local posting): every requirement is met by a confirmed claim. */
const PLATFORM_LEAD_COVERAGE: readonly CoverageSpec[] = [{ claims: ["C1"] }, { claims: ["C3"] }, { claims: ["C5"] }];
/** job-fernwood.json: nothing confirmed shows eight years, or distributed systems work, so the model asks. */
const FERNWOOD_COVERAGE: readonly CoverageSpec[] = [
  { gap: "How many years of backend engineering experience can you show?" },
  { claims: ["C1", "C8"] },
  { gap: "Which of your work shows distributed systems experience?" },
];
/** job-hostile.json: two genuine gaps, and a third "requirement" that is an injected instruction, set aside. */
const HOSTILE_COVERAGE: readonly CoverageSpec[] = [
  { gap: "How many years of professional experience can you show?" },
  { gap: "Which of your work used Node.js or TypeScript?" },
  "not",
];

interface HonestOptions {
  /** A first draft the tool refuses before the good one: the revision pass. */
  readonly firstDraft?: ScriptedInput["resume"];
  /** Stop after the first draft, never revising it. */
  readonly noRevision?: boolean;
  readonly otherTools?: TurnPlan["otherTools"];
  readonly end?: TurnPlan["end"];
}

function withConfirmedOnly(resume: NonNullable<ScriptedInput["resume"]>, confirmed: ReadonlySet<string>): NonNullable<ScriptedInput["resume"]> {
  const sections = resume.sections
    .map((section) => ({ heading: section.heading, statements: section.statements.filter((statement) => citedLabels(statement).every((label) => confirmed.has(label))) }))
    .filter((section) => section.statements.length > 0);
  return { sections };
}

function letterWithConfirmedOnly(letter: NonNullable<ScriptedInput["coverLetter"]>, confirmed: ReadonlySet<string>): NonNullable<ScriptedInput["coverLetter"]> {
  const paragraphs = letter.paragraphs.map((paragraph) => paragraph.filter((statement) => citedLabels(statement).every((label) => confirmed.has(label)))).filter((paragraph) => paragraph.length > 0);
  return { paragraphs };
}

function requirementEntries(coverage: readonly CoverageSpec[], prompt: ParsedPrompt): ScriptedInput["requirements"] {
  const confirmed = new Set(prompt.claims.map((claim) => claim.label));
  return prompt.requirements.map((_text, index) => {
    const requirement = index + 1;
    const spec = coverage[index];
    if (prompt.leaveOut.includes(requirement)) return { requirement, status: "left_out" as const };
    if (spec === "not") return { requirement, status: "not_a_requirement" as const };
    if (spec === undefined) return { requirement, status: "gap" as const, question: `What in your experience meets requirement ${requirement}?` };
    if ("gap" in spec) return { requirement, status: "gap" as const, question: spec.gap };
    return { requirement, status: "covered" as const, claims: spec.claims.filter((label) => confirmed.has(label)) };
  });
}

/**
 * A model that behaves: it accounts for every requirement from the confirmed
 * claims it was shown (asking where none meets one, leaving out what the
 * person said to), and drafts only sentences whose cited claims it was shown.
 */
function honest(coverage: readonly CoverageSpec[], options: HonestOptions = {}): Planner {
  return (prompt) => {
    const confirmed = new Set(prompt.claims.map((claim) => claim.label));
    const requirements = requirementEntries(coverage, prompt);
    const extra = { ...(options.otherTools ? { otherTools: options.otherTools } : {}), ...(options.end ? { end: options.end } : {}) };
    if (requirements.some((entry) => entry.status === "gap")) return { skills: ["claim-matching"], calls: [{ requirements }], ...extra };
    const skills = ["claim-matching", "resume-drafting", ...(prompt.coverLetter ? ["cover-letter-drafting"] : [])];
    const letter = prompt.coverLetter ? { coverLetter: letterWithConfirmedOnly(GOOD_COVER_LETTER, confirmed) } : {};
    const calls: ScriptedInput[] = [];
    if (options.firstDraft) calls.push({ requirements, resume: options.firstDraft, ...letter });
    if (!options.noRevision) calls.push({ requirements, resume: withConfirmedOnly(GOOD_RESUME, confirmed), ...letter });
    return { skills, calls, ...extra };
  };
}

// --- Set-up and requests -----------------------------------------------------------

interface SetupOptions {
  readonly profile?: SeedProfileOptions | false;
  readonly details?: boolean;
  readonly eve?: boolean;
}

async function setup(planner: Planner, options: SetupOptions = {}): Promise<{ bridge: TestBridge; model: ScriptedModel }> {
  const holder: { bridge?: TestBridge } = {};
  const model = scriptedModel(() => ({ workspace: holder.bridge!.workspace, clock: holder.bridge!.clock }), planner);
  const bridge = await makeBridge({ modules: MODULES, ...(options.eve === false ? {} : { eve: model.eve }) });
  holder.bridge = bridge;
  if (options.profile !== false) await seedReadyProfile(bridge.workspace, bridge.clock, options.profile ?? {});
  if (options.details !== false) await seedDetails(bridge.workspace, bridge.clock);
  return { bridge, model };
}

async function post<T>(bridge: TestBridge, pathname: string, body: unknown): Promise<{ status: number; body: T }> {
  const response = await bridge.request(`/api/applications${pathname}`, { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as T };
}

async function get<T>(bridge: TestBridge, pathname: string): Promise<{ status: number; body: T }> {
  const response = await bridge.request(`/api/applications${pathname}`, { headers: { cookie: COOKIE } });
  return { status: response.status, body: (await response.json()) as T };
}

/** Asks to prepare `jobId`, then waits for the queued turn to finish, as a person re-reading the page a moment later would. */
async function prepare(bridge: TestBridge, jobId: string, coverLetter = false): Promise<{ status: number; body: PrepareBody }> {
  const result = await post<PrepareBody>(bridge, "/prepare", { jobId, coverLetter });
  await waitForPreparationQueue(bridge.workspace.root);
  return result;
}

async function detail(bridge: TestBridge, taskId: string): Promise<DetailView> {
  const { status, body } = await get<DetailView>(bridge, `/${taskId}`);
  expect(status).toBe(200);
  return body;
}

async function download(bridge: TestBridge, taskId: string, file: string): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const response = await bridge.request(`/api/applications/${taskId}/docs/${file}`, { headers: { cookie: COOKIE } });
  return { status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) };
}

/** A downloaded document as text: Markdown as it is, DOCX from every XML part, PDF through PDF.js. */
async function documentText(bridge: TestBridge, taskId: string, file: string): Promise<string> {
  const { status, body } = await download(bridge, taskId, file);
  expect(status).toBe(200);
  if (file.endsWith(".docx")) return docxAllText(body);
  if (file.endsWith(".pdf")) return pdfText(body);
  return body.toString("utf8");
}

/** A sentence every happy-path draft states, per document kind (GOOD_RESUME, GOOD_COVER_LETTER), as exported. */
const KNOWN_SENTENCE: Readonly<Record<string, string>> = {
  resume: "Shipped the on-call rotation tooling used by three engineering teams.",
  cover_letter: "Outside work, I maintain Ledgerkit, an open-source ledger reconciliation library.",
};

/**
 * Revision 1 (V6): an absence check proves nothing about a file its reader can't read. So before a test greps a
 * DOCX or PDF for what must not be there, the file must show what must: the person's name, and a sentence it was
 * given. A reader that returned "" (the round-1 reviewer's M10 and M12) fails here.
 */
function expectReadBack(document: { readonly kind: string; readonly format: string; readonly path: string }, text: string): void {
  if (document.format !== "docx" && document.format !== "pdf") return;
  expect(text, `${document.path} holds the person's name`).toContain(PERSON.name);
  expect(text, `${document.path} holds a sentence it was given`).toContain(KNOWN_SENTENCE[document.kind]);
}

async function applicationRecord(bridge: TestBridge, taskId: string) {
  const application = await new ApplicationsStore(bridge.workspace, bridge.clock).get(taskId);
  if (!application) throw new Error("no application record");
  return application;
}

async function rawFile(bridge: TestBridge, ...segments: string[]): Promise<string> {
  return readFile(bridge.workspace.resolve(...segments), "utf8");
}

// --- The pipeline ---------------------------------------------------------------

describe("preparing a saved job", () => {
  it("prepares from confirmed claims only, exports Markdown, DOCX, PDF and the diff, records the profile version, job revision and key on each, and moves the stage to ready", async () => {
    const { bridge, model } = await setup(honest(PLATFORM_LEAD_COVERAGE));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());

    const started = await prepare(bridge, jobId);
    expect(started.status).toBe(200);
    expect(started.body.outcome).toBe("started");
    const taskId = started.body.application.taskId;
    expect(model.prompts).toHaveLength(1);
    expect(model.outputs.map((output) => output.status)).toEqual(["accepted"]);

    const view = await detail(bridge, taskId);
    expect(view.stage).toBe("ready");
    expect(view.state).toEqual({ status: "idle", message: "" });
    expect(view.jobName).toBe("Platform Lead · Fernwood");
    expect(view.versions).toHaveLength(1);
    const [v1] = view.versions;
    expect(v1).toMatchObject({ version: 1, replaces: null, profileVersion: 1, jobRevision: 1, coverLetter: false, olderProfile: false, noLongerConfirmed: [] });
    expect(v1!.files.map((file) => file.name)).toEqual(["resume-v1.md", "resume-v1.docx", "resume-v1.pdf", "diff-v1.md"]);
    // The workspace keeps its own file names; each downloads under the person's name, the document and the job (revision 1, V14).
    expect(v1!.files[0]).toEqual({
      kind: "resume",
      format: "md",
      name: "resume-v1.md",
      label: "Resume · Markdown",
      href: `/api/applications/${taskId}/docs/resume-v1.md`,
      download: "Ada Quill - Resume - Fernwood Platform Lead.md",
      missing: [],
    });
    expect(v1!.files.map((file) => file.download)).toEqual([
      "Ada Quill - Resume - Fernwood Platform Lead.md",
      "Ada Quill - Resume - Fernwood Platform Lead.docx",
      "Ada Quill - Resume - Fernwood Platform Lead.pdf",
      "Ada Quill - What changed in version 1 - Fernwood Platform Lead.md",
    ]);
    // The per-bullet diff: each sentence, the claim behind it, and how its wording differs.
    const onCall = v1!.statements.find((statement) => statement.labels.includes("C3"));
    expect(onCall).toMatchObject({ part: "resume", heading: "Experience", text: "Shipped the on-call rotation tooling used by three engineering teams.", change: "same" });
    expect(onCall!.sources).toEqual([{ label: "C3", kind: "fact", text: "Shipped the on-call rotation tooling used by three engineering teams." }]);
    expect(view.preparation?.coverage.map((entry) => [entry.requirement, entry.status, entry.labels])).toEqual([
      [1, "covered", ["C1"]],
      [2, "covered", ["C3"]],
      [3, "covered", ["C5"]],
    ]);

    const application = await applicationRecord(bridge, taskId);
    expect(application.stage).toBe("ready");
    expect(application.processing.status).toBe("idle");
    const key = application.documents[0]!.idempotencyKey;
    expect(key).toMatch(new RegExp(`^${jobId}@1\\+profile@v1\\+resume\\+inputs@[0-9a-f]{12}\\+details@[0-9a-f]{12}$`));
    expect(application.documents.map((document) => [document.kind, document.format, document.path])).toEqual([
      ["resume", "md", `applications/${taskId}/docs/resume-v1.md`],
      ["resume", "docx", `applications/${taskId}/docs/resume-v1.docx`],
      ["resume", "pdf", `applications/${taskId}/docs/resume-v1.pdf`],
      ["diff", "md", `applications/${taskId}/docs/diff-v1.md`],
    ]);
    for (const document of application.documents) expect(document).toMatchObject({ version: 1, profileVersion: 1, jobRevision: 1, idempotencyKey: key });

    const runs = await listRuns(bridge.workspace, bridge.clock);
    expect(runs.records).toHaveLength(1);
    expect(runs.records[0]).toMatchObject({ kind: "manual", outcome: "success", idempotencyKey: key, runId: application.processing.runId });
    expect(runs.records[0]!.inputs).toMatchObject({ taskId, jobId, jobRevision: 1, profileVersion: 1, coverLetter: false });

    const markdown = await download(bridge, taskId, "resume-v1.md");
    expect(markdown.headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(markdown.headers["content-disposition"]).toBe('attachment; filename="Ada Quill - Resume - Fernwood Platform Lead.md"');
    expect((await download(bridge, taskId, "resume-v1.pdf")).headers["content-disposition"]).toBe('attachment; filename="Ada Quill - Resume - Fernwood Platform Lead.pdf"');
    const text = markdown.body.toString("utf8");
    expect(text).toContain("# Ada Quill");
    expect(text).toContain("- Led the payments infrastructure team at Northwind Labs, redesigning the ledger service behind its billing.");
    expect(text).not.toMatch(/\[C\d+\]/);
    expect(flat(docxText((await download(bridge, taskId, "resume-v1.docx")).body))).toContain("Shipped the on-call rotation tooling used by three engineering teams.");
    expect(flat(await pdfText((await download(bridge, taskId, "resume-v1.pdf")).body))).toContain("Maintainer of Ledgerkit, an open-source ledger reconciliation library.");
    const diff = await documentText(bridge, taskId, "diff-v1.md");
    expect(diff).toContain("Prepared September 22, 2026 from career profile version 1 and job revision 1. This is the first version for this job.");
    expect(diff).toContain("   - Cites C3 (fact): “Shipped the on-call rotation tooling used by three engineering teams.”");
  });

  it("the prompt holds confirmed claims only, and the posting's fields only inside a random data boundary", async () => {
    const { bridge, model } = await setup(honest(PLATFORM_LEAD_COVERAGE), { profile: { harbor: "excluded" } });
    const profile = await new ProfileStore(bridge.workspace, bridge.clock).read();
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    await prepare(bridge, jobId);

    const [prompt] = model.prompts;
    for (const claim of profile.claims) {
      if (claim.status === "confirmed") expect(prompt).toContain(claim.text);
      else {
        expect(prompt).not.toContain(claim.text);
        expect(prompt).not.toContain(claim.id);
      }
      expect(prompt).not.toContain(claim.id); // labels only, never ids
    }
    expect(prompt).not.toContain("[C2]");
    expect(prompt).not.toContain("[C4]");
    const { instructions, data } = parsePreparationPrompt(prompt!);
    expect(instructions).not.toContain("Platform Lead");
    expect(instructions).not.toContain("Fernwood");
    expect(instructions).not.toContain("Open-source maintainership");
    expect(data).toContain("Title: Platform Lead");
    expect(data).toContain("3. Open-source maintainership");
  });

  it("the same job revision and profile version prepare one document: asking again runs nothing and writes nothing", async () => {
    const { bridge, model } = await setup(honest(PLATFORM_LEAD_COVERAGE));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const first = await prepare(bridge, jobId);
    const taskId = first.body.application.taskId;
    const documentsBefore = (await applicationRecord(bridge, taskId)).documents;
    const filesBefore = await readdir(bridge.workspace.resolve("applications", taskId, "docs"));

    const again = await prepare(bridge, jobId);
    expect(again.status).toBe(200);
    expect(again.body.outcome).toBe("already_prepared");
    expect(again.body.version).toBe(1);
    expect(model.prompts).toHaveLength(1);
    expect((await applicationRecord(bridge, taskId)).documents).toEqual(documentsBefore);
    expect(await readdir(bridge.workspace.resolve("applications", taskId, "docs"))).toEqual(filesBefore);
    expect((await listRuns(bridge.workspace, bridge.clock)).records).toHaveLength(1);
  });

  it("a second request while one is running starts nothing", async () => {
    const { bridge, model } = await setup(honest(PLATFORM_LEAD_COVERAGE));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    model.beforeTurn = () => opened;

    const first = await post<PrepareBody>(bridge, "/prepare", { jobId, coverLetter: false });
    expect(first.body.outcome).toBe("started");
    const running = await detail(bridge, first.body.application.taskId);
    expect(running.state).toEqual({ status: "running", message: "Preparing now. This can take a minute or two." });
    const second = await post<PrepareBody>(bridge, "/prepare", { jobId, coverLetter: false });
    expect(second.body.outcome).toBe("already_running");
    open();
    await waitForPreparationQueue(bridge.workspace.root);
    expect(model.prompts).toHaveLength(1);
    expect((await detail(bridge, first.body.application.taskId)).stage).toBe("ready");
  });

  it("a cover letter is an output option of its own: its own files, and its own key", async () => {
    const { bridge, model } = await setup(honest(PLATFORM_LEAD_COVERAGE));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const first = await prepare(bridge, jobId, true);
    const taskId = first.body.application.taskId;
    expect(model.prompts[0]).toContain("cover-letter-drafting");
    const view = await detail(bridge, taskId);
    expect(view.versions[0]!.files.map((file) => file.name)).toEqual(["resume-v1.md", "resume-v1.docx", "resume-v1.pdf", "cover-v1.md", "cover-v1.docx", "cover-v1.pdf", "diff-v1.md"]);
    const letter = await documentText(bridge, taskId, "cover-v1.md");
    expect(letter).toContain("September 22, 2026");
    expect(letter).toContain("Dear Fernwood hiring team,");
    expect(letter).toContain("Outside work, I maintain Ledgerkit, an open-source ledger reconciliation library.");
    expect(letter).not.toMatch(/\[C\d+\]/);
    expect(flat(await documentText(bridge, taskId, "cover-v1.pdf"))).toContain("I also shipped on-call rotation tooling used by three engineering teams.");
    const key = (await applicationRecord(bridge, taskId)).documents[0]!.idempotencyKey;
    expect(key).toContain("+resume+cover+");

    // The resume alone is a different output: a new version, naming the one before.
    const resumeOnly = await prepare(bridge, jobId, false);
    expect(resumeOnly.body.outcome).toBe("started");
    const after = await detail(bridge, taskId);
    expect(after.versions.map((version) => [version.version, version.replaces, version.coverLetter])).toEqual([
      [2, 1, false],
      [1, null, true],
    ]);
  });

  it("attaches documents to an application that has moved on, without moving its stage back", async () => {
    const { bridge } = await setup(honest(PLATFORM_LEAD_COVERAGE));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const store = new ApplicationsStore(bridge.workspace, bridge.clock);
    const { application } = await store.ensureForJob(jobId);
    await store.update(application.taskId, (current) => ({ ...current, stage: "applied" }));
    await prepare(bridge, jobId);
    const record = await applicationRecord(bridge, application.taskId);
    expect(record.stage).toBe("applied");
    expect(record.documents).toHaveLength(4);
  });
});

describe("a changed profile", () => {
  it("prepares a new version naming the old one when the approved profile's version changes, and keeps the old files", async () => {
    const { bridge } = await setup(honest(PLATFORM_LEAD_COVERAGE));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const first = await prepare(bridge, jobId);
    const taskId = first.body.application.taskId;

    const profiles = new ProfileStore(bridge.workspace, bridge.clock);
    const payments = (await profiles.read()).claims[0]!;
    await profiles.editClaimText(payments.id, "Led the payments infrastructure team at Northwind Labs, redesigning the ledger service behind Northwind Labs' billing.");
    const revision = (await profiles.read()).revisions.find((entry) => entry.status === "proposed")!;
    const accepted = await profiles.acceptRevision(revision.id);
    expect(accepted.profile.approval?.version).toBe(2);

    const second = await prepare(bridge, jobId);
    expect(second.body.outcome).toBe("started");
    const view = await detail(bridge, taskId);
    expect(view.versions.map((version) => [version.version, version.replaces, version.profileVersion])).toEqual([
      [2, 1, 2],
      [1, null, 1],
    ]);
    expect(view.versions[1]!.olderProfile).toBe(true);
    const diff = await documentText(bridge, taskId, "diff-v2.md");
    expect(diff).toContain("Prepared September 22, 2026 from career profile version 2 and job revision 1. It replaces version 1.");
    expect(diff).toContain("## Since version 1");
    const application = await applicationRecord(bridge, taskId);
    expect(application.documents.filter((document) => document.version === 2).every((document) => document.profileVersion === 2)).toBe(true);
    expect((await download(bridge, taskId, "resume-v1.md")).status).toBe(200);
  });

  it("an exclusion keeps the profile's version but still prepares anew: the new version drops the sentence and says why", async () => {
    const { bridge } = await setup(honest(PLATFORM_LEAD_COVERAGE));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const first = await prepare(bridge, jobId);
    const taskId = first.body.application.taskId;
    const firstKey = (await applicationRecord(bridge, taskId)).documents[0]!.idempotencyKey;

    const profiles = new ProfileStore(bridge.workspace, bridge.clock);
    const degree = (await profiles.read()).claims[5]!;
    expect(degree.text).toBe("B.S. Computer Science, Fernwood University, 2019.");
    await profiles.decideClaim(degree.id, "excluded");
    expect((await profiles.read()).approval?.version).toBe(1);

    const second = await prepare(bridge, jobId);
    expect(second.body.outcome).toBe("started");
    const application = await applicationRecord(bridge, taskId);
    const secondKey = application.documents.at(-1)!.idempotencyKey;
    expect(secondKey).not.toBe(firstKey);
    expect(secondKey.startsWith(`${jobId}@1+profile@v1+resume+inputs@`)).toBe(true);
    const view = await detail(bridge, taskId);
    expect(view.versions[0]!.changes).toContainEqual({ kind: "removed", part: "resume", heading: "Education", labels: ["C6"], noLongerConfirmed: ["C6"] });
    expect(view.versions[1]!.noLongerConfirmed).toEqual(["C6"]);
    const diff = await documentText(bridge, taskId, "diff-v2.md");
    expect(diff).toContain("- Removed, Resume, Education: the sentence that cited C6, and C6 is no longer a confirmed claim");
    expect(diff).not.toContain("Fernwood University");
    expect(await documentText(bridge, taskId, "resume-v2.md")).not.toContain("B.S.");
  });

  it("a profile that changes while the model works saves nothing", async () => {
    const { bridge, model } = await setup(honest(PLATFORM_LEAD_COVERAGE));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    model.beforeTurn = async () => {
      const profiles = new ProfileStore(bridge.workspace, bridge.clock);
      await profiles.decideClaim((await profiles.read()).claims[5]!.id, "excluded");
    };
    const started = await prepare(bridge, jobId);
    const view = await detail(bridge, started.body.application.taskId);
    expect(model.outputs.map((output) => output.status)).toEqual(["accepted"]);
    expect(view.state).toEqual({ status: "failed", message: "Your career profile changed while this was being prepared, so nothing was saved. Prepare it again." });
    expect(view.stage).toBe("saved");
    expect(view.versions).toEqual([]);
  });
});

describe("the excluded metric (acceptance)", () => {
  it("never reaches the model, and never reaches an exported document in any format, even when a first draft slips it in", async () => {
    const { bridge, model } = await setup(honest(PLATFORM_LEAD_COVERAGE, { firstDraft: DRAFT_WITH_EXCLUDED_METRIC }));
    const excluded = (await new ProfileStore(bridge.workspace, bridge.clock).read()).claims.find((claim) => claim.text === EXCLUDED_METRIC.text)!;
    expect(excluded.status).toBe("excluded");
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const started = await prepare(bridge, jobId, true);
    const taskId = started.body.application.taskId;

    // Nothing of it in the prompt: not its text, its id or its label.
    const [prompt] = model.prompts;
    for (const needle of [EXCLUDED_METRIC.text, "Grew signups", "500%", excluded.id, EXCLUDED_METRIC.id, "[C2]"]) expect(prompt).not.toContain(needle);

    // The tool refused the draft that slipped it in, by place, without naming the claim: the model is told of wording
    // the confirmed claims don't state, never of an excluded claim (revision 1, V10). The revision passed.
    expect(model.outputs.map((output) => output.status)).toEqual(["refused", "accepted"]);
    const refused = model.outputs[0]!;
    expect(refused.problems?.find((problem) => problem.rule === "unknown_citation")?.where).toBe("Resume, Projects, bullet 1");
    expect(refused.problems?.map((problem) => problem.rule)).not.toContain("excluded_claim");
    for (const problem of refused.problems ?? []) {
      expect(problem.message).not.toContain("Grew signups");
      expect(problem.message).not.toContain(excluded.id);
    }
    expect(JSON.stringify(model.outputs)).not.toContain(excluded.id);

    // Every exported file, in every format, read back as text.
    const application = await applicationRecord(bridge, taskId);
    expect(application.documents.map((document) => document.format).sort()).toEqual(["docx", "docx", "md", "md", "md", "pdf", "pdf"]);
    for (const document of application.documents) {
      const text = flat(await documentText(bridge, taskId, document.path.split("/").at(-1)!));
      expectReadBack(document, text);
      for (const needle of ["Grew signups", "500%", "self-serve onboarding", excluded.id, EXCLUDED_METRIC.id]) expect(text, `${document.path} contains “${needle}”`).not.toContain(needle);
    }
    // Nor in what the page is sent, or the version the runner keeps.
    const page = JSON.stringify(await detail(bridge, taskId));
    const version = await rawFile(bridge, "applications", taskId, "versions", "v1.json");
    for (const text of [page, version]) for (const needle of ["Grew signups", "500%", excluded.id]) expect(text).not.toContain(needle);
  });

  it("a draft the tool never accepted saves nothing, and the refusals it keeps never quote the excluded wording", async () => {
    const badNumber = { heading: "Experience", statements: ["Shipped the on-call rotation tooling used by 5 engineering teams [C3]."] };
    const firstDraft = { sections: [...DRAFT_WITH_EXCLUDED_METRIC.sections, badNumber] };
    const { bridge } = await setup(honest(PLATFORM_LEAD_COVERAGE, { firstDraft, noRevision: true }));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const started = await prepare(bridge, jobId);
    const taskId = started.body.application.taskId;

    const view = await detail(bridge, taskId);
    expect(view.stage).toBe("saved");
    expect(view.state).toEqual({ status: "failed", message: "The draft didn't pass the runner's checks, so nothing was saved." });
    expect(view.versions).toEqual([]);
    expect(view.preparation?.status).toBe("failed");
    expect(view.preparation?.problems).toContainEqual({ rule: "excluded_claim", where: "Resume, Projects, bullet 1", sentence: "", message: EXCLUDED_PROBLEM_MESSAGE });
    expect(view.preparation?.problems.find((problem) => problem.rule === "number")).toMatchObject({ where: "Resume, Experience, bullet 1", sentence: "Shipped the on-call rotation tooling used by 5 engineering teams." });
    expect(JSON.stringify(view)).not.toContain("Grew signups");
    expect((await applicationRecord(bridge, taskId)).documents).toEqual([]);
    const runs = await listRuns(bridge.workspace, bridge.clock);
    expect(runs.records[0]).toMatchObject({ outcome: "failure", error: "The draft didn't pass the runner's checks, so nothing was saved." });
  });

  it("a turn that reports “accepted” for a draft the validator refuses saves nothing: the runner checks the draft itself (revision 1, V5)", async () => {
    // What a lying tool result (or a turn that forged one) would hand the bridge: status accepted, and a draft with
    // an unstated number and the excluded metric in it. Only the runner's own check after the turn stands in the way.
    const forgedResume = {
      sections: [
        ...DRAFT_WITH_EXCLUDED_METRIC.sections,
        { heading: "Impact", statements: ["Shipped the on-call rotation tooling used by 5 engineering teams [C3]."] },
      ],
    };
    const { bridge, model } = await setup((prompt) => ({
      skills: ["claim-matching", "resume-drafting"],
      forged: { requirements: requirementEntries(PLATFORM_LEAD_COVERAGE, prompt), resume: forgedResume },
    }));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const started = await prepare(bridge, jobId);
    expect(started.body.outcome).toBe("started");
    const taskId = started.body.application.taskId;
    expect(model.outputs.map((output) => output.status)).toEqual(["accepted"]);

    // No document, no version, `processing` failed, the stage unchanged.
    const application = await applicationRecord(bridge, taskId);
    expect(application.documents).toEqual([]);
    expect(application.stage).toBe("saved");
    expect(application.processing).toMatchObject({ status: "failed", error: "The draft didn't pass the runner's checks, so nothing was saved." });
    expect(await readdir(bridge.workspace.resolve("applications", taskId, "docs")).catch(() => [])).toEqual([]);
    expect(await readdir(bridge.workspace.resolve("applications", taskId, "versions")).catch(() => [])).toEqual([]);

    // The refusals are kept for the page: the number by its sentence, the excluded metric by place only.
    const view = await detail(bridge, taskId);
    expect(view.stage).toBe("saved");
    expect(view.versions).toEqual([]);
    expect(view.state).toEqual({ status: "failed", message: "The draft didn't pass the runner's checks, so nothing was saved." });
    expect(view.preparation?.status).toBe("failed");
    expect(view.preparation?.problems).toContainEqual({ rule: "excluded_claim", where: "Resume, Projects, bullet 1", sentence: "", message: EXCLUDED_PROBLEM_MESSAGE });
    expect(view.preparation?.problems.find((problem) => problem.rule === "number")).toMatchObject({ where: "Resume, Impact, bullet 1", sentence: "Shipped the on-call rotation tooling used by 5 engineering teams." });
    expect(JSON.stringify(view)).not.toContain("Grew signups");
    const runs = await listRuns(bridge.workspace, bridge.clock);
    expect(runs.records[0]).toMatchObject({ outcome: "failure", error: "The draft didn't pass the runner's checks, so nothing was saved." });
  });

  it("keeps one problem per sentence that drew on an excluded claim, with no sentence and no detail", () => {
    const where = "Resume, Projects, bullet 1";
    const sentence = "Grew signups 500% after launching the self-serve onboarding flow.";
    expect(
      keptProblems([
        { rule: "excluded_claim", where, sentence, message: "This sentence repeats wording that none of its cited claims support." },
        { rule: "number", where, sentence, message: "“500%” isn't in the claims this sentence cites (C1)." },
        { rule: "uncited", where: "Resume, Summary, bullet 1", sentence: "Hello.", message: "Every sentence needs the labels…" },
      ]),
    ).toEqual([
      { rule: "excluded_claim", where, sentence: "", message: EXCLUDED_PROBLEM_MESSAGE },
      { rule: "uncited", where: "Resume, Summary, bullet 1", sentence: "Hello.", message: "Every sentence needs the labels…" },
    ]);
  });
});

describe("gap questions", () => {
  it("park the preparation until the person answers, then it continues from their answers", async () => {
    const { bridge, model } = await setup(honest(FERNWOOD_COVERAGE));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, fixtureJob(FERNWOOD_JOB));
    const first = await prepare(bridge, jobId);
    const taskId = first.body.application.taskId;

    let view = await detail(bridge, taskId);
    expect(view.stage).toBe("saved");
    // The line comes from the answers, never the count frozen when the preparation parked (revision 1, V11).
    expect(view.state).toEqual({ status: "parked", message: "2 questions left.", open: 2 });
    expect(view.preparation?.questions).toEqual([
      { requirement: 1, requirementText: "8+ years of backend engineering experience", question: "How many years of backend engineering experience can you show?", answer: null },
      { requirement: 3, requirementText: "Strong distributed systems fundamentals", question: "Which of your work shows distributed systems experience?", answer: null },
    ]);
    expect(view.versions).toEqual([]);
    expect(model.outputs.map((output) => output.status)).toEqual(["questions"]);
    // The run ended; the log says it didn't finish, and why.
    const runs = await listRuns(bridge.workspace, bridge.clock);
    expect(runs.records[0]).toMatchObject({ outcome: "failure", error: "Waiting for your answer to 2 questions." });
    const application = await applicationRecord(bridge, taskId);
    expect(application.processing).toEqual({ status: "failed", runId: runs.records[0]!.runId, error: "Waiting for your answer to 2 questions." });

    // Preparing again before answering is refused plainly, and runs nothing.
    const early = await post<ErrorBody>(bridge, "/prepare", { jobId, coverLetter: false });
    expect(early.status).toBe(409);
    expect(early.body.error).toEqual({ code: "needs_answers", message: "Answer the 2 open questions first; preparation continues after that." });

    const answered = await post<{ ok: boolean; application: DetailView }>(bridge, `/${taskId}/answers`, { requirement: 1, answer: "leave_out" });
    expect(answered.status).toBe(200);
    expect(answered.body.application.preparation?.questions[0]?.answer).toBe("leave_out");
    expect(answered.body.application.state).toEqual({ status: "parked", message: "1 question left.", open: 1 });
    expect((await post<ErrorBody>(bridge, "/prepare", { jobId, coverLetter: false })).body.error.message).toBe("Answer the 1 open question first; preparation continues after that.");
    expect((await post(bridge, `/${taskId}/answers`, { requirement: 3, answer: "leave_out" })).status).toBe(200);
    expect((await detail(bridge, taskId)).state).toEqual({ status: "parked", message: "Ready to continue.", open: 0 });
    const listed = (await get<ListView>(bridge, "")).body.applications.find((entry) => entry.taskId === taskId);
    expect(listed?.state).toEqual({ status: "parked", message: "Ready to continue.", open: 0 });
    expect((await post<ErrorBody>(bridge, `/${taskId}/answers`, { requirement: 2, answer: "leave_out" })).body.error.code).toBe("no_open_question");
    expect(model.prompts).toHaveLength(1);

    const second = await prepare(bridge, jobId);
    expect(second.body.outcome).toBe("started");
    expect(model.prompts[1]).toContain("- Requirement 1: leave it out.");
    expect(model.prompts[1]).toContain("- Requirement 3: leave it out.");
    view = await detail(bridge, taskId);
    expect(view.stage).toBe("ready");
    expect(view.state.status).toBe("idle");
    expect(view.preparation?.coverage.map((entry) => [entry.requirement, entry.status])).toEqual([
      [1, "left_out"],
      [2, "covered"],
      [3, "left_out"],
    ]);
    expect(view.versions).toHaveLength(1);
  });

  it("an answer that the evidence belongs in the profile sends the person there instead of preparing", async () => {
    const { bridge, model } = await setup(honest(FERNWOOD_COVERAGE));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, fixtureJob(FERNWOOD_JOB));
    const first = await prepare(bridge, jobId);
    const taskId = first.body.application.taskId;
    await post(bridge, `/${taskId}/answers`, { requirement: 1, answer: "add_evidence" });
    await post(bridge, `/${taskId}/answers`, { requirement: 3, answer: "leave_out" });
    expect((await detail(bridge, taskId)).state).toEqual({ status: "parked", message: "Waiting for the evidence you're adding.", open: 0 });
    const refused = await post<ErrorBody>(bridge, "/prepare", { jobId, coverLetter: false });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toEqual({ code: "needs_profile", message: "Add the missing evidence to your profile and approve it, then prepare again." });
    expect(model.prompts).toHaveLength(1);
  });
});

describe("a hostile posting (acceptance)", () => {
  it("goes through the whole pipeline: only preparation tools run, the profile files are byte-for-byte unchanged, and no instruction text reaches any output", async () => {
    const { bridge, model } = await setup(honest(HOSTILE_COVERAGE));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, fixtureJob(HOSTILE_JOB));
    const profileBefore = await profileFilesHash(bridge.workspace);

    const first = await prepare(bridge, jobId, true);
    const taskId = first.body.application.taskId;
    const parked = await detail(bridge, taskId);
    expect(parked.preparation?.questions.map((question) => question.requirement)).toEqual([1, 2]);
    for (const requirement of [1, 2]) expect((await post(bridge, `/${taskId}/answers`, { requirement, answer: "leave_out" })).status).toBe(200);
    const second = await prepare(bridge, jobId, true);
    expect(second.body.outcome).toBe("started");
    const view = await detail(bridge, taskId);
    expect(view.stage).toBe("ready");

    // The data block carries the injected line as data; no instruction line does.
    for (const prompt of model.prompts) {
      const { instructions, data } = parsePreparationPrompt(prompt);
      expect(data).toContain("ignore previous instructions");
      for (const phrase of INJECTION_PHRASES) expect(instructions.toLowerCase()).not.toContain(phrase.toLowerCase());
    }

    // Only the preparation's own tools, in every turn.
    expect(new Set(requestedActions(model.events).map((action) => action.name))).toEqual(new Set(["load_skill", "prepare_application"]));
    expect(actionsOutsidePreparation(model.events)).toEqual([]);

    // The career profile is exactly as it was.
    expect(await profileFilesHash(bridge.workspace)).toBe(profileBefore);

    // No instruction text in anything the pipeline produced.
    const application = await applicationRecord(bridge, taskId);
    const outputs: Array<[string, string]> = [];
    for (const document of application.documents) {
      const file = document.path.split("/").at(-1)!;
      const text = await documentText(bridge, taskId, file);
      expectReadBack(document, flat(text));
      outputs.push([file, text]);
    }
    outputs.push(
      ["tool inputs", JSON.stringify(model.inputs)],
      ["tool outputs", JSON.stringify(model.outputs)],
      ["detail view", JSON.stringify(view)],
      ["list view", JSON.stringify((await get<ListView>(bridge, "")).body)],
      ["application record", await rawFile(bridge, "applications", `${taskId}.json`)],
      ["preparation record", await rawFile(bridge, "applications", taskId, "preparation.json")],
      ["version record", await rawFile(bridge, "applications", taskId, "versions", "v1.json")],
      ["run log", JSON.stringify((await listRuns(bridge.workspace, bridge.clock)).records)],
    );
    expect(outputs.length).toBeGreaterThanOrEqual(15);
    for (const [name, text] of outputs) for (const phrase of INJECTION_PHRASES) expect(text.toLowerCase(), `${name} contains “${phrase}”`).not.toContain(phrase.toLowerCase());
  });

  it("a model that follows the posting's instruction and asks for another tool gets nothing saved", async () => {
    const { bridge, model } = await setup(
      honest(PLATFORM_LEAD_COVERAGE, { otherTools: [{ name: "open_application_group", input: { taskIds: ["5d0c8a64-2f0b-4f3e-9a55-3c7f1b0e6d21"] } }] }),
    );
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const profileBefore = await profileFilesHash(bridge.workspace);
    const started = await prepare(bridge, jobId);
    const taskId = started.body.application.taskId;

    expect(model.outputs.map((output) => output.status)).toEqual(["accepted"]);
    const view = await detail(bridge, taskId);
    expect(view.state).toEqual({ status: "failed", message: "The model tried to do something other than prepare documents, so nothing was saved." });
    expect(view.stage).toBe("saved");
    expect(view.versions).toEqual([]);
    expect((await applicationRecord(bridge, taskId)).documents).toEqual([]);
    await expect(readdir(bridge.workspace.resolve("applications", taskId, "docs"))).rejects.toThrow();
    expect(await profileFilesHash(bridge.workspace)).toBe(profileBefore);
    expect(bridge.logs.some((line) => line.includes("outside preparation"))).toBe(true);
  });
});

describe("a turn that doesn't finish", () => {
  it("a failed turn writes no document, says so plainly, and leaves the stage alone", async () => {
    const { bridge } = await setup(honest(PLATFORM_LEAD_COVERAGE, { end: "failed" }));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const started = await prepare(bridge, jobId);
    const taskId = started.body.application.taskId;
    const view = await detail(bridge, taskId);
    expect(view.stage).toBe("saved");
    expect(view.state).toEqual({ status: "failed", message: "The model's turn failed, so nothing was saved. Try again; the Runs page has the details." });
    expect(view.versions).toEqual([]);
    const runs = await listRuns(bridge.workspace, bridge.clock);
    expect(runs.records[0]).toMatchObject({ outcome: "failure", error: "MODEL_CALL_FAILED: The model declined to answer." });
    expect((await applicationRecord(bridge, taskId)).processing).toMatchObject({ status: "failed", runId: runs.records[0]!.runId });
  });

  it("a turn that ends without a boundary saves nothing either", async () => {
    const planner: Planner = (prompt) => ({ ...honest(PLATFORM_LEAD_COVERAGE)(prompt, 1), noBoundary: true });
    const { bridge } = await setup(planner);
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const started = await prepare(bridge, jobId);
    const view = await detail(bridge, started.body.application.taskId);
    expect(view.state.status).toBe("failed");
    expect(view.versions).toEqual([]);
  });

  it("a provider limit pauses the budget and says so; nothing is prepared until it's resumed", async () => {
    const { bridge, model } = await setup(honest(PLATFORM_LEAD_COVERAGE, { end: "provider_limit" }));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const started = await prepare(bridge, jobId);
    const view = await detail(bridge, started.body.application.taskId);
    expect(view.state).toEqual({
      status: "failed",
      message: "The model provider's rate limit stopped this, and the run budget is now paused. Resume it in Settings, then prepare again.",
    });
    expect(view.stage).toBe("saved");
    expect((await getBudgetState(bridge.workspace, bridge.clock)).paused).toBe(true);
    const again = await post<ErrorBody>(bridge, "/prepare", { jobId, coverLetter: false });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("budget_paused");
    expect(model.prompts).toHaveLength(1);
  });

  it("marks a preparation a stopped runner left running as interrupted, at start", async () => {
    const { bridge } = await setup(honest(PLATFORM_LEAD_COVERAGE));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const store = new ApplicationsStore(bridge.workspace, bridge.clock);
    const { application } = await store.ensureForJob(jobId);
    const now = bridge.clock.now().toISOString();
    await store.writePreparation(application.taskId, {
      attemptId: randomUUID(),
      status: "running",
      owner: "another-runner-process",
      idempotencyKey: `${jobId}@1+profile@v1+resume+inputs@000000000000`,
      jobId,
      jobRevision: 1,
      profileVersion: 1,
      coverLetter: false,
      claims: [],
      requirementsDigest: "0".repeat(64),
      requirementCount: 3,
      answers: [],
      questions: [],
      problems: [],
      startedAt: now,
      updatedAt: now,
    });
    await store.update(application.taskId, (current) => ({ ...current, processing: { status: "running" } }));
    expect((await detail(bridge, application.taskId)).state).toEqual({ status: "interrupted", message: INTERRUPTED_MESSAGE });

    await applicationsModule.start!(bridge.ctx);
    const attempt = await store.readPreparation(application.taskId);
    expect(attempt).toMatchObject({ status: "failed", error: INTERRUPTED_MESSAGE });
    expect((await applicationRecord(bridge, application.taskId)).processing).toEqual({ status: "failed", error: INTERRUPTED_MESSAGE });
    expect((await detail(bridge, application.taskId)).state).toEqual({ status: "failed", message: INTERRUPTED_MESSAGE });

    const started = await prepare(bridge, jobId);
    expect(started.body.outcome).toBe("started");
    expect((await detail(bridge, application.taskId)).stage).toBe("ready");
  });

  it("a runner that stopped after attaching the documents, before closing the attempt, finds that attempt done at start", async () => {
    const { bridge } = await setup(honest(PLATFORM_LEAD_COVERAGE));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const taskId = (await prepare(bridge, jobId)).body.application.taskId;
    const store = new ApplicationsStore(bridge.workspace, bridge.clock);
    const finished = await store.readPreparation(taskId);
    if (!finished || finished === "unreadable") throw new Error("no attempt");
    // The state between finish's two writes, as a stopped runner would leave it.
    const { version: _version, ...rest } = finished;
    void _version;
    await store.writePreparation(taskId, { ...rest, status: "running", owner: "another-runner-process" });
    expect((await detail(bridge, taskId)).state.status).toBe("interrupted");

    await applicationsModule.start!(bridge.ctx);
    expect(await store.readPreparation(taskId)).toMatchObject({ status: "done", version: 1 });
    const view = await detail(bridge, taskId);
    expect(view.state).toEqual({ status: "idle", message: "" });
    expect(view.versions.map((version) => version.version)).toEqual([1]);
    expect((await prepare(bridge, jobId)).body).toMatchObject({ outcome: "already_prepared", version: 1 });
  });

  it("a runner that stopped after writing a version's files and record, before the application listed them, adopts that version at start (revision 1, nit c)", async () => {
    const { bridge, model } = await setup(honest(PLATFORM_LEAD_COVERAGE));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const taskId = (await prepare(bridge, jobId)).body.application.taskId;
    const store = new ApplicationsStore(bridge.workspace, bridge.clock);
    const finished = await store.readPreparation(taskId);
    if (!finished || finished === "unreadable") throw new Error("no attempt");
    // The state just before finish's first write: every file and the version record written, nothing listed yet.
    const { version: _version, ...rest } = finished;
    void _version;
    await store.update(taskId, (current) => ({ ...current, documents: [], stage: "saved", processing: { status: "running" } }));
    await store.writePreparation(taskId, { ...rest, status: "running", owner: "another-runner-process" });

    await applicationsModule.start!(bridge.ctx);
    const application = await applicationRecord(bridge, taskId);
    expect(application.documents.map((document) => [document.version, document.kind, document.format])).toEqual([
      [1, "resume", "md"],
      [1, "resume", "docx"],
      [1, "resume", "pdf"],
      [1, "diff", "md"],
    ]);
    expect(application.stage).toBe("ready");
    expect(application.processing.status).toBe("idle");
    expect(await store.readPreparation(taskId)).toMatchObject({ status: "done", version: 1 });
    expect((await detail(bridge, taskId)).state).toEqual({ status: "idle", message: "" });
    // No version number is skipped, and nothing is prepared twice.
    expect((await prepare(bridge, jobId)).body).toMatchObject({ outcome: "already_prepared", version: 1 });
    expect(model.prompts).toHaveLength(1);
  });

  it("a version missing any of its files is never adopted: that preparation was interrupted", async () => {
    const { bridge } = await setup(honest(PLATFORM_LEAD_COVERAGE));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const taskId = (await prepare(bridge, jobId)).body.application.taskId;
    const store = new ApplicationsStore(bridge.workspace, bridge.clock);
    const finished = await store.readPreparation(taskId);
    if (!finished || finished === "unreadable") throw new Error("no attempt");
    const { version: _version, ...rest } = finished;
    void _version;
    await store.update(taskId, (current) => ({ ...current, documents: [], stage: "saved", processing: { status: "running" } }));
    await store.writePreparation(taskId, { ...rest, status: "running", owner: "another-runner-process" });
    await unlink(bridge.workspace.resolve("applications", taskId, "docs", "resume-v1.pdf"));

    await applicationsModule.start!(bridge.ctx);
    const application = await applicationRecord(bridge, taskId);
    expect(application.documents).toEqual([]);
    expect(application.stage).toBe("saved");
    expect(application.processing).toEqual({ status: "failed", error: INTERRUPTED_MESSAGE });
    expect(await store.readPreparation(taskId)).toMatchObject({ status: "failed", error: INTERRUPTED_MESSAGE });
  });
});

describe("the state while a preparation finishes", () => {
  /**
   * The views a page polls, read just before each of the finishing writes (the application record and the
   * attempt): the preparation must still read as running there, never as finished or interrupted, however the
   * two files stand. (CI caught the page reading "interrupted" between them, and announcing it.)
   */
  async function statesAroundFinish(planner: Planner, job: ReturnType<typeof platformLeadJob>) {
    const { bridge, model } = await setup(planner);
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, job);
    const workspace = bridge.workspace as unknown as { writeJson(segments: readonly string[], value: unknown): Promise<void> };
    const writeJson = workspace.writeJson.bind(bridge.workspace);
    const seen: Array<{ file: string; detail: string; list: string | undefined }> = [];
    let finishing = false;
    workspace.writeJson = async (segments, value) => {
      const file = segments.join("/");
      if (finishing && /^applications\/[0-9a-f-]{36}(\.json|\/preparation\.json)$/.test(file)) {
        const taskId = /([0-9a-f-]{36})/.exec(file)![1]!;
        const list = (await get<ListView>(bridge, "")).body;
        seen.push({ file: file.endsWith("preparation.json") ? "attempt" : "application", detail: (await get<DetailView>(bridge, `/${taskId}`)).body.state.status, list: list.applications.find((entry) => entry.taskId === taskId)?.state.status });
      }
      return writeJson(segments, value);
    };
    model.beforeTurn = async () => {
      finishing = true; // every write to the application from here on is the turn's result
    };
    const started = await prepare(bridge, jobId);
    return { bridge, taskId: started.body.application.taskId, seen };
  }

  it("a done, a parked and a refused preparation each read as running until both writes are made, then as their outcome", async () => {
    const done = await statesAroundFinish(honest(PLATFORM_LEAD_COVERAGE), platformLeadJob());
    const parked = await statesAroundFinish(honest(FERNWOOD_COVERAGE), fixtureJob(FERNWOOD_JOB));
    const refused = await statesAroundFinish(honest(PLATFORM_LEAD_COVERAGE, { firstDraft: DRAFT_WITH_EXCLUDED_METRIC, noRevision: true }), platformLeadJob());
    for (const [run, outcome] of [
      [done, "idle"],
      [parked, "parked"],
      [refused, "failed"],
    ] as const) {
      expect(run.seen.map((entry) => entry.file)).toEqual(["application", "attempt"]);
      for (const entry of run.seen) expect(entry, `${outcome}: ${entry.file}`).toMatchObject({ detail: "running", list: "running" });
      expect((await detail(run.bridge, run.taskId)).state.status).toBe(outcome);
    }
  });
});

describe("refusals before anything runs", () => {
  it("preparation is locked until the career profile is ready, and says the workflow will not guess", async () => {
    const { bridge, model } = await setup(honest(PLATFORM_LEAD_COVERAGE), { profile: { approve: false } });
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const refused = await post<ErrorBody>(bridge, "/prepare", { jobId, coverLetter: false });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toEqual({ code: "not_ready", message: "Preparation is locked: the career profile has not been approved yet. The workflow will not guess." });
    expect(model.prompts).toEqual([]);
    const list = (await get<ListView>(bridge, "")).body;
    expect(list.readiness).toEqual({ ready: false, code: "not_ready", message: "Preparation is locked: the career profile has not been approved yet. The workflow will not guess.", profileVersion: null });
    expect(list.applications).toEqual([]);
  });

  it("a job whose details haven't been extracted can't be prepared yet", async () => {
    const { bridge, model } = await setup(honest(PLATFORM_LEAD_COVERAGE));
    const captured = await new JobsStore(bridge.workspace).captureJob({ url: "https://jobs.example/postings/unextracted", text: "Harbor is hiring. Fictional posting for tests.", extractorVersion: "extractor@0.1.0", capturedAt: bridge.clock.now().toISOString() });
    const refused = await post<ErrorBody>(bridge, "/prepare", { jobId: captured.jobId, coverLetter: false });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("not_extracted");
    expect((await post<ErrorBody>(bridge, "/prepare", { jobId: randomUUID(), coverLetter: false })).status).toBe(404);
    expect((await post<ErrorBody>(bridge, "/prepare", { jobId: "../../career-profile", coverLetter: false })).status).toBe(404);
    expect(model.prompts).toEqual([]);
  });

  it("asks for the name the documents carry before preparing anything", async () => {
    const { bridge, model } = await setup(honest(PLATFORM_LEAD_COVERAGE), { details: false });
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const refused = await post<ErrorBody>(bridge, "/prepare", { jobId, coverLetter: false });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toEqual({ code: "details_missing", message: "Add your name for the documents' header first." });
    expect((await post<ErrorBody>(bridge, "/details", { name: "   ", contact: "" })).body.error.code).toBe("name_missing");
    const saved = await post<{ ok: boolean; details: { name: string; contact: string; pdfMissing: string[] }; outdated: number }>(bridge, "/details", { name: " Ada Quill ", contact: "ada.quill@example.com" });
    expect(saved.status).toBe(200);
    expect(saved.body.details).toEqual({ name: "Ada Quill", contact: "ada.quill@example.com", pdfMissing: [] });
    expect(saved.body.outdated).toBe(0);
    expect((await get<ListView>(bridge, "")).body.details).toEqual({ name: "Ada Quill", contact: "ada.quill@example.com", pdfMissing: [] });
    expect(model.prompts).toEqual([]);
  });

  it("says plainly when the runner's agent isn't running", async () => {
    const { bridge } = await setup(honest(PLATFORM_LEAD_COVERAGE), { eve: false });
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const refused = await post<ErrorBody>(bridge, "/prepare", { jobId, coverLetter: false });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("runner_not_running");
    expect(refused.body.error.message).toContain("`npm run runner`");
    expect((await get<ListView>(bridge, "")).body.runner).toMatchObject({ ready: false, code: "runner_not_running" });
  });

  it("refuses a malformed request body", async () => {
    const { bridge } = await setup(honest(PLATFORM_LEAD_COVERAGE));
    expect((await post<ErrorBody>(bridge, "/prepare", { jobId: randomUUID() })).status).toBe(400);
    expect((await post<ErrorBody>(bridge, "/prepare", { jobId: randomUUID(), coverLetter: false, extra: 1 })).status).toBe(400);
    expect((await post<ErrorBody>(bridge, `/${randomUUID()}/answers`, { requirement: 1, answer: "guess" })).status).toBe(400);
  });
});

/** Every application record in the workspace, by file name. */
async function applicationFiles(bridge: TestBridge): Promise<string[]> {
  return (await readdir(bridge.workspace.resolve("applications"))).filter((name) => name.endsWith(".json") && name !== "details.json").sort();
}

describe("a damaged application record (revision 1, V7)", () => {
  it("while the job's record can't be read, Prepare refuses and names the file, and never starts a second application", async () => {
    const { bridge, model } = await setup(honest(PLATFORM_LEAD_COVERAGE));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const taskId = (await prepare(bridge, jobId)).body.application.taskId;
    const file = bridge.workspace.resolve("applications", `${taskId}.json`);
    const good = await readFile(file, "utf8");

    // A hand edit that broke the record but kept its job id.
    await writeFile(file, JSON.stringify({ ...JSON.parse(good), stage: "shipped" }));
    let refused = await post<ErrorBody>(bridge, "/prepare", { jobId, coverLetter: false });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toEqual({
      code: "application_unreadable",
      message: `The application record applications/${taskId}.json can't be read, and it may be this job's, so preparing now could start a second one. Fix or restore that file, then prepare again.`,
    });
    expect(model.prompts).toHaveLength(1);
    expect(await applicationFiles(bridge)).toEqual([`${taskId}.json`]);

    // A record so damaged it names no job may be any job's: it refuses the same way.
    await writeFile(file, "{ not json");
    refused = await post<ErrorBody>(bridge, "/prepare", { jobId, coverLetter: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("application_unreadable");
    expect(refused.body.error.message).toContain(`applications/${taskId}.json`);
    expect(model.prompts).toHaveLength(1);
    expect(await applicationFiles(bridge)).toEqual([`${taskId}.json`]);
    // The store refuses too, whoever asks.
    await expect(new ApplicationsStore(bridge.workspace, bridge.clock).ensureForJob(jobId)).rejects.toThrow(`applications/${taskId}.json can't be read`);

    // Restored, the job is prepared as before.
    await writeFile(file, good);
    expect((await prepare(bridge, jobId)).body).toMatchObject({ outcome: "already_prepared", version: 1 });
  });

  it("a damaged record that names another job doesn't block this one", async () => {
    const { bridge, model } = await setup(honest(PLATFORM_LEAD_COVERAGE));
    const first = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const firstTask = (await prepare(bridge, first.jobId)).body.application.taskId;
    const file = bridge.workspace.resolve("applications", `${firstTask}.json`);
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), stage: "shipped" }));

    const second = await seedJob(bridge.workspace, bridge.clock, { ...platformLeadJob(), url: "https://jobs.example/postings/fernwood-platform-lead-2" });
    const started = await prepare(bridge, second.jobId);
    expect(started.body.outcome).toBe("started");
    expect(model.prompts).toHaveLength(2);
    expect(await applicationFiles(bridge)).toHaveLength(2);
    // The list still names the damaged file.
    expect((await get<ListView & { unreadable: Array<{ path: string }> }>(bridge, "")).body.unreadable).toEqual([{ path: `applications/${firstTask}.json` }]);
  });
});

describe("a changed name or contact line (revision 1, V8)", () => {
  it("re-exports the latest validated draft with the new header as a new version naming the old one, with no model turn; the same header is already prepared", async () => {
    const { bridge, model } = await setup(honest(PLATFORM_LEAD_COVERAGE));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const taskId = (await prepare(bridge, jobId, true)).body.application.taskId;
    const v1Documents = (await applicationRecord(bridge, taskId)).documents;
    const v1Key = v1Documents[0]!.idempotencyKey;
    expect(model.prompts).toHaveLength(1);
    const v1Resume = await documentText(bridge, taskId, "resume-v1.md");

    // The person corrects their name and contact line. The page is told the documents don't carry it yet.
    const corrected = { name: "Ada Q. Quill", contact: "ada.q.quill@example.com · Remote" };
    const saved = await post<{ ok: boolean; outdated: number }>(bridge, "/details", corrected);
    expect(saved.body.outdated).toBe(1);
    const latestBefore = (await detail(bridge, taskId)).versions[0]!;
    expect(latestBefore.olderDetails).toBe(true);

    // Even with the budget paused: a re-export runs no model and uses no run.
    await pauseBudget(bridge.workspace, bridge.clock, "paused for this test");
    bridge.clock.advance(60_000);
    const again = await prepare(bridge, jobId, true);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ outcome: "reexported", version: 2, replaces: 1 });
    expect(model.prompts).toHaveLength(1);
    expect((await listRuns(bridge.workspace, bridge.clock)).records).toHaveLength(1);

    const application = await applicationRecord(bridge, taskId);
    const v2Documents = application.documents.filter((document) => document.version === 2);
    expect(v2Documents.map((document) => [document.kind, document.format])).toEqual([
      ["resume", "md"],
      ["resume", "docx"],
      ["resume", "pdf"],
      ["cover_letter", "md"],
      ["cover_letter", "docx"],
      ["cover_letter", "pdf"],
      ["diff", "md"],
    ]);
    const v2Key = v2Documents[0]!.idempotencyKey;
    expect(v2Key).not.toBe(v1Key);
    expect(v2Key.replace(/\+details@[0-9a-f]+$/, "")).toBe(v1Key.replace(/\+details@[0-9a-f]+$/, ""));
    expect(application.documents.filter((document) => document.version === 1)).toEqual(v1Documents);
    // Every version-2 document carries the new header and the same sentences; version 1's files are untouched.
    for (const document of v2Documents.filter((entry) => entry.kind !== "diff")) {
      const text = flat(await documentText(bridge, taskId, document.path.split("/").at(-1)!));
      expect(text, document.path).toContain("Ada Q. Quill");
      expect(text, document.path).toContain(KNOWN_SENTENCE[document.kind]);
      if (document.kind === "resume") expect(text, document.path).toContain("ada.q.quill@example.com");
      expect(text, document.path).not.toContain("ada.quill@example.com");
    }
    expect(await documentText(bridge, taskId, "resume-v1.md")).toBe(v1Resume);
    const v1Record = JSON.parse(await rawFile(bridge, "applications", taskId, "versions", "v1.json"));
    const v2Record = JSON.parse(await rawFile(bridge, "applications", taskId, "versions", "v2.json"));
    expect(v2Record).toMatchObject({ version: 2, replaces: 1, sameDraftAs: 1, header: corrected, profileVersion: 1, jobRevision: 1, coverLetter: true });
    expect(v2Record.draft).toEqual(v1Record.draft);
    expect(await documentText(bridge, taskId, "diff-v2.md")).toContain("- Only the name and contact line at the top changed. Every sentence is the same as in version 1, and no model ran.");

    const view = await detail(bridge, taskId);
    expect(view.versions.map((version) => [version.version, version.replaces, version.replacedBy, version.sameDraftAs, version.olderDetails])).toEqual([
      [2, 1, null, 1, false],
      [1, null, 2, null, true],
    ]);
    expect(view.versions[0]!.files[0]!.download).toBe("Ada Q. Quill - Resume - Fernwood Platform Lead.md");
    expect(view.versions[1]!.files[0]!.download).toBe("Ada Quill - Resume - Fernwood Platform Lead.md");

    // The same header again: already prepared, nothing new written.
    const same = await prepare(bridge, jobId, true);
    expect(same.body).toMatchObject({ outcome: "already_prepared", version: 2 });
    expect((await applicationRecord(bridge, taskId)).documents).toHaveLength(14);
    expect((await post<{ outdated: number }>(bridge, "/details", corrected)).body.outdated).toBe(0);
  });

  it("answers carried by a parked preparation survive a changed header", async () => {
    const { bridge, model } = await setup(honest(FERNWOOD_COVERAGE));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, fixtureJob(FERNWOOD_JOB));
    const taskId = (await prepare(bridge, jobId)).body.application.taskId;
    await post(bridge, `/${taskId}/answers`, { requirement: 1, answer: "leave_out" });
    await post(bridge, "/details", { name: "Ada Q. Quill", contact: "" });
    // One question is still open whatever the header: preparing is refused, not restarted from scratch.
    expect((await post<ErrorBody>(bridge, "/prepare", { jobId, coverLetter: false })).body.error.code).toBe("needs_answers");
    await post(bridge, `/${taskId}/answers`, { requirement: 3, answer: "leave_out" });
    const next = await prepare(bridge, jobId);
    expect(next.body.outcome).toBe("started");
    expect(model.prompts[1]).toContain("- Requirement 1: leave it out.");
    expect(model.prompts[1]).toContain("- Requirement 3: leave it out.");
    expect(flat(await documentText(bridge, taskId, "resume-v1.pdf"))).toContain("Ada Q. Quill");
  });
});

describe("characters the PDF can't draw (revision 1, V16)", () => {
  it("are named for the page at the name field and beside each PDF, and the download names keep them", async () => {
    const { bridge } = await setup(honest(PLATFORM_LEAD_COVERAGE), { details: false });
    const saved = await post<{ details: { pdfMissing: string[] } }>(bridge, "/details", { name: "Ада Квилл 李", contact: "ada.quill@example.com" });
    expect(saved.body.details.pdfMissing).toEqual(["李"]);
    expect((await get<ListView>(bridge, "")).body.details?.pdfMissing).toEqual(["李"]);

    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const taskId = (await prepare(bridge, jobId, true)).body.application.taskId;
    const [version] = (await detail(bridge, taskId)).versions;
    const missing = Object.fromEntries(version!.files.map((file) => [file.name, file.missing]));
    expect(missing).toEqual({ "resume-v1.md": [], "resume-v1.docx": [], "resume-v1.pdf": ["李"], "cover-v1.md": [], "cover-v1.docx": [], "cover-v1.pdf": ["李"], "diff-v1.md": [] });
    // The PDF prints the Cyrillic as typed and marks the one character it can't draw; the Markdown keeps it.
    expect(flat(await documentText(bridge, taskId, "resume-v1.pdf"))).toContain("Ада Квилл �");
    expect(await documentText(bridge, taskId, "resume-v1.md")).toContain("# Ада Квилл 李");
    // A name outside ASCII downloads under its own name (RFC 6266's filename*), with a plain fallback.
    const pdf = await download(bridge, taskId, "resume-v1.pdf");
    expect(pdf.headers["content-disposition"]).toBe(
      `attachment; filename="___ _____ _ - Resume - Fernwood Platform Lead.pdf"; filename*=UTF-8''${encodeURIComponent("Ада Квилл 李 - Resume - Fernwood Platform Lead.pdf")}`,
    );
    expect(version!.files.find((file) => file.name === "resume-v1.pdf")?.download).toBe("Ада Квилл 李 - Resume - Fernwood Platform Lead.pdf");
  });
});

describe("the list view and downloads", () => {
  it("lists saved jobs to prepare and the applications", async () => {
    const { bridge } = await setup(honest(PLATFORM_LEAD_COVERAGE));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    let list = (await get<ListView>(bridge, "")).body;
    expect(list.readiness).toEqual({ ready: true, code: null, message: null, profileVersion: 1 });
    expect(list.runner).toEqual({ ready: true, code: null, message: null });
    expect(list.budget).toEqual({ dailyRunLimit: 10, runsUsedToday: 0 });
    expect(list.jobs).toEqual([{ jobId, name: "Platform Lead · Fernwood", revision: 1, extracted: true, taskId: null }]);
    expect(list.applications).toEqual([]);

    const started = await prepare(bridge, jobId);
    list = (await get<ListView>(bridge, "")).body;
    expect(list.jobs[0]!.taskId).toBe(started.body.application.taskId);
    expect(list.applications).toEqual([{ taskId: started.body.application.taskId, jobId, jobName: "Platform Lead · Fernwood", stage: "ready", latestVersion: 1, state: { status: "idle", message: "" } }]);
    expect(list.budget).toEqual({ dailyRunLimit: 10, runsUsedToday: 1 });
  });

  it("lists applications by their most recent activity, newest first (revision 1, V18)", async () => {
    const { bridge } = await setup(honest(PLATFORM_LEAD_COVERAGE));
    const lead = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const second = await seedJob(bridge.workspace, bridge.clock, { ...platformLeadJob(), url: "https://jobs.example/postings/fernwood-platform-lead-2", structured: { ...platformLeadJob().structured, title: "Staff Platform Lead" } });
    const first = (await prepare(bridge, lead.jobId)).body.application.taskId;
    bridge.clock.advance(60_000);
    const later = (await prepare(bridge, second.jobId)).body.application.taskId;
    let order = (await get<ListView>(bridge, "")).body.applications.map((entry) => entry.taskId);
    expect(order).toEqual([later, first]);
    // Preparing the first one again (a new version) makes it the most recent.
    await new ProfileStore(bridge.workspace, bridge.clock).decideClaim((await new ProfileStore(bridge.workspace, bridge.clock).read()).claims[5]!.id, "excluded");
    bridge.clock.advance(60_000);
    await prepare(bridge, lead.jobId);
    order = (await get<ListView>(bridge, "")).body.applications.map((entry) => entry.taskId);
    expect(order).toEqual([first, later]);
  });

  it("serves only the documents an application lists, as attachments that can't run in the page", async () => {
    const { bridge } = await setup(honest(PLATFORM_LEAD_COVERAGE));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const taskId = (await prepare(bridge, jobId)).body.application.taskId;

    const pdf = await download(bridge, taskId, "resume-v1.pdf");
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(pdf.body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const docx = await download(bridge, taskId, "resume-v1.docx");
    expect(docx.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(docx.body.subarray(0, 2).toString("latin1")).toBe("PK");

    expect((await download(bridge, taskId, "resume-v2.md")).status).toBe(404);
    expect((await download(bridge, taskId, "notes.txt")).status).toBe(404);
    expect((await download(bridge, taskId, "..%2F..%2Fcareer-profile.json")).status).toBe(404);
    expect((await download(bridge, randomUUID(), "resume-v1.md")).status).toBe(404);
    expect((await get<ErrorBody>(bridge, `/${randomUUID()}`)).status).toBe(404);
    expect((await get<ErrorBody>(bridge, "/not-a-task")).status).toBe(404);
  });
});
