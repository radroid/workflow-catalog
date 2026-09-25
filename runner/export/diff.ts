import type { ClaimKind } from "@workflow-catalog/contracts";
import { compareLabels } from "../validate/claims.ts";
import { citedLabels, stripCitations } from "../validate/text.ts";
import { draftStatements, type Draft } from "../validate/validator.ts";
import { cleanText } from "./document.ts";
import { escapeMarkdown } from "./markdown.ts";
import { diffWords, sameWords, type WordOp } from "./word-diff.ts";

/**
 * "What changed and why" (P05, mvp-spec F7): for every sentence of a
 * prepared version, the claim(s) it cites and how its wording differs from
 * them (the presentation change); and, from the second version on, what
 * changed since the version it replaces. Computed by the runner from the
 * citations, never written by the model, so it can't misreport a change.
 *
 * It quotes only this version's sentences and the confirmed claims they
 * cite. A sentence the new version dropped is named by the labels it cited,
 * never by its words: if it was dropped because its claim was excluded
 * since, quoting it would carry excluded content into a new document.
 */

export interface SourceClaim {
  readonly label: string;
  readonly kind: ClaimKind;
  readonly text: string;
}

export type PresentationChange = "same" | "shortened" | "reworded" | "combined";

export interface StatementDiff {
  readonly part: "resume" | "cover_letter";
  readonly heading?: string;
  readonly section: number;
  readonly statement: number;
  /** The sentence as exported: markers stripped. */
  readonly text: string;
  readonly labels: readonly string[];
  readonly sources: readonly SourceClaim[];
  /** From the cited claims' text to the statement's; null when too long to compare. */
  readonly ops: readonly WordOp[] | null;
  readonly change: PresentationChange;
}

export type VersionChangeKind = "added" | "reworded" | "removed" | "unchanged";

export interface VersionChange {
  readonly kind: VersionChangeKind;
  readonly part: "resume" | "cover_letter";
  readonly heading?: string;
  /** The new version's sentence; absent for a removed one, which is named by its labels only. */
  readonly text?: string;
  readonly labels: readonly string[];
  /** Labels a removed sentence cited that are no longer confirmed claims. */
  readonly noLongerConfirmed?: readonly string[];
}

function changeOf(ops: readonly WordOp[] | null, sourceCount: number): PresentationChange {
  if (sourceCount > 1) return "combined";
  if (!ops) return "reworded";
  const added = ops.some((op) => op.kind === "added");
  const removed = ops.some((op) => op.kind === "removed");
  if (!added && !removed) return "same";
  return added ? "reworded" : "shortened";
}

/** One entry per statement of `draft`, with its source claims (looked up by label in `sources`) and its presentation change. */
export function statementDiffs(draft: Draft, sources: ReadonlyMap<string, SourceClaim>): StatementDiff[] {
  return draftStatements(draft).map(({ where, text }) => {
    const labels = citedLabels(text);
    const cited = labels.map((label) => sources.get(label)).filter((source): source is SourceClaim => source !== undefined);
    const plain = cleanText(stripCitations(text));
    const ops = diffWords(cited.map((source) => source.text).join(" "), plain) ?? null;
    return {
      part: where.part,
      ...(where.heading !== undefined ? { heading: where.heading } : {}),
      section: where.section,
      statement: where.statement,
      text: plain,
      labels,
      sources: cited,
      ops,
      change: changeOf(ops, cited.length),
    };
  });
}

function labelKey(labels: readonly string[]): string {
  return [...labels].sort(compareLabels).join(",");
}

/**
 * What changed from `previous` to `next`, sentence by sentence, within each
 * part: the same words is unchanged; the same claims in other words is
 * reworded; anything else is added. A previous sentence nothing matched was
 * removed, and names only its labels (and which of them are no longer
 * confirmed, going by `confirmedLabels`).
 */
export function versionChanges(previous: readonly StatementDiff[], next: readonly StatementDiff[], confirmedLabels: ReadonlySet<string>): VersionChange[] {
  const unused = new Set(previous.map((_, index) => index));
  const changes: VersionChange[] = [];
  const take = (predicate: (old: StatementDiff) => boolean): number | undefined => {
    for (const index of unused) {
      if (predicate(previous[index]!)) {
        unused.delete(index);
        return index;
      }
    }
    return undefined;
  };
  for (const statement of next) {
    const base = { part: statement.part, ...(statement.heading !== undefined ? { heading: statement.heading } : {}), text: statement.text, labels: statement.labels };
    if (take((old) => old.part === statement.part && sameWords(old.text, statement.text)) !== undefined) {
      changes.push({ kind: "unchanged", ...base });
    } else if (take((old) => old.part === statement.part && labelKey(old.labels) === labelKey(statement.labels)) !== undefined) {
      changes.push({ kind: "reworded", ...base });
    } else {
      changes.push({ kind: "added", ...base });
    }
  }
  for (const index of [...unused].sort((a, b) => a - b)) {
    const old = previous[index]!;
    const gone = old.labels.filter((label) => !confirmedLabels.has(label));
    changes.push({
      kind: "removed",
      part: old.part,
      ...(old.heading !== undefined ? { heading: old.heading } : {}),
      labels: old.labels,
      ...(gone.length > 0 ? { noLongerConfirmed: gone } : {}),
    });
  }
  return changes;
}

function quoted(text: string): string {
  return `“${escapeMarkdown(text)}”`;
}

function place(part: "resume" | "cover_letter", heading?: string): string {
  return part === "resume" ? `Resume, ${heading ?? "resume"}` : "Cover letter";
}

function labelsList(labels: readonly string[]): string {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/** The presentation change in plain words: which words the sentence drops from its claims, and which it adds. */
export function presentationSummary(diff: StatementDiff): string {
  const from = labelsList(diff.labels);
  if (diff.change === "same") return `Same words as ${from}.`;
  if (!diff.ops) return `Reworded from ${from}.`;
  const words = (kind: "added" | "removed") => diff.ops!.filter((op) => op.kind === kind).map((op) => op.text.replace(/[.,;:]+$/, "")).filter(Boolean);
  const removed = words("removed");
  const added = words("added");
  const lead = diff.change === "combined" ? `Combines ${from}` : diff.change === "shortened" ? `Shortened from ${from}` : `Reworded from ${from}`;
  const parts: string[] = [];
  if (removed.length > 0) parts.push(`leaves out ${removed.map((text) => `“${text}”`).join(", ")}`);
  if (added.length > 0) parts.push(`adds ${added.map((text) => `“${text}”`).join(", ")}`);
  return parts.length > 0 ? `${lead}: ${parts.join("; ")}.` : `${lead}.`;
}

function changeLine(change: VersionChange): string {
  const where = place(change.part, change.heading);
  switch (change.kind) {
    case "added":
      return `- Added, ${where}: ${quoted(change.text ?? "")} (cites ${labelsList(change.labels)})`;
    case "reworded":
      return `- Reworded, ${where}: ${quoted(change.text ?? "")} (same claims: ${labelsList(change.labels)})`;
    case "unchanged":
      return `- Unchanged, ${where}: ${quoted(change.text ?? "")}`;
    case "removed": {
      const gone = change.noLongerConfirmed ?? [];
      const why = gone.length > 0 ? `, and ${labelsList(gone)} ${gone.length === 1 ? "is" : "are"} no longer ${gone.length === 1 ? "a confirmed claim" : "confirmed claims"}` : "";
      return `- Removed, ${where}: the sentence that cited ${labelsList(change.labels)}${why}`;
    }
  }
}

export interface DiffDocumentInput {
  readonly version: number;
  /** The version this one replaces, when there is one. */
  readonly replaces?: number;
  /** Written out: "September 24, 2026". */
  readonly preparedOn: string;
  readonly profileVersion: number;
  readonly jobRevision: number;
  readonly statements: readonly StatementDiff[];
  readonly changes: readonly VersionChange[];
  /** A re-export (revision 1, V8): the version whose checked sentences this one carries unchanged, exported again with no model turn. */
  readonly sameDraftAs?: number;
  /** Whether this version has a cover letter, whose name and contact line close it (X8). Defaults to false. */
  readonly coverLetter?: boolean;
  /** For a re-export: whether its name or contact line differs from the version it replaces (X5, X8). Defaults to true. */
  readonly newHeader?: boolean;
}

export interface ReexportNoteInput {
  /** The version whose checked sentences the re-export carries. */
  readonly sameDraftAs: number;
  /** The version it replaces: the one its changes are against. */
  readonly replaces: number;
  readonly changes: readonly VersionChange[];
  readonly coverLetter: boolean;
  readonly newHeader: boolean;
}

/**
 * What a re-export changed, in the words the page and `diff-v<n>.md` both use (revision 2, X8). The name and
 * contact line sit at the top of a resume and close a cover letter. "The same as in version N" is said only of
 * the version the changes are against, the one it replaces, and only when every sentence is: after a newer
 * version made for other inputs (the cover letter switched off and back on, say), the re-exported sentences
 * are an older version's, and the changes against the one it replaces are listed as they are.
 */
export function reexportNote(input: ReexportNoteInput): string {
  const sameAsReplaced = input.changes.every((change) => change.kind === "unchanged");
  if (sameAsReplaced && input.newHeader) {
    const where = input.coverLetter ? "changed, at the top of the resume and the end of the cover letter" : "at the top changed";
    return `Only the name and contact line ${where}. Every sentence is the same as in version ${input.replaces}, and no model ran.`;
  }
  const header = input.newHeader ? ", with your updated name and contact line" : "";
  const same = sameAsReplaced ? ` Every sentence is the same as in version ${input.replaces}.` : "";
  return `No model ran: version ${input.sameDraftAs}'s checked sentences were exported again${header}.${same}`;
}

/** `diff-v<n>.md`: the changes since the version it replaces, then every sentence with the claim behind it. */
export function renderDiffMarkdown(input: DiffDocumentInput): string {
  const lines: string[] = [`# What changed and why: version ${input.version}`, ""];
  lines.push(
    `Prepared ${input.preparedOn} from career profile version ${input.profileVersion} and job revision ${input.jobRevision}. ${
      input.replaces !== undefined ? `It replaces version ${input.replaces}.` : "This is the first version for this job."
    }`,
    "",
  );
  if (input.replaces !== undefined) {
    lines.push(`## Since version ${input.replaces}`, "");
    const shown = input.changes.filter((change) => change.kind !== "unchanged");
    const unchanged = input.changes.length - shown.length;
    if (input.sameDraftAs !== undefined) {
      const note = reexportNote({ sameDraftAs: input.sameDraftAs, replaces: input.replaces, changes: input.changes, coverLetter: input.coverLetter ?? false, newHeader: input.newHeader ?? true });
      lines.push(`- ${note}`);
    } else if (shown.length === 0) lines.push("- Nothing changed in the wording.");
    for (const change of shown) lines.push(changeLine(change));
    if (unchanged > 0 && shown.length > 0) lines.push(`- Unchanged: ${unchanged === 1 ? "1 sentence" : `${unchanged} sentences`}`);
    lines.push("");
  }
  lines.push("## Every sentence and the claim behind it", "");
  let group = "";
  let count = 0;
  for (const diff of input.statements) {
    const heading = diff.part === "resume" ? `Resume, ${diff.heading ?? "resume"}` : `Cover letter, paragraph ${diff.section + 1}`;
    if (heading !== group) {
      lines.push(`### ${escapeMarkdown(heading)}`, "");
      group = heading;
      count = 0;
    }
    count += 1;
    lines.push(`${count}. ${quoted(diff.text)}`);
    for (const source of diff.sources) lines.push(`   - Cites ${source.label} (${source.kind}): ${quoted(source.text)}`);
    lines.push(`   - Presentation: ${escapeMarkdown(presentationSummary(diff))}`, "");
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
