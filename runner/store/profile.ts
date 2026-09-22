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
import { renderProfileMarkdown, parseProfileMarkdownEdits } from "./profile-markdown.ts";
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
import type { Workspace } from "./workspace.ts";

/**
 * `career-profile.json` (and its in-progress predecessor,
 * `career-profile.draft.json`) plus the raw uploaded/pasted content under
 * `sources/<category>/` (mvp-spec §5). Wraps the pure `profile-reducer.ts`
 * with persistence: every mutating method reads the current profile, runs
 * one reducer action, and — only when the action succeeded — writes the
 * result back. `agent/tools/extract_claims.ts` and `ask_follow_up.ts` open
 * one of these over `process.env.RUNNER_WORKSPACE` per call, the same
 * pattern `agent/tools/open_application_group.ts` documents for P06.
 *
 * Until every one of the seven source categories is accounted for, the
 * profile cannot satisfy `careerProfileSchema` (see profile-types.ts's doc
 * comment), so it lives in `career-profile.draft.json`, validated by this
 * module's own (P03-only) lenient schema. The moment accounting completes,
 * the state graduates to `career-profile.json` — validated by the real
 * contract from then on — and the draft file is removed.
 */

const DRAFT_FILE = "career-profile.draft.json";
const FINAL_FILE = "career-profile.json";
const MARKDOWN_FILE = "career-profile.md";
const EXTRACTION_HASH_DIR = [".runner", "onboarding"] as const;

/** Hex SHA-256 of source text, for R7's idempotent-extraction check (a packet deliverable: re-running extraction against unchanged source content should not re-trigger a model call). */
function contentHash(text: string): string {
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

/** A directory-safe file name: letters, digits, dot, dash, underscore only, no leading dot. */
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function sanitizeSourceFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "upload.txt";
  return SAFE_FILE_NAME.test(base) ? base : `upload-${Date.now()}.txt`;
}

export { claimKindValues };
export type { ClaimDecision, ExtractedClaimInput, ReduceResult, Readiness, OnboardingProfile, SourceCategory };

export class ProfileStore {
  readonly #workspace: Workspace;
  readonly #clock: Clock;

  constructor(workspace: Workspace, clock: Clock) {
    this.#workspace = workspace;
    this.#clock = clock;
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }

  /** The current profile: the final file if accounting is complete, else the draft, else a brand-new profile. */
  async read(): Promise<OnboardingProfile> {
    const final = await this.#workspace.readJson(FINAL_FILE);
    if (final !== undefined) return careerProfileSchema.parse(final);
    const draft = await this.#workspace.readJson(DRAFT_FILE);
    if (draft !== undefined) return draftProfileSchema.parse(draft);
    return createInitialProfile(newId);
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
    // hard-problems #1, §7.6), written atomically on every profile write,
    // not just on request.
    await writeFileAtomic(await this.#workspace.resolveReal(MARKDOWN_FILE), renderProfileMarkdown(profile));
  }

  async #mutate(action: Action): Promise<ReduceResult> {
    const current = await this.read();
    const result = reduce(current, action);
    if (result.ok) await this.#write(result.profile);
    return result;
  }

  async readiness(): Promise<Readiness> {
    return computeReadiness(await this.read());
  }

  async accountSource(category: SourceCategory, status: "provided" | "unavailable" | "not_applicable", note?: string): Promise<ReduceResult> {
    return this.#mutate(note !== undefined ? { type: "accountSource", category, status, note } : { type: "accountSource", category, status });
  }

  /** Raw content for a category, every file under `sources/<category>/` concatenated (a filename header, then its text), for the extraction turn's user-message and for verifying a claimed quote is real. Empty string when nothing was uploaded/pasted yet. */
  async sourceText(category: SourceCategory): Promise<string> {
    const names = await this.#workspace.list("sources", category);
    const parts: string[] = [];
    for (const name of names) {
      if (name.startsWith(".")) continue;
      // Plain text on disk (fictional .md/.txt fixtures only, fixtures-policy.md; PDF/DOCX extraction is out of this packet's scope — see the P03 report), so read directly rather than through the JSON helpers.
      const text = await readFile(await this.#workspace.resolveReal("sources", category, name), "utf8").catch(() => undefined);
      if (text !== undefined) parts.push(`## ${name}\n\n${text}`);
    }
    return parts.join("\n\n---\n\n");
  }

  /** Stores raw uploaded/pasted text for a category under `sources/<category>/`, spec §5, as a plain text file the person can open directly. Never sent anywhere except the model call that later extracts it. */
  async saveSourceContent(category: SourceCategory, fileName: string, text: string): Promise<{ readonly fileName: string }> {
    const safe = sanitizeSourceFileName(fileName);
    // resolveReal (not resolve): follows symlinks on the part of the path that
    // already exists, so a symlinked sources/<category> pointing outside the
    // workspace is refused here the same way a *read* of it already is
    // (Workspace.readJson/list both go through resolveReal) — resolve() alone
    // only checks the literal path string, which a write then follows through
    // the symlink at the OS level regardless.
    const target = await this.#workspace.resolveReal("sources", category, safe);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFileAtomic(target, text);
    return { fileName: safe };
  }

  /** The content hash recorded after the last extraction attempt for this category, or undefined if none yet (R7). */
  async extractionContentHash(category: SourceCategory): Promise<string | undefined> {
    const stored = await this.#workspace.readJson(...EXTRACTION_HASH_DIR, `${category}.json`);
    if (!stored || typeof stored !== "object" || !("hash" in stored) || typeof (stored as { hash: unknown }).hash !== "string") return undefined;
    return (stored as { hash: string }).hash;
  }

  /** Whether `text` matches the hash recorded after the last extraction attempt — R7's idempotency check, read-only (the caller decides whether to skip a session and never records a hash on its own). */
  async isSourceContentUnchanged(category: SourceCategory, text: string): Promise<boolean> {
    const stored = await this.extractionContentHash(category);
    return stored !== undefined && stored === contentHash(text);
  }

  /** Records the content hash for this category, so a later identical extraction attempt can be skipped (R7). The caller decides when to call this — typically only after a turn that actually completed, so a failed attempt is retried against the same content next time. */
  async recordExtractionContentHash(category: SourceCategory, text: string): Promise<void> {
    await this.#workspace.writeJson([...EXTRACTION_HASH_DIR, `${category}.json`], { hash: contentHash(text) });
  }

  async extractClaims(category: SourceCategory, extracted: readonly ExtractedClaimInput[]): Promise<ReduceResult & { readonly added: number }> {
    const before = await this.read();
    const result = await this.#mutate({ type: "extractClaims", category, extracted, now: this.#now(), newId });
    const added = result.ok ? result.profile.claims.length - before.claims.length : 0;
    return { ...result, added };
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

  async approve(): Promise<ReduceResult> {
    return this.#mutate({ type: "approve", now: this.#now() });
  }

  async editClaimText(claimId: string, text: string): Promise<ReduceResult> {
    return this.#mutate({ type: "editClaimText", claimId, text, now: this.#now(), newId });
  }

  /** The statement-level counterpart of `editClaimText` — same direct-edit-vs-propose-revision split (R2). */
  async editStatementText(kind: StatementKind, statementId: string, text: string): Promise<ReduceResult> {
    return this.#mutate({ type: "editStatementText", kind, statementId, text, now: this.#now(), newId });
  }

  async acceptRevision(revisionId: string): Promise<ReduceResult> {
    return this.#mutate({ type: "acceptRevision", revisionId, now: this.#now() });
  }

  async rejectRevision(revisionId: string): Promise<ReduceResult> {
    return this.#mutate({ type: "rejectRevision", revisionId, now: this.#now() });
  }

  async renderMarkdown(): Promise<string> {
    return renderProfileMarkdown(await this.read());
  }

  /**
   * Applies every `` `[id]` ``-marked text edit in `markdown` to `current`,
   * routing each CHANGED id through the matching reducer action rather than
   * the pure `applyMarkdownEdits` helper in `profile-markdown.ts` (which has
   * no notion of approval): a confirmed claim goes through `editClaimText`,
   * a boundary/preference/presentation statement through `editStatementText`
   * — both propose a revision instead of overwriting outright once the
   * profile is approved (F5: "after approval, edits become revisions with an
   * explicit accept"; matches `profile.html`'s own copy). A candidate/
   * disputed/excluded claim has no approval/revision concept, so its text
   * still applies directly. Returns `current` itself (same reference) when
   * nothing actually changed, so callers can cheaply skip a write.
   */
  #applyEditsToProfile(current: OnboardingProfile, markdown: string): OnboardingProfile {
    const edits = parseProfileMarkdownEdits(markdown);
    if (edits.size === 0) return current;

    let profile = current;
    for (const claim of current.claims) {
      const text = edits.get(claim.id);
      if (text === undefined || text === claim.text) continue;
      if (claim.status === "confirmed") {
        profile = reduce(profile, { type: "editClaimText", claimId: claim.id, text, now: this.#now(), newId }).profile;
      } else {
        profile = { ...profile, claims: profile.claims.map((c) => (c.id === claim.id ? { ...c, text } : c)) };
      }
    }
    for (const kind of ["boundary", "preference", "presentation"] as const satisfies readonly StatementKind[]) {
      const field = statementField(kind);
      for (const statement of current[field]) {
        const text = edits.get(statement.id);
        if (text === undefined || text === statement.text) continue;
        profile = reduce(profile, { type: "editStatementText", kind, statementId: statement.id, text, now: this.#now(), newId }).profile;
      }
    }
    return profile;
  }

  /** Applies `` `[id]` ``-marked text edits from an edited `career-profile.md` back into the profile (F5's round trip) — the local UI's "Save edits" path. See `#applyEditsToProfile` for how a confirmed claim/statement edit becomes a revision once approved. */
  async applyMarkdownEdit(markdown: string): Promise<OnboardingProfile> {
    const current = await this.read();
    const profile = this.#applyEditsToProfile(current, markdown);
    if (profile === current) return current;
    await this.#write(profile);
    return profile;
  }

  /**
   * R10: `career-profile.md` is a file the person can open directly, so an
   * edit made straight to the file (not through the UI) must round-trip too.
   * Compares the file on disk to the render of the current JSON; if they
   * differ, applies the file's edits the same way `applyMarkdownEdit` does
   * (through the reducer, so an approved profile's edits still become
   * revisions) and persists the result. A parse/apply error changes nothing
   * and is returned as `markdownError` for the caller to show, rather than
   * thrown — the route calls this before serving the Profile page and before
   * applying a markdown write (`POST /markdown`).
   */
  async reconcileMarkdownFile(): Promise<{ readonly profile: OnboardingProfile; readonly markdownError?: string }> {
    const current = await this.read();
    let onDisk: string | undefined;
    try {
      onDisk = await readFile(await this.#workspace.resolveReal(MARKDOWN_FILE), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (onDisk === undefined || onDisk === renderProfileMarkdown(current)) return { profile: current };
    try {
      const reconciled = this.#applyEditsToProfile(current, onDisk);
      if (reconciled !== current) await this.#write(reconciled);
      return { profile: reconciled };
    } catch (error) {
      return { profile: current, markdownError: error instanceof Error ? error.message : String(error) };
    }
  }
}
