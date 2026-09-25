import { z } from "zod";
import type { Draft } from "./validator.ts";

/**
 * The shape of a draft, as `prepare_application` takes it from the model and
 * as a prepared version stores it (P05). Bounded, so no draft can grow a
 * record without limit. Headings are any short string here on purpose: the
 * validator refuses one outside the fixed list with a sentence the model
 * can act on, where a schema error would only say "invalid input".
 */

export const MAX_STATEMENT_LENGTH = 400;
export const MAX_SECTIONS = 8;
export const MAX_STATEMENTS_PER_SECTION = 12;
export const MAX_PARAGRAPHS = 6;
export const MAX_STATEMENTS_PER_PARAGRAPH = 8;

const statementSchema = z.string().min(1).max(MAX_STATEMENT_LENGTH);

export const draftSectionSchema = z
  .object({
    heading: z.string().min(1).max(40),
    statements: z.array(statementSchema).max(MAX_STATEMENTS_PER_SECTION),
  })
  .strict();

export const resumeDraftSchema = z.object({ sections: z.array(draftSectionSchema).max(MAX_SECTIONS) }).strict();

export const coverLetterDraftSchema = z
  .object({ paragraphs: z.array(z.array(statementSchema).min(1).max(MAX_STATEMENTS_PER_PARAGRAPH)).max(MAX_PARAGRAPHS) })
  .strict();

export const draftSchema = z
  .object({
    resume: resumeDraftSchema,
    coverLetter: coverLetterDraftSchema.optional(),
  })
  .strict() satisfies z.ZodType<Draft>;
