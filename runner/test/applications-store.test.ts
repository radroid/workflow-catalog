import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../lib/clock.ts";
import { ApplicationsStore, ApplicationsStoreError, documentPath, isDocumentFileName, type PreparationRecord, type VersionRecord } from "../store/applications.ts";
import { newWorkspace } from "./helpers.ts";
import { GOOD_RESUME, PERSON } from "./preparation-helpers.ts";

/**
 * The applications store (P05): one application per job, every write
 * through `update` (revision bumped, record validated, one at a time), the
 * latest preparation attempt, the prepared versions, the document files and
 * the documents' header. Damaged files read as damaged, never as a throw.
 */

async function store() {
  const clock = new ManualClock();
  const workspace = await newWorkspace(clock);
  return { clock, workspace, applications: new ApplicationsStore(workspace, clock) };
}

function attempt(jobId: string, overrides: Partial<PreparationRecord> = {}): PreparationRecord {
  return {
    attemptId: randomUUID(),
    status: "running",
    idempotencyKey: `${jobId}@1+profile@v1+resume+inputs@000000000000`,
    jobId,
    jobRevision: 1,
    profileVersion: 1,
    coverLetter: false,
    claims: [{ label: "C1", id: randomUUID(), kind: "fact", status: "confirmed", text: "Led the payments infrastructure team at Northwind Labs." }],
    requirementsDigest: "0".repeat(64),
    requirementCount: 3,
    answers: [],
    questions: [],
    problems: [],
    startedAt: "2026-09-22T09:00:00.000Z",
    updatedAt: "2026-09-22T09:00:00.000Z",
    ...overrides,
  };
}

function version(number: number): VersionRecord {
  return {
    version: number,
    ...(number > 1 ? { replaces: number - 1 } : {}),
    createdAt: "2026-09-22T09:00:00.000Z",
    idempotencyKey: `key-${number}`,
    profileVersion: 1,
    jobRevision: 1,
    coverLetter: false,
    draft: { resume: GOOD_RESUME },
    sources: [],
    statements: [],
    changes: [],
  };
}

describe("ApplicationsStore: one application per job", () => {
  it("creates an application at stage saved the first time, and finds the same one after", async () => {
    const { applications } = await store();
    const jobId = randomUUID();
    const first = await applications.ensureForJob(jobId);
    expect(first.created).toBe(true);
    expect(first.application).toMatchObject({ jobId, stage: "saved", revision: 1, documents: [], notes: "", deadlines: [], processing: { status: "idle" } });
    const second = await applications.ensureForJob(jobId);
    expect(second).toEqual({ application: first.application, created: false });
    expect(await applications.findByJob(jobId)).toEqual(first.application);
  });

  it("creates exactly one when asked for the same job at once", async () => {
    const { applications } = await store();
    const jobId = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => applications.ensureForJob(jobId)));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.application.taskId)).size).toBe(1);
    expect((await applications.list()).applications).toHaveLength(1);
  });

  it("refuses a job id that isn't one", async () => {
    const { applications } = await store();
    await expect(applications.ensureForJob("../career-profile")).rejects.toThrow(ApplicationsStoreError);
  });
});

describe("ApplicationsStore.update", () => {
  it("bumps the revision on every write, and never changes the task or the job", async () => {
    const { applications } = await store();
    const { application } = await applications.ensureForJob(randomUUID());
    const updated = await applications.update(application.taskId, (current) => ({ ...current, stage: "ready", taskId: randomUUID(), jobId: randomUUID() }));
    expect(updated).toMatchObject({ taskId: application.taskId, jobId: application.jobId, stage: "ready", revision: 2 });
    expect(await applications.get(application.taskId)).toEqual(updated);
  });

  it("writes nothing when the change returns nothing", async () => {
    const { applications } = await store();
    const { application } = await applications.ensureForJob(randomUUID());
    expect(await applications.update(application.taskId, () => undefined)).toEqual(application);
    expect((await applications.get(application.taskId))?.revision).toBe(1);
  });

  it("refuses a change that would leave an invalid record, and writes nothing", async () => {
    const { applications } = await store();
    const { application } = await applications.ensureForJob(randomUUID());
    await expect(applications.update(application.taskId, (current) => ({ ...current, stage: "hired" as never }))).rejects.toThrow("That change would not leave a valid application record, so nothing was written.");
    expect(await applications.get(application.taskId)).toEqual(application);
  });

  it("keeps every one of several concurrent updates", async () => {
    const { applications } = await store();
    const { application } = await applications.ensureForJob(randomUUID());
    await Promise.all(Array.from({ length: 6 }, (_, index) => applications.update(application.taskId, (current) => ({ ...current, notes: `${current.notes}${index}` }))));
    const final = await applications.get(application.taskId);
    expect(final?.revision).toBe(7);
    expect([...(final?.notes ?? "")].sort().join("")).toBe("012345");
  });

  it("refuses an application that doesn't exist, or can't be read", async () => {
    const { applications, workspace } = await store();
    await expect(applications.update(randomUUID(), (current) => current)).rejects.toThrow("No such application.");
    const taskId = randomUUID();
    await mkdir(workspace.resolve("applications"), { recursive: true });
    await writeFile(workspace.resolve("applications", `${taskId}.json`), "{ not json");
    await expect(applications.update(taskId, (current) => current)).rejects.toThrow(`applications/${taskId}.json can't be read.`);
  });
});

describe("ApplicationsStore: damaged files", () => {
  it("lists a damaged application apart, by its path, and reads it as damaged", async () => {
    const { applications, workspace } = await store();
    const { application } = await applications.ensureForJob(randomUUID());
    const damaged = randomUUID();
    await writeFile(workspace.resolve("applications", `${damaged}.json`), JSON.stringify({ taskId: damaged, stage: "nowhere" }));
    await writeFile(workspace.resolve("applications", "notes.json"), "{}");
    expect(await applications.read(damaged)).toEqual({ kind: "unreadable" });
    expect(await applications.read(randomUUID())).toEqual({ kind: "missing" });
    expect(await applications.read("../../career-profile")).toEqual({ kind: "missing" });
    const list = await applications.list();
    expect(list.applications.map((entry) => entry.taskId)).toEqual([application.taskId]);
    expect(list.unreadable).toEqual([{ taskId: damaged, path: `applications/${damaged}.json` }]);
  });

  it("reads a record whose file names another task as damaged", async () => {
    const { applications, workspace } = await store();
    const { application } = await applications.ensureForJob(randomUUID());
    const other = randomUUID();
    await writeFile(workspace.resolve("applications", `${other}.json`), JSON.stringify(application));
    expect(await applications.read(other)).toEqual({ kind: "unreadable" });
  });
});

describe("ApplicationsStore: the preparation attempt", () => {
  it("round-trips an attempt, stamping when it was written", async () => {
    const { applications, clock } = await store();
    const { application } = await applications.ensureForJob(randomUUID());
    expect(await applications.readPreparation(application.taskId)).toBeUndefined();
    clock.advance(60_000);
    const record = attempt(application.jobId);
    await applications.writePreparation(application.taskId, record);
    expect(await applications.readPreparation(application.taskId)).toEqual({ ...record, updatedAt: "2026-09-22T09:01:00.000Z" });
  });

  it("reads a damaged attempt as unreadable, and refuses to write an invalid one", async () => {
    const { applications, workspace } = await store();
    const { application } = await applications.ensureForJob(randomUUID());
    await mkdir(workspace.resolve("applications", application.taskId), { recursive: true });
    await writeFile(workspace.resolve("applications", application.taskId, "preparation.json"), "[]");
    expect(await applications.readPreparation(application.taskId)).toBe("unreadable");
    await expect(applications.writePreparation(application.taskId, attempt(application.jobId, { status: "guessing" as never }))).rejects.toThrow();
    await expect(applications.writePreparation("not-a-task", attempt(application.jobId))).rejects.toThrow(ApplicationsStoreError);
  });
});

describe("ApplicationsStore: prepared versions", () => {
  it("lists versions in number order, skipping a damaged one", async () => {
    const { applications, workspace } = await store();
    const { application } = await applications.ensureForJob(randomUUID());
    for (const number of [10, 2, 1]) await applications.writeVersion(application.taskId, version(number));
    await writeFile(workspace.resolve("applications", application.taskId, "versions", "v3.json"), "{}");
    expect((await applications.listVersions(application.taskId)).map((record) => record.version)).toEqual([1, 2, 10]);
    expect(await applications.readVersion(application.taskId, 3)).toBeUndefined();
    expect(await applications.readVersion(application.taskId, 2)).toEqual(version(2));
    expect(await applications.listVersions("not-a-task")).toEqual([]);
  });
});

describe("ApplicationsStore: document files", () => {
  it("writes and reads a document by its file name, and records its workspace path", async () => {
    const { applications } = await store();
    const { application } = await applications.ensureForJob(randomUUID());
    const written = await applications.writeDocumentFile(application.taskId, "resume-v1.pdf", new Uint8Array([37, 80, 68, 70]));
    expect(written).toBe(`applications/${application.taskId}/docs/resume-v1.pdf`);
    expect(written).toBe(documentPath(application.taskId, "resume-v1.pdf"));
    expect([...((await applications.readDocumentFile(application.taskId, "resume-v1.pdf")) ?? [])]).toEqual([37, 80, 68, 70]);
    expect(await applications.readDocumentFile(application.taskId, "resume-v2.pdf")).toBeUndefined();
  });

  it("refuses any other file name", async () => {
    const { applications } = await store();
    const { application } = await applications.ensureForJob(randomUUID());
    for (const name of ["../career-profile.json", "resume-v0.md", "resume-v1.exe", "notes.md", "resume-v1.md/x", "cover-v01.md"]) {
      expect(isDocumentFileName(name), name).toBe(false);
      await expect(applications.writeDocumentFile(application.taskId, name, "x")).rejects.toThrow(ApplicationsStoreError);
      expect(await applications.readDocumentFile(application.taskId, name)).toBeUndefined();
    }
    for (const name of ["resume-v1.md", "cover-v12.docx", "diff-v3.md", "resume-v2.pdf"]) expect(isDocumentFileName(name), name).toBe(true);
  });
});

describe("ApplicationsStore: the documents' header", () => {
  it("keeps the name and contact line the person typed, trimmed", async () => {
    const { applications, workspace } = await store();
    expect(await applications.readDetails()).toBeUndefined();
    expect(await applications.writeDetails({ name: `  ${PERSON.name} `, contact: ` ${PERSON.contact}` })).toEqual(PERSON);
    expect(await applications.readDetails()).toEqual(PERSON);
    await expect(applications.writeDetails({ name: " ", contact: "" })).rejects.toThrow();
    await writeFile(workspace.resolve("applications", "details.json"), "{ nope");
    expect(await applications.readDetails()).toBeUndefined();
  });
});
