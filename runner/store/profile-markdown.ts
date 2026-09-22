import type { OnboardingProfile, ProfileStatement } from "./profile-types.ts";

/**
 * `career-profile.md`: rendered from the JSON profile, and parsed back so an
 * edit to the Markdown round-trips into it (mvp-spec §3 F5). Mirrors
 * `packages/job-assistant/templates/career-profile.md.hbs`'s exact section
 * headings and the `` `[id]` `` marker convention documented there, hand-
 * written rather than run through Handlebars — `packages/job-assistant/test/templates.test.ts`
 * already notes "no Handlebars dependency added to actually render these"
 * (the P01 packet decision); this module is P03's renderer for the same
 * template contract, kept in the runner where the person's workspace lives.
 *
 * The round trip only ever recovers *text* edits (F5's accept test: "render
 * → edit one claim's text → parse → render equals expected"). A line's
 * `` `[id]` `` marker is section-agnostic: `parseProfileMarkdownEdits` reads
 * every marked line in the document into one id→text map, and
 * `applyMarkdownEdits` updates whichever claim, boundary, preference, or
 * presentation statement in the profile carries that id. Structural edits
 * (adding/removing a bullet, moving something between sections) are not
 * round-tripped — the local UI is the supported way to change status,
 * approve, or answer a question.
 */

interface RenderItem {
  readonly id: string;
  readonly text: string;
  /** Only `needsDecisionClaims` items carry one; rendered as a nested line, never editable via round-trip. */
  readonly question?: string;
}

export interface ProfileMarkdownView {
  readonly profileVersion: number | null;
  readonly approvedAt: string | null;
  readonly confirmedClaims: readonly RenderItem[];
  readonly presentation: readonly RenderItem[];
  readonly needsDecisionClaims: readonly RenderItem[];
  readonly excludedClaims: readonly RenderItem[];
  readonly boundaries: readonly RenderItem[];
  readonly preferences: readonly RenderItem[];
}

export function toMarkdownView(profile: OnboardingProfile): ProfileMarkdownView {
  return {
    profileVersion: profile.approval?.version ?? null,
    approvedAt: profile.approval?.at ?? null,
    confirmedClaims: profile.claims.filter((c) => c.status === "confirmed").map((c) => ({ id: c.id, text: c.text })),
    presentation: profile.presentation,
    needsDecisionClaims: profile.claims
      .filter((c) => c.status === "candidate" || c.status === "disputed")
      .map((c) => ({ id: c.id, text: c.text, question: c.question })),
    excludedClaims: profile.claims.filter((c) => c.status === "excluded").map((c) => ({ id: c.id, text: c.text })),
    boundaries: profile.boundaries,
    preferences: profile.preferences,
  };
}

function bulletLine(id: string, text: string): string {
  return `- ${text} \`[${id}]\``;
}

function bulletList(items: readonly RenderItem[], empty: string, extra?: (item: RenderItem) => string): string {
  if (items.length === 0) return `_${empty}_`;
  return items.map((item) => bulletLine(item.id, item.text) + (extra ? extra(item) : "")).join("\n");
}

export function renderProfileMarkdown(profile: OnboardingProfile): string {
  const view = toMarkdownView(profile);
  const status = view.profileVersion
    ? `Approved as version ${view.profileVersion} on ${view.approvedAt}.`
    : "Not yet approved — generation stays locked until every source is accounted for, no claim is left needing a decision, and you approve this profile.";

  return (
    [
      "# Career profile",
      "",
      status,
      "",
      "## Confirmed claims",
      "",
      bulletList(view.confirmedClaims, "None yet"),
      "",
      "## Presentation that can change",
      "",
      "Wording rules for how confirmed claims get presented — reorder, re-emphasise, rewrite a bullet's phrasing. Never a new fact and never a status change to any claim.",
      "",
      bulletList(view.presentation, "None recorded yet"),
      "",
      "## Needs a decision",
      "",
      bulletList(view.needsDecisionClaims, "Nothing waiting on you", (item) => (item.question ? `\n  - **Question:** ${item.question}` : "")),
      "",
      "## Excluded",
      "",
      "Kept here, visibly, so you can see what was left out and why — never used in a generated document.",
      "",
      bulletList(view.excludedClaims, "None excluded"),
      "",
      "## Boundaries",
      "",
      "Rules generation must never cross — an invented metric, a changed date, a changed title, a changed credential.",
      "",
      bulletList(view.boundaries, "None recorded yet"),
      "",
      "## Preferences",
      "",
      bulletList(view.preferences, "None recorded yet"),
      "",
    ].join("\n")
  );
}

const MARKED_LINE = /^-\s(.+?)\s`\[([^\]\s`]+)\]`\s*$/gm;

/** Every `` `[id]` ``-marked bullet line's id → its current text, read from a `career-profile.md` document. */
export function parseProfileMarkdownEdits(markdown: string): Map<string, string> {
  const edits = new Map<string, string>();
  for (const match of markdown.matchAll(MARKED_LINE)) {
    const [, text, id] = match;
    if (id && text !== undefined) edits.set(id, text);
  }
  return edits;
}

function updateStatements(items: readonly ProfileStatement[], edits: ReadonlyMap<string, string>): ProfileStatement[] {
  return items.map((item) => (edits.has(item.id) ? { ...item, text: edits.get(item.id)! } : item));
}

/** Applies every `` `[id]` ``-marked text edit in `markdown` back onto `profile`. IDs the document does not carry a marker for are left unchanged; an id in the document that matches no claim, boundary, preference, or presentation statement is ignored (a person cannot invent a new claim by editing the file). */
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
