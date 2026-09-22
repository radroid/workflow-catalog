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
import { renderProfileMarkdown, parseProfileMarkdownEdits, updateStatements } from "./profile-markdown.ts";
import {
  reduce,
  readiness as computeReadiness,
  type Action,
  type ClaimDecision,
  type ExtractedClaimInput,
  type ReduceResult,
  type Readiness,
} from "./profile-reducer.ts";
import { createInitialProfile, isSourcesComplete, toCareerProfile, type OnboardingProfile, type SourceCategory } from "./profile-types.ts";
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
    const target = this.#workspace.resolve("sources", category, safe);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFileAtomic(target, text);
    return { fileName: safe };
  }

  async extractClaims(category: SourceCategory, extracted: readonly ExtractedClaimInput[]): Promise<ReduceResult & { readonly added: number }> {
    const before = await this.read();
    const result = await this.#mutate({ type: "extractClaims", category, extracted, now: this.#now(), newId });
    const added = result.ok ? result.profile.claims.length - before.claims.length : 0;
    return { ...result, added };
  }

  async decideClaim(claimId: string, decision: ClaimDecision, question?: string): Promise<ReduceResult> {
    return this.#mutate(question !== undefined ? { type: "decideClaim", claimId, decision, now: this.#now(), question } : { type: "decideClaim", claimId, decision, now: this.#now() });
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
   * Applies `` `[id]` ``-marked text edits from an edited `career-profile.md`
   * back into the profile (F5's round trip). A confirmed claim's text change
   * is routed through the reducer's `editClaimText` action one claim at a
   * time — not the pure `applyMarkdownEdits` helper in `profile-markdown.ts`,
   * which has no notion of approval — so an edit to an already-approved
   * profile proposes a revision instead of silently overwriting what was
   * approved (F5: "after approval, edits become revisions with an explicit
   * accept"; matches `profile.html`'s own copy). A candidate/disputed/
   * excluded claim has no approval/revision concept, so its text still
   * applies directly, same as before this method existed. Boundaries,
   * preferences, and presentation are the person's own free-form statements
   * with no revision concept either, so those apply directly too, via the
   * same `updateStatements` helper `applyMarkdownEdits` itself uses.
   */
  async applyMarkdownEdit(markdown: string): Promise<OnboardingProfile> {
    const current = await this.read();
    const edits = parseProfileMarkdownEdits(markdown);
    if (edits.size === 0) return current;

    let profile = current;
    for (const claim of current.claims) {
      const text = edits.get(claim.id);
      if (text === undefined || text === claim.text) continue;
      if (claim.status === "confirmed") {
        const result = reduce(profile, { type: "editClaimText", claimId: claim.id, text, now: this.#now(), newId });
        profile = result.profile;
      } else {
        profile = { ...profile, claims: profile.claims.map((c) => (c.id === claim.id ? { ...c, text } : c)) };
      }
    }
    profile = {
      ...profile,
      boundaries: updateStatements(profile.boundaries, edits),
      preferences: updateStatements(profile.preferences, edits),
      presentation: updateStatements(profile.presentation, edits),
    };

    await this.#write(profile);
    return profile;
  }
}
