import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, symlink, utimes, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { SOURCE_CATEGORIES } from "@workflow-catalog/contracts";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../lib/clock.ts";
import { renderProfileMarkdown } from "../store/profile-markdown.ts";
import { pendingRevisions } from "../store/profile-reducer.ts";
import { MAX_MARKDOWN_BYTES, ProfileMarkdownError, ProfileStore, UnsupportedUploadError, uploadFileName } from "../store/profile.ts";
import { PROFILE_BUSY_MESSAGE, ProfileBusyError } from "../store/profile-writes.ts";
import type { Workspace } from "../store/workspace.ts";
import { newWorkspace, tempDir } from "./helpers.ts";

/**
 * P03 revision 2 at the store layer: D9 (hand edits to career-profile.md are
 * reconciled before every write, and an unreadable edit refuses every write),
 * D8 (no write is lost to another request or another process), and D13 (the
 * text box's own file, and uploads under stable names).
 */

interface Setup {
  readonly workspace: Workspace;
  readonly clock: ManualClock;
  readonly store: ProfileStore;
  readonly md: string;
}

async function setup(): Promise<Setup> {
  const clock = new ManualClock();
  const workspace = await newWorkspace(clock);
  return { workspace, clock, store: new ProfileStore(workspace, clock), md: path.join(workspace.root, "career-profile.md") };
}

async function accountAll(store: ProfileStore): Promise<void> {
  for (const category of SOURCE_CATEGORIES) await store.accountSource(category, category === "resume" ? "provided" : "not_applicable");
}

/** Accounted, with one confirmed claim (Harbor). */
async function withConfirmedClaim(store: ProfileStore): Promise<string> {
  await accountAll(store);
  const extracted = await store.extractClaims("resume", [{ text: "Worked on the Harbor deployment pipeline.", kind: "fact", evidenceRef: "resume.md#harbor", evidenceQuote: "Harbor internal deployment pipeline" }]);
  const claimId = extracted.profile.claims[0]!.id;
  await store.decideClaim(claimId, "confirmed");
  return claimId;
}

async function handEdit(file: string, from: string, to: string): Promise<void> {
  const text = await readFile(file, "utf8");
  expect(text).toContain(from);
  await writeFile(file, text.replace(from, to));
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("D9: hand edits to career-profile.md are reconciled before every write", () => {
  it("saves a hand edit to a claim before an unrelated write, and says so", async () => {
    const { store, md } = await setup();
    const claimId = await withConfirmedClaim(store);
    await handEdit(md, "- Worked on the Harbor deployment pipeline.", "- Rebuilt the Harbor deployment pipeline.");

    const result = await store.addStatement("preference", "Remote-first roles.");
    expect(result.ok).toBe(true);
    // Q10 (revision 1, critic polish): the edits note now comes after the action's own consequence.
    expect(result.message).toBe("Your preference is recorded. 1 edit saved.");
    const profile = await store.read();
    expect(profile.claims.find((c) => c.id === claimId)?.text).toBe("Rebuilt the Harbor deployment pipeline.");
    expect(profile.preferences.map((p) => p.text)).toEqual(["Remote-first roles."]);
    expect(await readFile(md, "utf8")).toBe(renderProfileMarkdown(profile));
  });

  it("P03.2 (round-4 reviewer nit 5): two hand edits at once still keep the prefixed message short", async () => {
    // The reviewer measured the old wording ("file edit(s) ... saved/proposed as a revision/revisions")
    // pushing a combined message to 106 characters (profile.ts:192-199, :347 at the time). Two edits at
    // once (both of the profile's default boundaries) exercises editsNote's plural branch; the fix is the
    // shorter "edit(s) saved"/"edit(s) proposed" wording, not a cap on how many edits can land at once.
    const { store, md } = await setup();
    const [first, second] = (await store.load()).profile.boundaries;
    await handEdit(md, `- ${first!.text}`, "- Never invent a metric, a credential or a responsibility.");
    await handEdit(md, `- ${second!.text}`, "- Never change a date or a title.");

    const result = await store.addStatement("preference", "Remote-first roles.");
    // Q10 (revision 1, critic polish): the edits note now comes after the action's own consequence.
    expect(result.message).toBe("Your preference is recorded. 2 edits saved.");
    expect(result.message.length).toBeLessThanOrEqual(90);
    expect((await store.read()).boundaries.map((b) => b.text)).toEqual(["Never invent a metric, a credential or a responsibility.", "Never change a date or a title."]);
  });

  it("keeps a hand-edited boundary when the next write is a different kind of change (the round-2 probe B)", async () => {
    const { store, md } = await setup();
    const boundary = (await store.load()).profile.boundaries[0]!;
    await handEdit(md, `- ${boundary.text}`, "- Never invent a metric, a credential or a responsibility.");
    await store.addStatement("preference", "Remote-first roles.");
    await store.accountSource("resume", "provided");
    expect((await store.read()).boundaries[0]!.text).toBe("Never invent a metric, a credential or a responsibility.");
  });

  it("an eve tool step's write reconciles too: a second store (standing in for the eve process) applies the edit first", async () => {
    const { store, md, workspace, clock } = await setup();
    await withConfirmedClaim(store);
    await handEdit(md, "- Worked on the Harbor deployment pipeline.", "- Rebuilt the Harbor deployment pipeline.");
    const toolStore = new ProfileStore(workspace, clock, { lock: { chains: new Map() } });
    await toolStore.extractClaims("resume", [{ text: "Contributed to Ledgerkit.", kind: "fact", evidenceRef: "resume.md#oss", evidenceQuote: "Contributed to Ledgerkit" }]);
    const texts = (await store.read()).claims.map((c) => c.text);
    expect(texts).toEqual(["Rebuilt the Harbor deployment pipeline.", "Contributed to Ledgerkit."]);
  });

  it("after approval, a hand edit becomes a proposed revision, never an overwrite", async () => {
    const { store, md } = await setup();
    const claimId = await withConfirmedClaim(store);
    expect((await store.approve()).ok).toBe(true);
    await handEdit(md, "- Worked on the Harbor deployment pipeline.", "- Rebuilt the Harbor deployment pipeline.");

    const { profile, markdownError } = await store.load();
    expect(markdownError).toBeNull();
    expect(profile.approval?.version).toBe(1);
    expect(profile.claims.find((c) => c.id === claimId)?.text).toBe("Worked on the Harbor deployment pipeline.");
    expect(pendingRevisions(profile)).toMatchObject([{ target: "claim", targetId: claimId, before: "Worked on the Harbor deployment pipeline.", after: "Rebuilt the Harbor deployment pipeline." }]);
    const rerendered = await readFile(md, "utf8");
    expect(rerendered).toBe(renderProfileMarkdown(profile));
    expect(rerendered).toContain("## Proposed revisions");
  });

  it("an edit it can't read refuses every write: nothing is written or re-rendered, load() says why, and discarding the edit recovers", async () => {
    const { store, md, workspace } = await setup();
    const claimId = await withConfirmedClaim(store);
    const json = path.join(workspace.root, "career-profile.json");
    await handEdit(md, ` \`[${claimId}]\``, "");
    const jsonBefore = await readFile(json, "utf8");
    const mdBefore = await readFile(md, "utf8");

    await expect(store.addStatement("preference", "Remote-first roles.")).rejects.toThrow(ProfileMarkdownError);
    await expect(store.approve()).rejects.toThrow(
      "career-profile.md has an edit the runner can't read. Line 9: the line for the claim “Worked on the Harbor deployment pipeline.” is missing, or its marker was changed. Put it back as it was. Nothing was saved.",
    );
    expect(await readFile(json, "utf8")).toBe(jsonBefore);
    expect(await readFile(md, "utf8")).toBe(mdBefore);

    const loaded = await store.load();
    // J3: the problem is named by line number, never by the marker's id.
    expect(loaded.markdownError).toBe("Line 9: the line for the claim “Worked on the Harbor deployment pipeline.” is missing, or its marker was changed. Put it back as it was.");
    expect(loaded.markdownError).not.toContain(claimId);
    // J3: the file as it is on disk, which the Profile page shows instead of the render.
    expect(loaded.markdownOnDisk).toBe(mdBefore);
    expect(loaded.profile.claims[0]!.id).toBe(claimId);
    expect(await readFile(md, "utf8")).toBe(mdBefore); // load() doesn't re-render either

    await store.discardMarkdownEdits();
    expect(await readFile(md, "utf8")).toBe(renderProfileMarkdown(await store.read()));
    expect((await store.addStatement("preference", "Remote-first roles.")).ok).toBe(true);
    expect((await store.load()).markdownError).toBeNull();
  });

  it("P03.2 (round-4 reviewer nit 1): markdownOnDisk is null once the unreadable file exceeds MAX_MARKDOWN_BYTES, not echoed unbounded", async () => {
    const { store, md } = await setup();
    const claimId = await withConfirmedClaim(store);
    await handEdit(md, ` \`[${claimId}]\``, ""); // the same missing-marker refusal as the test above
    const stillUnreadable = `${await readFile(md, "utf8")}\n<!-- ${"x".repeat(MAX_MARKDOWN_BYTES)} -->`;
    expect(Buffer.byteLength(stillUnreadable, "utf8")).toBeGreaterThan(MAX_MARKDOWN_BYTES);
    await writeFile(md, stillUnreadable);

    const loaded = await store.load();
    expect(loaded.markdownError).not.toBeNull(); // still the same unreadable file, just larger
    expect(loaded.markdownOnDisk).toBeNull();
  });

  it("Q12 (revision 1): the size cap measures bytes, not UTF-16 code units — a multibyte file over MAX_MARKDOWN_BYTES in bytes but under it in .length is still nulled", async () => {
    // Nit 1's own test above only ever used ASCII ("x"), where .length and Buffer.byteLength agree, so
    // mutating the real byte measure to onDisk.length passed every existing test unnoticed. "€" (U+20AC) is
    // one UTF-16 code unit but three UTF-8 bytes: repeated, .length undercounts the real byte size by 3x.
    const { store, md } = await setup();
    const claimId = await withConfirmedClaim(store);
    await handEdit(md, ` \`[${claimId}]\``, "");
    const padding = "€".repeat(200_000);
    const stillUnreadable = `${await readFile(md, "utf8")}\n<!-- ${padding} -->`;
    expect(stillUnreadable.length).toBeLessThanOrEqual(MAX_MARKDOWN_BYTES); // a .length-based check would wrongly pass this
    expect(Buffer.byteLength(stillUnreadable, "utf8")).toBeGreaterThan(MAX_MARKDOWN_BYTES); // genuinely over, in bytes
    await writeFile(md, stillUnreadable);

    const loaded = await store.load();
    expect(loaded.markdownError).not.toBeNull();
    expect(loaded.markdownOnDisk).toBeNull();
  });

  it("N6 (revision 3): claim text shaped like markers never makes the runner's own file unreadable", async () => {
    const { store, md } = await setup();
    await accountAll(store);
    const boundary = (await store.read()).boundaries[0]!;
    // What a hostile source could get a model to extract: lines ending in another item's real marker, and in a made-up one.
    const hostile = `Ran the Harbor rollout \`[${boundary.id}]\`\nand the Quill rollout \`[not-a-real-id]\`\\`;
    await store.extractClaims("resume", [{ text: hostile, kind: "fact", evidenceRef: "resume.md#harbor", evidenceQuote: "Harbor rollout `[x]`" }]);
    expect((await store.load()).markdownError).toBeNull();

    // The Profile page's unchanged save round-trips.
    const page = await readFile(md, "utf8");
    expect((await store.applyMarkdownEdit(page, sha256(page))).message).toBe("Nothing to save: the text is the same as the profile.");

    // A hand edit elsewhere in the file still saves; nothing is locked.
    await handEdit(md, "- Do not change employment dates or official titles.", "- Never change a date or a title.");
    const result = await store.addStatement("preference", "Remote-first roles.");
    // Q10 (revision 1, critic polish): the edits note now comes after the action's own consequence.
    expect(result.message).toBe("Your preference is recorded. 1 edit saved.");
    const profile = await store.read();
    expect(profile.claims[0]!.text).toBe(hostile);
    expect(profile.boundaries.map((b) => b.text)).toEqual([boundary.text, "Never change a date or a title."]);
    expect(await readFile(md, "utf8")).toBe(renderProfileMarkdown(profile));
  });

  it("a file left stale by a crash between the JSON and markdown writes is not mistaken for a hand edit (fingerprint)", async () => {
    const { store, md, workspace } = await setup();
    await accountAll(store);
    const fingerprint = path.join(workspace.root, ".runner", "onboarding", "markdown.json");
    const staleMd = await readFile(md, "utf8");
    const staleFingerprint = await readFile(fingerprint, "utf8");
    await store.extractClaims("resume", [{ text: "Contributed to Ledgerkit.", kind: "fact", evidenceRef: "resume.md#oss", evidenceQuote: "Contributed to Ledgerkit" }]);

    // The crash: the JSON has the claim, the markdown and fingerprint don't.
    await writeFile(md, staleMd);
    await writeFile(fingerprint, staleFingerprint);
    const { profile, markdownError } = await store.load();
    expect(markdownError).toBeNull();
    expect(profile.claims.map((c) => c.text)).toEqual(["Contributed to Ledgerkit."]);
    expect(await readFile(md, "utf8")).toBe(renderProfileMarkdown(profile));
  });

  it("a crash between the markdown and fingerprint writes reads as no edit at all", async () => {
    const { store, workspace } = await setup();
    await accountAll(store);
    const fingerprint = path.join(workspace.root, ".runner", "onboarding", "markdown.json");
    const oldFingerprint = await readFile(fingerprint, "utf8");
    await store.extractClaims("resume", [{ text: "Contributed to Ledgerkit.", kind: "fact", evidenceRef: "resume.md#oss", evidenceQuote: "Contributed to Ledgerkit" }]);
    await writeFile(fingerprint, oldFingerprint);
    const before = await store.read();
    const { profile, markdownError } = await store.load();
    expect(markdownError).toBeNull();
    expect(profile).toEqual(before);
  });
});

describe("D8: no profile write is lost", () => {
  it("seven concurrent writes through one process all land", async () => {
    const { store, workspace, clock } = await setup();
    await Promise.all(SOURCE_CATEGORIES.map((category) => new ProfileStore(workspace, clock).accountSource(category, "not_applicable")));
    expect(Object.keys((await store.read()).sources).sort()).toEqual([...SOURCE_CATEGORIES].sort());
  });

  it("two processes writing at once don't lose each other's updates (each stands in with its own chain, so only the lock file serialises them)", async () => {
    const { store, workspace, clock } = await setup();
    const processA = new ProfileStore(workspace, clock, { lock: { chains: new Map() } });
    const processB = new ProfileStore(workspace, clock, { lock: { chains: new Map() } });
    await Promise.all(SOURCE_CATEGORIES.map((category, index) => (index % 2 === 0 ? processA : processB).accountSource(category, category === "resume" ? "provided" : "not_applicable")));
    expect(Object.keys((await store.read()).sources)).toHaveLength(7);

    const extracted = await store.extractClaims("resume", [
      { text: "Worked on the Harbor deployment pipeline.", kind: "fact", evidenceRef: "resume.md#a", evidenceQuote: "Harbor" },
      { text: "Contributed to Ledgerkit.", kind: "fact", evidenceRef: "resume.md#b", evidenceQuote: "Ledgerkit" },
    ]);
    const [first, second] = extracted.profile.claims;
    await Promise.all([processA.decideClaim(first!.id, "confirmed"), processB.decideClaim(second!.id, "excluded")]);
    expect((await store.read()).claims.map((c) => c.status)).toEqual(["confirmed", "excluded"]);
  });

  it("breaks a lock older than 30 s, left by a process that died, with a log line", async () => {
    const { workspace, clock } = await setup();
    const lock = path.join(workspace.root, ".runner", "profile.lock");
    await writeFile(lock, `${JSON.stringify({ token: "dead-process", pid: 999999, acquiredAt: "2026-09-22T08:00:00.000Z" })}\n`);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    const logs: string[] = [];
    const store = new ProfileStore(workspace, clock, { lock: { log: (message) => logs.push(message) } });
    expect((await store.accountSource("resume", "provided")).ok).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^profile\.lock was held for (59|60|61) s, longer than 30 s: broke it \(.*dead-process.*\)\.$/);
    await expect(readFile(lock, "utf8")).rejects.toMatchObject({ code: "ENOENT" }); // released after the write
  });

  it("waits for a lock another process holds, then writes", async () => {
    const { workspace, clock, store } = await setup();
    const lock = path.join(workspace.root, ".runner", "profile.lock");
    await writeFile(lock, `${JSON.stringify({ token: "other-process", pid: 999999, acquiredAt: new Date().toISOString() })}\n`);
    const started = Date.now();
    setTimeout(() => void unlink(lock), 300);
    const result = await new ProfileStore(workspace, clock).accountSource("resume", "provided");
    expect(result.ok).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect((await store.read()).sources.resume?.status).toBe("provided");
  });

  it("gives up with 'The profile is busy' when the lock stays held, writing nothing", async () => {
    const { workspace, clock, store } = await setup();
    await store.accountSource("resume", "provided");
    const draft = path.join(workspace.root, "career-profile.draft.json");
    const before = await readFile(draft, "utf8");
    const lock = path.join(workspace.root, ".runner", "profile.lock");
    await writeFile(lock, `${JSON.stringify({ token: "other-process", pid: 999999, acquiredAt: new Date().toISOString() })}\n`);
    const busy = new ProfileStore(workspace, clock, { lock: { waitMs: 200 } });
    const error = await busy.accountSource("workSamples", "unavailable").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProfileBusyError);
    expect((error as Error).message).toBe(PROFILE_BUSY_MESSAGE);
    expect(await readFile(draft, "utf8")).toBe(before);
    expect(await readFile(lock, "utf8")).toContain("other-process"); // never touched a live lock
  });
});

describe("D13: source text files", () => {
  it("names uploads stably from the original name, and refuses anything but .txt and .md", () => {
    expect(uploadFileName("resume.md")).toBe("resume.md");
    expect(uploadFileName("Ada Quill resume (final).MD")).toBe("ada-quill-resume-final.md");
    expect(uploadFileName("Resume.md")).toBe(uploadFileName("resume.md"));
    expect(uploadFileName("../../career-profile.json.txt")).toBe("career-profile-json.txt");
    expect(uploadFileName("..\\..\\notes.txt")).toBe("notes.txt");
    expect(uploadFileName("pasted.txt")).toBe("pasted-file.txt");
    expect(uploadFileName("???.md")).toBe("upload.md");
    expect(uploadFileName(".md")).toBe("upload.md");
    expect(() => uploadFileName("resume.pdf")).toThrow(UnsupportedUploadError);
    expect(() => uploadFileName("resume.md.exe")).toThrow('"resume.md.exe" is not a .txt or .md file.');
    expect(() => uploadFileName("notes")).toThrow(UnsupportedUploadError);
  });

  it("keeps the text box's text raw in pasted.txt, apart from uploads", async () => {
    const { store, workspace } = await setup();
    await store.savePastedText("resume", "Ada Quill\nSenior Platform Engineer, Northwind Labs");
    expect(await store.pastedText("resume")).toBe("Ada Quill\nSenior Platform Engineer, Northwind Labs");
    await store.saveUpload("resume", "cover.md", "Dear Harbor team,");
    await store.saveUpload("resume", "portfolio notes.txt", "Ledgerkit maintainer notes.");
    expect(await store.listUploads("resume")).toEqual(["cover.md", "portfolio-notes.txt"]);
    await store.saveUpload("resume", "Cover.md", "Dear Quill team,");
    expect(await store.listUploads("resume")).toEqual(["cover.md", "portfolio-notes.txt"]); // replaced, not piled up (VN11)
    expect(await readFile(path.join(workspace.root, "sources", "resume", "cover.md"), "utf8")).toBe("Dear Quill team,");
    expect(await store.pastedText("resume")).toBe("Ada Quill\nSenior Platform Engineer, Northwind Labs"); // no headers (V2)
    expect(await store.sourceText("resume")).toBe(
      "## pasted.txt\n\nAda Quill\nSenior Platform Engineer, Northwind Labs\n\n---\n\n## cover.md\n\nDear Quill team,\n\n---\n\n## portfolio-notes.txt\n\nLedgerkit maintainer notes.",
    );
    expect(await store.pastedText("workSamples")).toBe("");
  });

  it("VN4: a traversal name lands at its cleaned name under sources/<category>/ and nowhere else", async () => {
    const { store, workspace } = await setup();
    const rootBefore = (await readdir(workspace.root)).sort();
    const { fileName } = await store.saveUpload("resume", "../../career-profile.json.md", "Not the real profile.");
    expect(fileName).toBe("career-profile-json.md");
    expect(await readdir(path.join(workspace.root, "sources", "resume"))).toEqual(["career-profile-json.md"]);
    expect((await readdir(workspace.root)).sort()).toEqual(rootBefore);
    expect(await readdir(path.join(workspace.root, "sources"))).toEqual(["resume"]);
  });

  it("VN3: refuses to write through a sources/<category> symlink that leaves the workspace", async () => {
    const { store, workspace } = await setup();
    const outside = await tempDir("wc-outside-");
    await mkdir(path.join(workspace.root, "sources"), { recursive: true });
    await symlink(outside, path.join(workspace.root, "sources", "resume"));
    await expect(store.saveUpload("resume", "resume.md", "Ada Quill")).rejects.toThrow(/leaves the workspace through a symlink/);
    await expect(store.savePastedText("resume", "Ada Quill")).rejects.toThrow(/leaves the workspace through a symlink/);
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("the Profile page's markdown save", () => {
  it("applies an edit made against the current copy, and refuses a stale copy without applying it", async () => {
    const { store, md } = await setup();
    const claimId = await withConfirmedClaim(store);
    const loaded = await store.load();
    const page = renderProfileMarkdown(loaded.profile);
    const base = sha256(page);

    const saved = await store.applyMarkdownEdit(page.replace("Worked on the Harbor", "Rebuilt the Harbor"), base);
    expect(saved.message).toBe("Saved. 1 edit was applied.");
    expect(saved.profile.claims.find((c) => c.id === claimId)?.text).toBe("Rebuilt the Harbor deployment pipeline.");

    // The same page copy again: the profile has moved on since, so it is stale.
    await expect(store.applyMarkdownEdit(page.replace("Worked on the Harbor", "Led the Harbor"), base)).rejects.toThrow("Not saved: the profile changed since this page loaded. Copy your text, then reload.");
    expect((await store.read()).claims[0]!.text).toBe("Rebuilt the Harbor deployment pipeline.");

    const unchanged = await store.applyMarkdownEdit(await readFile(md, "utf8"), sha256(await readFile(md, "utf8")));
    expect(unchanged.message).toBe("Nothing to save: the text is the same as the profile.");
  });

  it("while approved, reports a proposed revision (no misleading 'proposed above' on a no-change save)", async () => {
    const { store } = await setup();
    await withConfirmedClaim(store);
    await store.approve();
    const page = renderProfileMarkdown(await store.read());
    const unchanged = await store.applyMarkdownEdit(page, sha256(page));
    expect(unchanged.message).toBe("Nothing to save: the text is the same as the profile.");
    const saved = await store.applyMarkdownEdit(page.replace("Worked on the Harbor", "Rebuilt the Harbor"), sha256(page));
    expect(saved.message).toBe("Saved. 1 edit proposed; version 1 stays in force until you decide.");
  });

  it("refuses an unreadable page edit with the reason, and a page copy older than a hand edit to the file", async () => {
    const { store, md } = await setup();
    const claimId = await withConfirmedClaim(store);
    const page = renderProfileMarkdown(await store.read());
    await expect(store.applyMarkdownEdit(page.replace(` \`[${claimId}]\``, ""), sha256(page))).rejects.toMatchObject({ name: "ProfileMarkdownError", origin: "request" });

    await handEdit(md, "- Worked on the Harbor deployment pipeline.", "- Rebuilt the Harbor deployment pipeline.");
    await expect(store.applyMarkdownEdit(page.replace("Worked on the Harbor", "Led the Harbor"), sha256(page))).rejects.toThrow(
      "Not saved: the file changed outside this page. Copy your text, then reload.",
    );
    expect((await store.read()).claims[0]!.text).toBe("Rebuilt the Harbor deployment pipeline."); // the file's edit, saved; the page's, not
  });
});
