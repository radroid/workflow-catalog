import { createHash } from "node:crypto";
import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  careerProfileSchema,
  claimSchema,
  profileStatementSchema,
  sourceCategorySchema,
  sourceEntrySchema,
  type ClaimKind,
} from "@workflow-catalog/contracts";
import type { Clock } from "../lib/clock.ts";
import { newId } from "../lib/crypto.ts";
import { writeFileAtomic } from "./atomic.ts";
import { readMarkdownEdits, renderProfileMarkdown } from "./profile-markdown.ts";
import {
  reduce,
  readiness as computeReadiness,
  type Action,
  type ClaimDecision,
  type ExtractedClaimInput,
  type ReduceResult,
  type Readiness,
} from "./profile-reducer.ts";
import {
  createInitialProfile,
  isSourcesComplete,
  statementField,
  toCareerProfile,
  type OnboardingProfile,
  type SourceCategory,
  type StatementKind,
} from "./profile-types.ts";
import { withProfileLock, type ProfileLockOptions } from "./profile-writes.ts";
import type { Workspace } from "./workspace.ts";

/**
 * `career-profile.json` (and its in-progress predecessor,
 * `career-profile.draft.json`), `career-profile.md`, and the raw source text
 * under `sources/<category>/` (mvp-spec §5). Wraps the pure
 * `profile-reducer.ts` with persistence.
 *
 * Every write (P03 revision 2):
 *
 * - D8: runs under `withProfileLock` (`profile-writes.ts`): this process's
 *   per-workspace chain plus the cross-process `.runner/profile.lock`, held
 *   only for read, reconcile, reduce and write. The bridge's routes and the
 *   eve process's tool steps (`agent/lib/onboarding-store.ts`) both come
 *   through here, so neither can lose the other's update.
 * - D9: reconciles `career-profile.md` first. A hand edit to the file is
 *   applied through the reducer (so an approved profile gets a proposed
 *   revision, never a silent overwrite). When the file can't be read (a
 *   marker removed or damaged, a line added or moved), the write is refused
 *   with ProfileMarkdownError: nothing is written and the file is not
 *   re-rendered, until the person fixes it or chooses
 *   `discardMarkdownEdits`.
 *
 * Until all seven source categories are accounted for, the profile cannot
 * satisfy `careerProfileSchema` (see profile-types.ts), so it lives in
 * `career-profile.draft.json`, validated by this module's own lenient schema.
 * Once accounting completes it moves to `career-profile.json`, validated by
 * the contract, and the draft file is removed.
 */

const DRAFT_FILE = "career-profile.draft.json";
const FINAL_FILE = "career-profile.json";
const MARKDOWN_FILE = "career-profile.md";
/**
 * P03.2 (round-4 reviewer nit 1, `store/profile.ts:364`): the bound on a
 * markdown POST body (`routes/onboarding.ts`'s `markdownBodySchema` and
 * `readBoundedJson` call, which import this) and on `LoadResult.markdownOnDisk`
 * — the file as it is on disk, shown while it can't be read (J3). A legitimate
 * write can never exceed this; a hand-edited file that does (someone pastes a
 * huge blob straight into career-profile.md) is sent back as `null` rather
 * than echoing an unbounded payload into the page's response.
 */
export const MAX_MARKDOWN_BYTES = 512 * 1024;
const ONBOARDING_STATE = [".runner", "onboarding"] as const;
/** The SHA-256 of the last career-profile.md this module wrote. A file with that hash is ours, not a hand edit, even if the JSON has moved on since. */
const MARKDOWN_FINGERPRINT = [...ONBOARDING_STATE, "markdown.json"] as const;
/** D13: the one file the Onboarding page's text box edits, per category. */
export const PASTED_FILE = "pasted.txt";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const claimKindValues = ["fact", "metric", "title", "date", "credential"] as const satisfies readonly ClaimKind[];

const draftProfileSchema = z
  .object({
    claims: z.array(claimSchema),
    sources: z.partialRecord(sourceCategorySchema, sourceEntrySchema),
    preferences: z.array(profileStatementSchema),
    boundaries: z.array(profileStatementSchema),
    presentation: z.array(profileStatementSchema),
    approval: z
      .object({ version: z.number().int().positive(), at: z.string() })
      .strict()
      .nullable(),
    revisions: z.array(
      z
        .object({
          id: z.string(),
          summary: z.string(),
          proposedAt: z.string(),
          status: z.enum(["proposed", "accepted", "rejected"]),
          resultingVersion: z.number().int().positive().optional(),
          decidedAt: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();

/**
 * D9: career-profile.md (or a markdown edit sent by the Profile page) can't be
 * read, so nothing was written. `problem` is the reader's plain sentence,
 * named by line number ("Line 14: …") and never by a marker's id (revision 3,
 * J3); the pages show it in their note about the file.
 */
export class ProfileMarkdownError extends Error {
  override readonly name = "ProfileMarkdownError";
  readonly origin: "file" | "request";
  readonly problem: string;
  constructor(problem: string, origin: "file" | "request") {
    super(origin === "file" ? `career-profile.md has an edit the runner can't read. ${problem} Nothing was saved.` : `Your edit can't be read. ${problem} Nothing was saved.`);
    this.origin = origin;
    this.problem = problem;
  }
}

/** D13: an upload whose name isn't `.txt` or `.md`. */
export class UnsupportedUploadError extends Error {
  override readonly name = "UnsupportedUploadError";
}

/** The Profile page's markdown edit was made against a version of the profile that has since changed. */
export class StaleMarkdownError extends Error {
  override readonly name = "StaleMarkdownError";
}

const UPLOAD_EXTENSION = /\.(txt|md)$/i;

/**
 * D13/VN11: a stable, safe file name for an upload, derived from its original
 * name, so uploading the same file again replaces the earlier copy. Only the
 * last path segment is used (both `/` and `\`); anything but letters, digits,
 * `-` and `_` becomes `-`; the whole name is lower-cased, so "Resume.md" and
 * "resume.md" are the same upload on every file system. `pasted.txt` belongs
 * to the text box, so an upload with that name becomes `pasted-file.txt`.
 * Throws UnsupportedUploadError for a name that isn't `.txt` or `.md`.
 */
export function uploadFileName(original: string): string {
  const base = original.split(/[\\/]/).pop() ?? "";
  const match = UPLOAD_EXTENSION.exec(base);
  if (!match) throw new UnsupportedUploadError(`"${base || original}" is not a .txt or .md file. Only plain text and Markdown files can be uploaded; paste other text into the box instead.`);
  const stem = base
    .slice(0, match.index)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 80);
  const name = `${stem || "upload"}.${match[1]!.toLowerCase()}`;
  return name === PASTED_FILE ? "pasted-file.txt" : name;
}

export { claimKindValues };
export type { ClaimDecision, ExtractedClaimInput, ReduceResult, Readiness, OnboardingProfile, SourceCategory };

export interface ProfileStoreOptions {
  /** Passed to `withProfileLock`; tests shorten the wait or stand in for a second process. */
  readonly lock?: ProfileLockOptions;
}

export interface LoadResult {
  readonly profile: OnboardingProfile;
  /** D9: why career-profile.md can't be read ("Line 14: …"), or null when it is fine. */
  readonly markdownError: string | null;
  /** J3: the file as it is on disk while it can't be read (the Profile page shows it instead of the runner's render); null otherwise. */
  readonly markdownOnDisk: string | null;
}

export interface MarkdownSaveResult {
  readonly profile: OnboardingProfile;
  readonly message: string;
}

interface Reconciled {
  readonly profile: OnboardingProfile;
  /** Hand edits applied directly. */
  readonly applied: number;
  /** Hand edits that became proposed revisions (the profile is approved). */
  readonly proposed: number;
  /** The markdown on disk is not the render of `profile`: write it again even if nothing else changes. */
  readonly rerender: boolean;
}

/**
 * Put before an action's message when the write also saved hand edits to
 * career-profile.md: short, since the whole message is one pinned line (J5).
 *
 * P03.2 (round-4 reviewer nit 5): this used to say "file edit(s) ... saved" /
 * "... proposed as a revision/revisions", which the reviewer measured pushing
 * a combined message to 106 characters (`profile.ts:192-199`, `:347` at the
 * time). "edit(s)" alone matches this module's own `applyMarkdownEdit`
 * messages ("1 edit was applied", "2 edits are now proposed revisions") and
 * `discardMarkdownEdits`'s "Discarded your edits" — "file edit" was this
 * function's own inconsistent wording, not an established term elsewhere —
 * and dropping "as a/revision(s)" removes the one clause with no fixed
 * length. See profile.test.ts for the combined-length check.
 */
function editsNote(applied: number, proposed: number): string {
  const parts: string[] = [];
  if (applied > 0) parts.push(`${applied === 1 ? "1 edit" : `${applied} edits`} saved`);
  if (proposed > 0) parts.push(`${proposed === 1 ? "1 edit" : `${proposed} edits`} proposed`);
  if (parts.length === 0) return "";
  const sentence = parts.join(", ");
  return `${sentence[0]!.toUpperCase()}${sentence.slice(1)}.`;
}

export class ProfileStore {
  readonly #workspace: Workspace;
  readonly #clock: Clock;
  readonly #lock: ProfileLockOptions;

  constructor(workspace: Workspace, clock: Clock, options: ProfileStoreOptions = {}) {
    this.#workspace = workspace;
    this.#clock = clock;
    this.#lock = options.lock ?? {};
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }

  /** The profile as stored in JSON: the final file if accounting is complete, else the draft, else a brand-new profile. No lock and no reconcile; for a view that should include hand edits, use `load`. */
  async read(): Promise<OnboardingProfile> {
    return (await this.#stored()) ?? createInitialProfile(newId);
  }

  async #stored(): Promise<OnboardingProfile | undefined> {
    const final = await this.#workspace.readJson(FINAL_FILE);
    if (final !== undefined) return careerProfileSchema.parse(final);
    const draft = await this.#workspace.readJson(DRAFT_FILE);
    if (draft !== undefined) return draftProfileSchema.parse(draft);
    return undefined;
  }

  async #writeMarkdown(profile: OnboardingProfile): Promise<void> {
    const markdown = renderProfileMarkdown(profile);
    await writeFileAtomic(await this.#workspace.resolveReal(MARKDOWN_FILE), markdown);
    // After the file, never before: a crash in between leaves a file whose
    // hash matches no fingerprint, which reconcile then reads strictly and
    // finds identical to the JSON (no edit), instead of a stale file that
    // would pass for ours.
    await this.#workspace.writeJson([...MARKDOWN_FINGERPRINT], { sha256: sha256(markdown) });
  }

  async #write(profile: OnboardingProfile): Promise<void> {
    if (isSourcesComplete(profile.sources)) {
      await this.#workspace.writeJson([FINAL_FILE], toCareerProfile(profile));
      await unlink(this.#workspace.resolve(DRAFT_FILE)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    } else {
      await this.#workspace.writeJson([DRAFT_FILE], draftProfileSchema.parse(profile));
    }
    // R10: career-profile.md is a file the person can open (mvp-spec §5,
    // hard-problems #1, §7.6), rewritten on every profile write.
    await this.#writeMarkdown(profile);
  }

  async #readMarkdownFile(): Promise<string | undefined> {
    try {
      return await readFile(await this.#workspace.resolveReal(MARKDOWN_FILE), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async #readFingerprint(): Promise<string | undefined> {
    const stored = await this.#workspace.readJson(...MARKDOWN_FINGERPRINT);
    if (!stored || typeof stored !== "object" || typeof (stored as { sha256?: unknown }).sha256 !== "string") return undefined;
    return (stored as { sha256: string }).sha256;
  }

  /** Runs each parsed text edit through the reducer: a direct edit, or a proposed revision once the profile is approved (F5, R10). */
  #applyEdits(current: OnboardingProfile, edits: ReadonlyMap<string, string>): Reconciled {
    let profile = current;
    let applied = 0;
    let proposed = 0;
    const count = (before: OnboardingProfile, after: OnboardingProfile) => {
      if (after.revisions.filter((r) => r.status === "proposed").length > before.revisions.filter((r) => r.status === "proposed").length) proposed++;
      else applied++;
    };
    for (const claim of current.claims) {
      const text = edits.get(claim.id);
      if (text === undefined || text === claim.text) continue;
      const result = reduce(profile, { type: "editClaimText", claimId: claim.id, text, now: this.#now(), newId });
      if (result.ok && result.profile !== profile) {
        count(profile, result.profile);
        profile = result.profile;
      }
    }
    for (const kind of ["boundary", "preference", "presentation"] as const satisfies readonly StatementKind[]) {
      for (const statement of current[statementField(kind)]) {
        const text = edits.get(statement.id);
        if (text === undefined || text === statement.text) continue;
        const result = reduce(profile, { type: "editStatementText", kind, statementId: statement.id, text, now: this.#now(), newId });
        if (result.ok && result.profile !== profile) {
          count(profile, result.profile);
          profile = result.profile;
        }
      }
    }
    return { profile, applied, proposed, rerender: true };
  }

  /**
   * D9: brings hand edits in career-profile.md into `current`. Call with the
   * lock held. The file is taken as a hand edit only when it is neither the
   * render of `current` nor the last file this module wrote (its
   * fingerprint). Throws ProfileMarkdownError, having written nothing, when
   * the edit can't be read.
   */
  async #reconcile(current: OnboardingProfile): Promise<Reconciled> {
    const unchanged: Reconciled = { profile: current, applied: 0, proposed: 0, rerender: false };
    const onDisk = await this.#readMarkdownFile();
    if (onDisk === undefined) return { ...unchanged, rerender: true };
    if (onDisk === renderProfileMarkdown(current)) return unchanged;
    if ((await this.#readFingerprint()) === sha256(onDisk)) return { ...unchanged, rerender: true };
    const read = readMarkdownEdits(current, onDisk);
    if (!read.ok) throw new ProfileMarkdownError(read.problem, "file");
    return this.#applyEdits(current, read.edits);
  }

  /**
   * Read, reconcile, then `work` on the reconciled profile, all under the
   * lock. Writes the profile `work` returns when it says so, when reconcile
   * applied hand edits, or when nothing was stored yet; otherwise rewrites
   * only a stale career-profile.md. A ProfileMarkdownError from reconcile
   * propagates before anything is written.
   */
  async #transaction<T extends { readonly profile: OnboardingProfile; readonly write: boolean }>(work: (profile: OnboardingProfile, reconciled: Reconciled) => T): Promise<T> {
    return withProfileLock(
      this.#workspace,
      async () => {
        const stored = await this.#stored();
        const reconciled = await this.#reconcile(stored ?? createInitialProfile(newId));
        const outcome = work(reconciled.profile, reconciled);
        if (outcome.write || stored === undefined || reconciled.applied + reconciled.proposed > 0) {
          await this.#write(outcome.profile);
        } else if (reconciled.rerender) {
          await this.#writeMarkdown(outcome.profile);
        }
        return outcome;
      },
      this.#lock,
    );
  }

  async #mutate(action: Action): Promise<ReduceResult> {
    const { result } = await this.#transaction((profile, reconciled) => {
      const reduced = reduce(profile, action);
      const note = editsNote(reconciled.applied, reconciled.proposed);
      return { profile: reduced.profile, write: reduced.ok, result: note ? { ...reduced, message: `${note} ${reduced.message}` } : reduced };
    });
    return result;
  }

  /**
   * The profile for a page to show, with any hand edits to career-profile.md
   * applied first (under the lock). When the file can't be read, returns the
   * JSON profile, the reader's problem as `markdownError`, and the file as it
   * is on disk (J3), and writes nothing.
   */
  async load(): Promise<LoadResult> {
    try {
      const { profile } = await this.#transaction((reconciled) => ({ profile: reconciled, write: false }));
      return { profile, markdownError: null, markdownOnDisk: null };
    } catch (error) {
      if (!(error instanceof ProfileMarkdownError)) throw error;
      const onDisk = await this.#readMarkdownFile();
      // Nit 1: null past MAX_MARKDOWN_BYTES, not an unbounded echo of whatever is on disk.
      const markdownOnDisk = onDisk !== undefined && Buffer.byteLength(onDisk, "utf8") <= MAX_MARKDOWN_BYTES ? onDisk : null;
      return { profile: await this.read(), markdownError: error.problem, markdownOnDisk };
    }
  }

  /** Readiness of the profile as `load` sees it, so a hand edit to career-profile.md counts before anything else is written (N7). */
  async readiness(): Promise<Readiness> {
    return computeReadiness((await this.load()).profile);
  }

  async accountSource(category: SourceCategory, status: "provided" | "unavailable" | "not_applicable", note?: string): Promise<ReduceResult> {
    return this.#mutate(note !== undefined ? { type: "accountSource", category, status, note } : { type: "accountSource", category, status });
  }

  async extractClaims(category: SourceCategory, extracted: readonly ExtractedClaimInput[]): Promise<ReduceResult & { readonly added: number }> {
    const { result } = await this.#transaction((profile, reconciled) => {
      const reduced = reduce(profile, { type: "extractClaims", category, extracted, now: this.#now(), newId });
      const note = editsNote(reconciled.applied, reconciled.proposed);
      const added = reduced.ok ? reduced.profile.claims.length - profile.claims.length : 0;
      return { profile: reduced.profile, write: reduced.ok, result: { ...reduced, message: note ? `${note} ${reduced.message}` : reduced.message, added } };
    });
    return result;
  }

  async decideClaim(claimId: string, decision: ClaimDecision, question?: string): Promise<ReduceResult> {
    return this.#mutate(
      question !== undefined
        ? { type: "decideClaim", claimId, decision, now: this.#now(), newId, question }
        : { type: "decideClaim", claimId, decision, now: this.#now(), newId },
    );
  }

  async answerQuestion(claimId: string, hasEvidence: boolean, statement?: string): Promise<ReduceResult> {
    return this.#mutate({ type: "answerQuestion", claimId, hasEvidence, statement, now: this.#now(), newId });
  }

  /** D10: keeps the person's reply to a follow-up question as a note on it; the claim stays disputed. */
  async recordQuestionNote(claimId: string, note: string): Promise<ReduceResult> {
    return this.#mutate({ type: "recordQuestionNote", claimId, note, now: this.#now(), newId });
  }

  async approve(): Promise<ReduceResult> {
    return this.#mutate({ type: "approve", now: this.#now() });
  }

  async editClaimText(claimId: string, text: string): Promise<ReduceResult> {
    return this.#mutate({ type: "editClaimText", claimId, text, now: this.#now(), newId });
  }

  /** The statement-level counterpart of `editClaimText`: the same direct-edit-or-revision split (R2). */
  async editStatementText(kind: StatementKind, statementId: string, text: string): Promise<ReduceResult> {
    return this.#mutate({ type: "editStatementText", kind, statementId, text, now: this.#now(), newId });
  }

  /** Records a new boundary, preference or presentation note. */
  async addStatement(kind: StatementKind, text: string): Promise<ReduceResult> {
    return this.#mutate({ type: "addStatement", kind, text, now: this.#now(), newId });
  }

  async acceptRevision(revisionId: string): Promise<ReduceResult> {
    return this.#mutate({ type: "acceptRevision", revisionId, now: this.#now(), newId });
  }

  async rejectRevision(revisionId: string): Promise<ReduceResult> {
    return this.#mutate({ type: "rejectRevision", revisionId, now: this.#now() });
  }

  async renderMarkdown(): Promise<string> {
    return renderProfileMarkdown(await this.read());
  }

  /**
   * The Profile page's "Save edits": applies the text edits in `markdown` (a
   * whole career-profile.md, as the page shows it) the way a hand edit to the
   * file is applied. The file on disk is reconciled first. `base` is the
   * SHA-256 of the markdown the page loaded; when the profile has changed
   * since (so the page's copy is stale), nothing is applied and
   * StaleMarkdownError is thrown, rather than reverting someone else's
   * change. An unreadable edit throws ProfileMarkdownError("request").
   */
  async applyMarkdownEdit(markdown: string, base?: string): Promise<MarkdownSaveResult> {
    const outcome = await this.#transaction((current, reconciled): { profile: OnboardingProfile; write: boolean; message: string; refusal?: Error } => {
      // Hand edits found in the file are saved (the transaction writes them),
      // but the page's copy predates them, so its own text is not applied.
      if (reconciled.applied + reconciled.proposed > 0) {
        return {
          profile: current,
          write: false,
          message: "",
          refusal: new StaleMarkdownError("Not saved: the file changed outside this page. Copy your text, then reload."),
        };
      }
      if (base !== undefined && base !== sha256(renderProfileMarkdown(current))) {
        return {
          profile: current,
          write: false,
          message: "",
          refusal: new StaleMarkdownError("Not saved: the profile changed since this page loaded. Copy your text, then reload."),
        };
      }
      const read = readMarkdownEdits(current, markdown);
      if (!read.ok) return { profile: current, write: false, message: "", refusal: new ProfileMarkdownError(read.problem, "request") };
      const next = this.#applyEdits(current, read.edits);
      const parts = [
        next.applied > 0 ? `${next.applied === 1 ? "1 edit was" : `${next.applied} edits were`} applied` : "",
        next.proposed > 0
          ? `${next.proposed === 1 ? "1 edit is now a proposed revision" : `${next.proposed} edits are now proposed revisions`}; version ${current.approval?.version ?? 1} stays in force until you accept ${next.proposed === 1 ? "it" : "them"}`
          : "",
      ].filter(Boolean);
      const message = parts.length === 0 ? "Nothing to save: the text is the same as the profile." : `Saved. ${parts.join(", and ")}.`;
      return { profile: next.profile, write: parts.length > 0, message };
    });
    if (outcome.refusal) throw outcome.refusal;
    return { profile: outcome.profile, message: outcome.message };
  }

  /** D9: "Discard my edits to career-profile.md": rewrites the file from the JSON profile, dropping whatever the file says now. */
  async discardMarkdownEdits(): Promise<OnboardingProfile> {
    return withProfileLock(
      this.#workspace,
      async () => {
        const profile = await this.read();
        await this.#writeMarkdown(profile);
        return profile;
      },
      this.#lock,
    );
  }

  /** The SHA-256 of the current render, for `applyMarkdownEdit`'s `base`. */
  static markdownHash(markdown: string): string {
    return sha256(markdown);
  }

  // -------------------------------------------------------------------------
  // Source text (D13). Plain files under sources/<category>/, which the person
  // can open directly: the text box's own `pasted.txt`, and uploads kept under
  // their sanitised names. Separate files from the profile JSON, each written
  // atomically, so they need no profile lock.
  // -------------------------------------------------------------------------

  async #sourceFile(category: SourceCategory, name: string): Promise<string> {
    // resolveReal (not resolve): follows symlinks on the part of the path that
    // exists, so a symlinked sources/<category> pointing outside the workspace
    // is refused here, the same way reads through it already are.
    return this.#workspace.resolveReal("sources", category, name);
  }

  async #writeSourceFile(category: SourceCategory, name: string, text: string): Promise<void> {
    const target = await this.#sourceFile(category, name);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFileAtomic(target, text);
  }

  /** The text box's saved text for a category, raw (no headers), or "" when nothing was saved yet. */
  async pastedText(category: SourceCategory): Promise<string> {
    try {
      return await readFile(await this.#sourceFile(category, PASTED_FILE), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  /** Replaces the text box's file for a category. */
  async savePastedText(category: SourceCategory, text: string): Promise<void> {
    await this.#writeSourceFile(category, PASTED_FILE, text);
  }

  /** Saves an uploaded .txt/.md file under its stable sanitised name (`uploadFileName`), replacing an earlier upload of the same name. */
  async saveUpload(category: SourceCategory, originalName: string, text: string): Promise<{ readonly fileName: string }> {
    const fileName = uploadFileName(originalName);
    await this.#writeSourceFile(category, fileName, text);
    return { fileName };
  }

  /** The uploaded files for a category, by name (not the text box's file), sorted. */
  async listUploads(category: SourceCategory): Promise<string[]> {
    return (await this.#workspace.list("sources", category)).filter((name) => !name.startsWith(".") && name !== PASTED_FILE && UPLOAD_EXTENSION.test(name));
  }

  /** Everything saved for a category, each file under a `## <name>` header, for the extraction prompt and for checking a claimed quote is real. "" when nothing was saved. Never shown to the person as editable text. */
  async sourceText(category: SourceCategory): Promise<string> {
    const names = await this.#workspace.list("sources", category);
    const ordered = [...names.filter((name) => name === PASTED_FILE), ...names.filter((name) => name !== PASTED_FILE)];
    const parts: string[] = [];
    for (const name of ordered) {
      if (name.startsWith(".")) continue;
      // Plain text on disk (fictional .md/.txt fixtures only; PDF/DOCX
      // extraction is deferred to P03.1, see the P03 report).
      const text = await readFile(await this.#sourceFile(category, name), "utf8").catch(() => undefined);
      if (text !== undefined && text.trim()) parts.push(`## ${name}\n\n${text}`);
    }
    return parts.join("\n\n---\n\n");
  }

  // R7: idempotent extraction per source content hash.

  /** The content hash recorded after the last extraction that persisted claims for this category, or undefined (R7). */
  async extractionContentHash(category: SourceCategory): Promise<string | undefined> {
    const stored = await this.#workspace.readJson(...ONBOARDING_STATE, `${category}.json`);
    if (!stored || typeof stored !== "object" || !("hash" in stored) || typeof (stored as { hash: unknown }).hash !== "string") return undefined;
    return (stored as { hash: string }).hash;
  }

  /** Whether `text` matches the recorded hash. Read-only: the caller decides whether to skip a session. */
  async isSourceContentUnchanged(category: SourceCategory, text: string): Promise<boolean> {
    const stored = await this.extractionContentHash(category);
    return stored !== undefined && stored === sha256(text);
  }

  /** Records the content hash for this category (R7). The route calls this only after an extract_claims call in the turn persisted (D14). */
  async recordExtractionContentHash(category: SourceCategory, text: string): Promise<void> {
    await this.#workspace.writeJson([...ONBOARDING_STATE, `${category}.json`], { hash: sha256(text) });
  }
}
