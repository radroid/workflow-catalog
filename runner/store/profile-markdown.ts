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
 * → edit one claim's text → parse → render equals expected"), including
 * multi-line text: a bullet's second and later lines are indented two
 * spaces with no leading `-`, and the `` `[id]` `` marker always ends the
 * last physical line of the bullet, so a claim/statement whose text itself
 * contains a newline still round-trips (an earlier single-line-only regex
 * lost everything before the last `\n` — see the P03 revision-1 report). A
 * line's `` `[id]` `` marker is section-agnostic: `parseProfileMarkdownEdits`
 * reads every marked bullet in the document into one id→text map, and
 * `applyMarkdownEdits` updates whichever claim, boundary, preference, or
 * presentation statement in the profile carries that id, with no awareness
 * of approval state — it is the low-level rendering/parsing primitive
 * (this module owns no persistence and calls the reducer for nothing).
 * `store/profile.ts`'s `ProfileStore.applyMarkdownEdit`/`reconcileMarkdownFile`
 * (singular "Edit") are the layer that actually understands approval: they
 * use `parseProfileMarkdownEdits` to find what changed, but route a
 * confirmed claim or a boundary/preference/presentation statement through
 * the reducer's `editClaimText`/`editStatementText` actions instead of this
 * file's `applyMarkdownEdits`, so editing an approved profile's fact
 * proposes a revision rather than overwriting it outright (F5, "after
 * approval, edits become revisions with an explicit accept"). Structural
 * edits (adding/removing a bullet, moving something between sections) are
 * not round-tripped either way — the local UI is the supported way to
 * change status, approve, or answer a question.
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

/** A bullet whose text may itself contain `\n`: the first line carries the leading `- `, every later line is indented two spaces with no `-`, and the `` `[id]` `` marker always ends the last physical line — never the first, when there is more than one. */
function bulletLine(id: string, text: string): string {
  const lines = text.split("\n");
  const rendered = lines.map((line, index) => (index === 0 ? `- ${line}` : `  ${line}`));
  const last = rendered.length - 1;
  rendered[last] = `${rendered[last]} \`[${id}]\``;
  return rendered.join("\n");
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
      bulletList(view.confirmedClaims, "None yet."),
      "",
      "## Presentation that can change",
      "",
      "Wording rules for how confirmed claims get presented — reorder, re-emphasise, rewrite a bullet's phrasing. Never a new fact and never a status change to any claim.",
      "",
      bulletList(view.presentation, "None recorded yet."),
      "",
      "## Needs a decision",
      "",
      bulletList(view.needsDecisionClaims, "Nothing waiting on you.", (item) => (item.question ? `\n  - **Question:** ${item.question}` : "")),
      "",
      "## Excluded",
      "",
      "Kept here, visibly, so you can see what was left out and why — never used in a generated document.",
      "",
      bulletList(view.excludedClaims, "None excluded."),
      "",
      "## Boundaries",
      "",
      "Rules generation must never cross — an invented metric, a changed date, a changed title, a changed credential.",
      "",
      bulletList(view.boundaries, "None recorded yet."),
      "",
      "## Preferences",
      "",
      bulletList(view.preferences, "None recorded yet."),
      "",
    ].join("\n")
  );
}

const BULLET_START = /^-\s(.+)$/;
const CONTINUATION = /^ {2}(.+)$/;
const ID_MARKER = /\s`\[([^\]\s`]+)\]`\s*$/;

/**
 * Every `` `[id]` ``-marked bullet's id → its current text (D5: multi-line,
 * joined back with `\n`), read from a `career-profile.md` document.
 *
 * A bullet block starts at a `- ` line. If that first line itself ends with
 * the id marker, the bullet is one line and the scan stops there (this is
 * also why a nested, unmarked line like "Needs a decision"'s `` - **Question:**
 * `` never gets folded into the preceding claim's text: the claim's own
 * line already carried the marker, so its block ends before that nested
 * line is ever reached). Otherwise, every following two-space-indented,
 * non-empty line is a continuation of the same bullet's text, up to and
 * including whichever one finally carries the marker; a continuation block
 * that never reaches a marker (blank line, dedent, or end of file first)
 * is dropped rather than guessed at.
 */
export function parseProfileMarkdownEdits(markdown: string): Map<string, string> {
  const edits = new Map<string, string>();
  const lines = markdown.split("\n");
  let i = 0;
  while (i < lines.length) {
    const start = lines[i]!.match(BULLET_START);
    if (!start) {
      i++;
      continue;
    }
    const collected = [start[1]!];
    let id: string | undefined;
    const firstMarker = collected[0]!.match(ID_MARKER);
    if (firstMarker) {
      collected[0] = collected[0]!.slice(0, firstMarker.index);
      id = firstMarker[1];
      i++;
    } else {
      let j = i + 1;
      for (; j < lines.length; j++) {
        const cont = lines[j]!.match(CONTINUATION);
        if (!cont) break;
        const marker = cont[1]!.match(ID_MARKER);
        if (marker) {
          collected.push(cont[1]!.slice(0, marker.index));
          id = marker[1];
          j++;
          break;
        }
        collected.push(cont[1]!);
      }
      i = j;
    }
    if (id) {
      const text = collected.join("\n");
      if (text) edits.set(id, text);
    }
  }
  return edits;
}

/** Applies id-matched text edits to a list of boundary/preference/presentation statements, with no awareness of approval — used by `applyMarkdownEdits` below. `store/profile.ts`'s `ProfileStore` never calls this: it routes every statement edit through the reducer's `editStatementText` action instead (approval-aware), even though that action's own not-yet-approved branch ends up doing exactly the same map-by-id update this function does. */
export function updateStatements(items: readonly ProfileStatement[], edits: ReadonlyMap<string, string>): ProfileStatement[] {
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
