import {
  cleanText,
  currentWithdrawal,
  isNoDetailStatement,
  pendingRevisions,
  questionNotes,
  quoteClaim,
  statementLabel,
  type WithdrawalView,
} from "./profile-reducer.ts";
import type { Claim, OnboardingProfile, ProfileStatement, StatementKind } from "./profile-types.ts";

/**
 * `career-profile.md`: rendered from the JSON profile, and read back so an
 * edit to the Markdown round-trips into it (mvp-spec §3 F5). Mirrors
 * `packages/job-assistant/templates/career-profile.md.hbs`'s section headings
 * and the `` `[id]` `` marker convention documented there, hand-written
 * rather than run through Handlebars (the P01 packet decision: no Handlebars
 * dependency).
 *
 * Only the text of a marked bullet is editable. A bullet's second and later
 * lines are indented two spaces with no leading `-`, and the marker always
 * ends the bullet's last line, so multi-line text round-trips (D5). Nested
 * lines (evidence, a question, the person's notes) and their own continuation
 * lines are indented further and are never read back.
 *
 * Two readers:
 *
 * - `parseProfileMarkdownEdits`/`applyMarkdownEdits`: the lenient, low-level
 *   id→text primitives (no approval, no strictness), kept for the F5
 *   round-trip property tests.
 * - `readMarkdownEdits(profile, markdown)`: the strict reader the store uses
 *   before every write (D9, P03 revision 2). It accepts a document only when
 *   everything except the text of marked bullets is exactly what this module
 *   renders for `profile`, so an edit it cannot apply (a removed or damaged
 *   marker, a new or moved bullet, a changed evidence line) is reported
 *   instead of being dropped silently.
 */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "22 September 2026 at 14:05 UTC": deterministic, whatever the machine's locale or ICU version. */
export function formatUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} at ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

interface RenderItem {
  readonly id: string;
  readonly text: string;
  /** Lines nested under the bullet: `**Evidence:**`, `**Question:**`, `**Your note:**`. Never read back. */
  readonly nested?: readonly string[];
}

/** `Claim.evidence` for a person to read: a source passage, the person's own statement, or a confirmation without detail. */
export function evidenceText(claim: Claim): string {
  if (isNoDetailStatement(claim.evidence)) return "you confirmed it without adding detail.";
  if (claim.evidence.kind === "statement") return `your own statement: "${claim.evidence.quote}"`;
  return `"${claim.evidence.quote}" (${claim.evidence.ref})`;
}

export interface ProfileMarkdownView {
  readonly confirmedClaims: readonly RenderItem[];
  readonly presentation: readonly RenderItem[];
  readonly needsDecisionClaims: readonly RenderItem[];
  readonly excludedClaims: readonly RenderItem[];
  readonly boundaries: readonly RenderItem[];
  readonly preferences: readonly RenderItem[];
}

export function toMarkdownView(profile: OnboardingProfile): ProfileMarkdownView {
  const notes = questionNotes(profile);
  return {
    confirmedClaims: profile.claims.filter((c) => c.status === "confirmed").map((c) => ({ id: c.id, text: c.text, nested: [`**Evidence:** ${evidenceText(c)}`] })),
    presentation: profile.presentation,
    needsDecisionClaims: profile.claims
      .filter((c) => c.status === "candidate" || c.status === "disputed")
      .map((c) => ({
        id: c.id,
        text: c.text,
        nested: [...(c.question ? [`**Question:** ${c.question}`] : []), ...(notes[c.id] ?? []).map((note) => `**Your note:** ${note.text}`)],
      })),
    excludedClaims: profile.claims.filter((c) => c.status === "excluded").map((c) => ({ id: c.id, text: c.text })),
    boundaries: profile.boundaries,
    preferences: profile.preferences,
  };
}

/**
 * A line that ends in something shaped like a marker (`` `[x]` ``), perhaps
 * followed by whitespace the reader's ID_MARKER would also accept (a
 * no-break space, say) and then backslashes. Every line ID_MARKER matches
 * matches this too.
 */
const MARKER_TAIL = /`\[[^\]\s`]+\]`\s*\\*$/;
/** The same, ending in at least one backslash: a line `escapeLine` escaped. */
const ESCAPED_MARKER_TAIL = /`\[[^\]\s`]+\]`\s*\\+$/;

/**
 * N6 (P03 revision 3): a text line that ends in a marker-shaped token would
 * read back as a marker and make the runner's own file unreadable (claim text
 * comes from a model reading a source, so a hostile source could plant one).
 * Such a line gets one more backslash when rendered, so it no longer ends in
 * a marker, and `unescapeLine` takes one off when reading, so every text
 * round-trips exactly: a line that needed no escape can't look escaped,
 * because ESCAPED_MARKER_TAIL only matches lines MARKER_TAIL matches.
 */
function escapeLine(line: string): string {
  return MARKER_TAIL.test(line) ? `${line}\\` : line;
}

function unescapeLine(line: string): string {
  return ESCAPED_MARKER_TAIL.test(line) ? line.slice(0, -1) : line;
}

/** A bullet whose text may contain `\n`: the first line carries `- `, later lines are indented two spaces, and the `` `[id]` `` marker ends the last line. */
function bulletLine(id: string, text: string): string {
  const lines = text.split("\n").map(escapeLine);
  const rendered = lines.map((line, index) => (index === 0 ? `- ${line}` : `  ${line}`));
  const last = rendered.length - 1;
  rendered[last] = `${rendered[last]} \`[${id}]\``;
  return rendered.join("\n");
}

/** A nested, never-read-back line under a bullet. VN8: its own later lines are indented four spaces, so a multi-line quote or question stays visibly inside its bullet. N6: escaped like a bullet's text, so an unmarked bullet's nested lines never read as a marker either. */
function nestedLine(text: string): string {
  return text
    .split("\n")
    .map(escapeLine)
    .map((line, index) => (index === 0 ? `  - ${line}` : `    ${line}`))
    .join("\n");
}

function bulletList(items: readonly RenderItem[], empty: string): string {
  if (items.length === 0) return `_${empty}_`;
  return items.map((item) => [bulletLine(item.id, item.text), ...(item.nested ?? []).map(nestedLine)].join("\n")).join("\n");
}

function withdrawalCause(withdrawal: WithdrawalView): string {
  const cause = withdrawal.cause;
  if (!cause) return "";
  if (cause.kind === "statement") return ` because the ${statementLabel(cause.statementKind)} ${quoteClaim(cause.statementText)} was added`;
  const change = { disputed: "got an open question", confirmed: "was confirmed", answered: "was answered", reopened: "changed and needs your answer" }[cause.change];
  return ` because the claim ${quoteClaim(cause.claimText)} ${change}`;
}

function statusLine(profile: OnboardingProfile): string {
  if (profile.approval) return `Approved as version ${profile.approval.version} on ${formatUtc(profile.approval.at)}.`;
  const withdrawal = currentWithdrawal(profile);
  if (withdrawal) {
    return `Not approved. Approval of version ${withdrawal.version} was withdrawn on ${formatUtc(withdrawal.at)}${withdrawalCause(withdrawal)}. Answer any open question, then approve again.`;
  }
  return "Not yet approved. Generation stays locked until every source is accounted for, no claim is left needing a decision, and you approve this profile.";
}

function revisionTarget(target: "claim" | StatementKind): string {
  return target === "claim" ? "claim" : statementLabel(target);
}

function proposedRevisionsSection(profile: OnboardingProfile): string[] {
  const pending = pendingRevisions(profile);
  if (pending.length === 0 || !profile.approval) return [];
  return [
    "## Proposed revisions",
    "",
    `Version ${profile.approval.version} stays in force until you accept or reject each of these on the Profile page.`,
    "",
    ...pending.map((revision) =>
      [`- To the ${revisionTarget(revision.target)} ${quoteClaim(revision.before)}, proposed ${formatUtc(revision.proposedAt)}:`, nestedLine(revision.after)].join("\n"),
    ),
    "",
  ];
}

export function renderProfileMarkdown(profile: OnboardingProfile): string {
  const view = toMarkdownView(profile);
  return [
    "# Career profile",
    "",
    statusLine(profile),
    "",
    "Edit the words of any line that ends in an id marker (the bracketed code in backticks), and keep the marker as it is. The runner saves your edit before its next change to your profile. Once the profile is approved, an edit becomes a proposed revision that you accept on the Profile page. Everything else in this file is rewritten from your profile.",
    "",
    "## Confirmed claims",
    "",
    bulletList(view.confirmedClaims, "None yet."),
    "",
    "## Presentation that can change",
    "",
    "Wording rules for how confirmed claims get presented: reorder, re-emphasise, rewrite a bullet's phrasing. Never a new fact and never a status change to any claim.",
    "",
    bulletList(view.presentation, "None recorded yet."),
    "",
    "## Needs a decision",
    "",
    bulletList(view.needsDecisionClaims, "Nothing waiting on you."),
    "",
    "## Excluded",
    "",
    "Kept here, visibly, so you can see what was left out. Never used in a generated document.",
    "",
    bulletList(view.excludedClaims, "None excluded."),
    "",
    "## Boundaries",
    "",
    "Rules generation must never cross: an invented metric, a changed date, a changed title, a changed credential.",
    "",
    bulletList(view.boundaries, "None recorded yet."),
    "",
    "## Preferences",
    "",
    bulletList(view.preferences, "None recorded yet."),
    "",
    ...proposedRevisionsSection(profile),
  ].join("\n");
}

const BULLET_START = /^-\s(.+)$/;
const CONTINUATION = /^ {2}(.+)$/;
const ID_MARKER = /\s`\[([^\]\s`]+)\]`\s*$/;

/**
 * Every `` `[id]` ``-marked bullet's id → its text (D5: multi-line, joined
 * back with `\n`), leniently: a bullet whose block never reaches a marker is
 * skipped, and nothing else in the document is checked. See
 * `readMarkdownEdits` for the strict reader the store uses.
 */
export function parseProfileMarkdownEdits(markdown: string): Map<string, string> {
  const edits = new Map<string, string>();
  for (const block of scan(markdown.split("\n")).blocks) {
    if (block.text) edits.set(block.id, block.text);
  }
  return edits;
}

/** Applies id-matched text edits to a list of statements, with no awareness of approval. */
export function updateStatements(items: readonly ProfileStatement[], edits: ReadonlyMap<string, string>): ProfileStatement[] {
  return items.map((item) => (edits.has(item.id) ? { ...item, text: edits.get(item.id)! } : item));
}

/** Applies every marked text edit in `markdown` to `profile`, leniently and with no awareness of approval. An id that matches nothing is ignored. */
export function applyMarkdownEdits(profile: OnboardingProfile, markdown: string): OnboardingProfile {
  const edits = parseProfileMarkdownEdits(markdown);
  if (edits.size === 0) return profile;
  return {
    ...profile,
    claims: profile.claims.map((claim) => (edits.has(claim.id) ? { ...claim, text: edits.get(claim.id)! } : claim)),
    boundaries: updateStatements(profile.boundaries, edits),
    preferences: updateStatements(profile.preferences, edits),
    presentation: updateStatements(profile.presentation, edits),
  };
}

interface Block {
  readonly id: string;
  readonly text: string;
  /** 1-based line of the bullet's first line. */
  readonly line: number;
}

interface SkeletonLine {
  readonly text: string;
  readonly line: number;
  /** Set when this skeleton line stands for a marked bullet. */
  readonly id?: string;
}

interface Scan {
  readonly blocks: readonly Block[];
  /** The document with each marked bullet's text replaced by its id, blank lines left out. */
  readonly skeleton: readonly SkeletonLine[];
}

/**
 * Splits a document into marked bullets and everything else. A bullet block
 * starts at a `- ` line; if that line ends with a marker the block is one
 * line, otherwise every following two-space-indented line belongs to it up to
 * the one that carries the marker. A block that never reaches a marker is not
 * a marked bullet: its first line stays in the skeleton as written.
 */
function scan(lines: readonly string[]): Scan {
  const blocks: Block[] = [];
  const skeleton: SkeletonLine[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const start = BULLET_START.exec(line);
    if (!start) {
      if (line.trim() !== "") skeleton.push({ text: line, line: i + 1 });
      i++;
      continue;
    }
    const collected = [start[1]!];
    let id: string | undefined;
    let next = i + 1;
    const firstMarker = ID_MARKER.exec(collected[0]!);
    if (firstMarker) {
      collected[0] = collected[0]!.slice(0, firstMarker.index);
      id = firstMarker[1];
    } else {
      for (; next < lines.length; next++) {
        const cont = CONTINUATION.exec(lines[next]!);
        if (!cont) break;
        const marker = ID_MARKER.exec(cont[1]!);
        if (marker) {
          collected.push(cont[1]!.slice(0, marker.index));
          id = marker[1];
          next++;
          break;
        }
        collected.push(cont[1]!);
      }
    }
    if (id) {
      blocks.push({ id, text: collected.map(unescapeLine).join("\n"), line: i + 1 });
      skeleton.push({ text: `- [${id}]`, line: i + 1, id });
      i = next;
    } else {
      skeleton.push({ text: line, line: i + 1 });
      i++;
    }
  }
  return { blocks, skeleton };
}

/** Line endings normalised and trailing spaces dropped, so an editor's own habits never read as an edit. */
function normaliseLines(markdown: string): string[] {
  return markdown
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""));
}

export type MarkdownRead = { readonly ok: true; readonly edits: ReadonlyMap<string, string> } | { readonly ok: false; readonly problem: string };

function editableItems(profile: OnboardingProfile): Map<string, { readonly label: string; readonly text: string }> {
  const items = new Map<string, { label: string; text: string }>();
  for (const claim of profile.claims) items.set(claim.id, { label: `the claim ${quoteClaim(claim.text)}`, text: claim.text });
  for (const [kind, list] of [
    ["boundary", profile.boundaries],
    ["preference", profile.preferences],
    ["presentation", profile.presentation],
  ] as const) {
    for (const statement of list) items.set(statement.id, { label: `the ${statementLabel(kind)} ${quoteClaim(statement.text)}`, text: statement.text });
  }
  return items;
}

/** Text echoed in a problem: one line, cut short, and with anything marker-shaped hidden, so a marker's id never reaches the page (J3). */
function clip(text: string, max = 80): string {
  const oneLine = text.trim().replace(/`\[[^\]`]*\]`/g, "`[…]`");
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * D9 (P03 revision 2): the strict reader. Returns each marked bullet's text
 * (every id in `profile`, exactly once), or the first problem that makes the
 * document unreadable:
 *
 * - a marker that matches nothing in the profile, or appears twice;
 * - a claim or statement whose marker is gone (its line was deleted, or the
 *   marker was changed);
 * - a marked line left empty;
 * - any other difference from what `renderProfileMarkdown(profile)` would
 *   write: a new bullet, a moved bullet, a changed heading, evidence line,
 *   question or note. Blank lines, line endings and trailing spaces are
 *   ignored.
 *
 * The problem is one plain sentence that starts with the line it is about
 * ("Line 14: …", revision 3, J3) and says what to do. A marker's id never
 * appears in it: a claim or statement is named by its words.
 */
export function readMarkdownEdits(profile: OnboardingProfile, markdown: string): MarkdownRead {
  const disk = scan(normaliseLines(markdown));
  const expected = scan(normaliseLines(renderProfileMarkdown(profile)));
  const items = editableItems(profile);
  const problem = (text: string): MarkdownRead => ({ ok: false, problem: text });

  const seen = new Map<string, number>();
  for (const block of disk.blocks) {
    const item = items.get(block.id);
    if (!item) return problem(`Line ${block.line}: the marker at the end of this line matches nothing in your profile. Put back the marker it had.`);
    const earlier = seen.get(block.id);
    if (earlier !== undefined) return problem(`Lines ${earlier} and ${block.line} both carry the marker for ${item.label}. Keep one of them.`);
    seen.set(block.id, block.line);
    if (!cleanText(block.text)) return problem(`Line ${block.line}: the words of ${item.label} are gone. To leave it out, exclude it on the Onboarding page.`);
  }
  for (const [id, item] of items) {
    if (!seen.has(id)) {
      const where = expected.blocks.find((block) => block.id === id)?.line;
      return problem(`Line ${where ?? "?"}: the line for ${item.label} is missing, or its marker was changed. Put it back as it was.`);
    }
  }

  const length = Math.max(disk.skeleton.length, expected.skeleton.length);
  for (let k = 0; k < length; k++) {
    const got = disk.skeleton[k];
    const want = expected.skeleton[k];
    if (got?.text === want?.text) continue;
    if (got?.id !== undefined && expected.skeleton.some((entry) => entry.id === got.id)) {
      return problem(`Line ${got.line}: the line for ${items.get(got.id)!.label} was moved. Put it back where it was.`);
    }
    if (got && BULLET_START.test(got.text)) {
      return problem(`Line ${got.line}: this line has no marker. New items can't be added in the file; add them on the Onboarding page.`);
    }
    if (got && want?.id !== undefined) return problem(`Line ${got.line}: the line for ${items.get(want.id)!.label} should come here. Put the lines back in order.`);
    if (got && want) return problem(`Line ${got.line}: only the words before a marker can be edited. This line should read “${clip(want.text)}”.`);
    if (got) return problem(`Line ${got.line}: this line was added. Only the words before a marker can be edited.`);
    if (want!.id !== undefined) return problem(`Line ${want!.line}: the line for ${items.get(want!.id)!.label} should come here. Put the lines back in order.`);
    return problem(`Line ${want!.line}: “${clip(want!.text)}” was removed. Put it back as it was.`);
  }

  return { ok: true, edits: new Map(disk.blocks.map((block) => [block.id, cleanText(block.text)])) };
}
