/* global document, window, HTMLElement, ResizeObserver, requestAnimationFrame, setTimeout, clearTimeout */
// The Onboarding page (P03): account for every career source, extract claims
// from what is provided, decide each claim, record preferences, and approve.
// It follows docs/spec/visuals/index.html's walkthrough against the real API
// (server/routes/onboarding.ts). Everything a person reads comes from the API
// already worded for them; this file never shows an id or an internal key.
//
// P03 revision 2 (UI critic round 2, D9-D13): one live region, the sticky
// "Last action" line (role="status"); a field error sits next to its control
// with aria-invalid and aria-describedby; #page-error (role="alert") is only
// for a page that failed to load. Every control has a stable id. Typed text
// lives in `drafts`, keyed by control id, so a re-render never empties a box,
// and a source's saved text is fetched raw when its panel opens.
//
// P03 revision 3 (UI critic round 3, J3-J6):
//  - J4: a render updates the page in place (`morphChildren`). An element is
//    matched by its id and updated, so the focused control is never replaced
//    and focus never passes through <body>; a node that has to go while it
//    holds focus is removed only once focus has moved to its planned target.
//    Handlers are properties (`onclick`), so a render can move them onto the
//    node already on the page.
//  - J4: each outcome is announced once. When an action moves focus to a
//    field whose description carries the problem or the question, the line
//    says only the short outcome ("Not saved.", "An answer is needed.").
//  - J3: while career-profile.md can't be read, a refused write shows the
//    server's one short line and no field error; Save & extract says the text
//    was saved and the extraction waits; Discard clears every field error.
//  - J5, J6.6: the line is one short sentence, clamped to two lines at 640 px
//    and below. A focused control is kept clear of it, and stays where it is
//    on screen when the page changes around it.
import { el, getJson, postJson } from "./runner.js";

const $ = (id) => document.getElementById(id);

// SOURCE_CATEGORIES in contract order, with store/profile-types.ts's labels
// (the browser can't import that module).
const SOURCES = [
  ["resume", "Resume"],
  ["previousCoverLetters", "Previous cover letters"],
  ["portfolioSite", "Portfolio / personal site"],
  ["repositories", "Repositories"],
  ["socialProfiles", "Social profiles (exported)"],
  ["workSamples", "Work samples"],
  ["targetRolesAndPreferences", "Target roles & preferences"],
];
const SOURCE_LABEL = Object.fromEntries(SOURCES);
const STATUS_LABELS = { provided: "Provided", unavailable: "Unavailable", not_applicable: "Not applicable" };
const KIND_LABELS = { fact: "Fact", metric: "Metric", title: "Title", date: "Date", credential: "Credential" };
const STATEMENTS = [
  { kind: "boundary", field: "boundaries", title: "Boundaries", one: "boundary", many: "boundaries", help: "A rule generation must never cross: an invented metric, a changed date, a changed title, a changed credential." },
  { kind: "preference", field: "preferences", title: "Preferences", one: "preference", many: "preferences", help: "How you want to be represented: tone, emphasis, anything you want considered." },
  { kind: "presentation", field: "presentation", title: "Presentation notes", one: "presentation note", many: "presentation notes", help: "A wording rule for how a confirmed claim is presented. Never a new fact, never a status change." },
];
const STATEMENT_LABEL = { boundary: "boundary", preference: "preference", presentation: "presentation note" };
const NO_DETAIL_REF_SUFFIX = "#answer-without-detail"; // store/profile-reducer.ts
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

let view = null; // the last GET /api/onboarding
const drafts = new Map(); // control id -> typed text
const savedText = new Map(); // category -> its pasted.txt text ("" when none); absent until fetched
const loadingText = new Set();
const openPanels = new Set();
const fieldErrors = new Map(); // control id -> message
const busy = new Set(); // ids of buttons whose request is in flight

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** A claim named by its words, on one line, cut short (store/profile-reducer.ts's quoteClaim). */
function quote(text, max = 60) {
  const line = text.replace(/\s+/g, " ").trim();
  return `“${line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line}”`;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Appends the children that exist: `Element.append(null)` would add the text "null". */
function add(parent, ...children) {
  for (const child of children) if (child) parent.append(child);
  return parent;
}

/** J6.11: career-profile.md's wording ("23 September 2026 at 16:16"), in local time, with the zone named. */
function formatWhen(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()} at ${pad(date.getHours())}:${pad(date.getMinutes())}${zone ? ` ${zone}` : ""}`;
}

/** J6.9: an evidence ref as a person reads it, "pasted.txt, line 2"; the full ref goes in `title`. */
function refLabel(ref) {
  const hash = ref.indexOf("#");
  const where = hash === -1 ? ref : ref.slice(0, hash);
  const fragment = hash === -1 ? "" : ref.slice(hash + 1);
  const file = where.split(/[\\/]/).filter(Boolean).pop() ?? where;
  const lines = /^L?(\d+)(?:-L?(\d+))?$/i.exec(fragment);
  if (lines) return lines[2] && lines[2] !== lines[1] ? `${file}, lines ${lines[1]}–${lines[2]}` : `${file}, line ${lines[1]}`;
  return fragment ? `${file}, “${fragment}”` : file;
}

// ---------------------------------------------------------------------------
// Feedback: the one live region (D12), kept clear of the focused control (J5)
// ---------------------------------------------------------------------------

const TAGS = { done: "Last action", refused: "Refused", working: "Working" };
const COMMAND = /npm run runner/g;

/**
 * P03.2 (round-4 UI critic, outside the round): at 640px and below, `.tag`
 * and `.text` sit on the same line with only a CSS margin between them --
 * invisible to assistive tech, which read "LAST ACTIONAn answer is needed."
 * with nothing separating the two. A colon in the tag's own text content
 * fixes that at every width, not just the one where it was visible.
 */
function tagText(tone) {
  return `${TAGS[tone]}:`;
}

/** The line's text, with a command a person types shown as code (J6.2). */
function lineParts(message) {
  const parts = [];
  let from = 0;
  for (const match of message.matchAll(COMMAND)) {
    parts.push(message.slice(from, match.index), el("code", { text: match[0] }));
    from = match.index + match[0].length;
  }
  parts.push(message.slice(from));
  return parts.filter((part) => part !== "");
}

/** Runs `change`, then scrolls so the focused control is where it was on screen: nothing shifts under it (J6.6). */
function keepInPlace(change) {
  const node = document.activeElement;
  const top = node && node !== document.body ? node.getBoundingClientRect().top : null;
  change();
  if (top === null || document.activeElement !== node) return;
  const moved = node.getBoundingClientRect().top - top;
  if (Math.abs(moved) >= 1) window.scrollBy(0, moved);
}

let working = null; // the timer that shows "Working" (J6.1)

function stopWorking() {
  if (working) clearTimeout(working);
  working = null;
}

/** Announces one outcome, once. The same text twice in a row is cleared first so it is announced again. */
function lastAction(message, tone = "done") {
  if (tone !== "working") stopWorking();
  const node = $("last-action");
  const tag = node.querySelector(".tag");
  const text = node.querySelector(".text");
  const apply = () =>
    keepInPlace(() => {
      node.className = `last-action ${tone}`;
      tag.textContent = tagText(tone);
      text.replaceChildren(...lineParts(message));
      text.title = message; // J5: the whole sentence for a pointer, where the line is clamped
    });
  if (text.textContent === message && tag.textContent === tagText(tone)) {
    keepInPlace(() => {
      text.textContent = "";
    });
    requestAnimationFrame(apply);
  } else {
    apply();
  }
}

/** J6.1: "Working" appears only once a request has taken about 300 ms, so a quick one never flashes it. */
function workingAfterDelay(message) {
  stopWorking();
  working = setTimeout(() => {
    working = null;
    lastAction(message, "working");
  }, 300);
}

/** Keeps --last-action-offset at the line's height, for scroll-padding-top (J5). */
function trackLastActionHeight() {
  const node = $("last-action");
  const update = () => document.documentElement.style.setProperty("--last-action-offset", `${Math.ceil(node.getBoundingClientRect().height) + 16}px`);
  if (typeof ResizeObserver === "function") new ResizeObserver(update).observe(node);
  update();
}

/** What to bring into view for a focused control: an answer box brings its whole question. */
function revealed(node) {
  return node.closest(".claim-question") ?? node;
}

/** J5: scrolls `node` fully clear of the sticky line: its top below the line, and its bottom in view when it fits. */
function keepClear(node) {
  if (!(node instanceof HTMLElement) || !node.isConnected) return;
  const top = $("last-action").getBoundingClientRect().bottom + 8;
  const rect = revealed(node).getBoundingClientRect();
  if (rect.top < top || rect.height > window.innerHeight - top) window.scrollBy(0, rect.top - top);
  else if (rect.bottom > window.innerHeight) window.scrollBy(0, rect.bottom - window.innerHeight + 8);
}

// Focus the keyboard (or the page) moves is checked once the browser has scrolled it into view. Focus
// from a pointer is left alone: the person is already looking at what they pressed.
let pointerAt = -Infinity;
document.addEventListener("pointerdown", () => (pointerAt = Date.now()), true);
document.addEventListener("focusin", (event) => {
  if (Date.now() - pointerAt < 500) return;
  const node = event.target;
  requestAnimationFrame(() => {
    if (document.activeElement === node) keepClear(node);
  });
});

// ---------------------------------------------------------------------------
// Rendering in place (J4)
// ---------------------------------------------------------------------------

const HANDLERS = ["onclick", "oninput", "onchange", "onsubmit"];
let doomed = []; // nodes a render took out while they held focus: removed once focus has moved on
let afterFocus = []; // hides that wait for the same reason

function holdsFocus(node) {
  const active = document.activeElement;
  return Boolean(active) && active !== document.body && node.contains(active);
}

function isKeyed(node) {
  return node.nodeType === 1 && node.id !== "";
}

/**
 * Brings `parent`'s children in line with `wanted`, keeping every node that
 * can stay: an element with an id is matched by its id, anything else by
 * position among nodes of the same kind, and a matched node is updated in
 * place. The child that holds focus is never moved; the rest are moved around
 * it. A child that has to go while it holds focus waits in `doomed`.
 */
function morphChildren(parent, wanted) {
  const current = [...parent.childNodes];
  const byId = new Map(current.filter(isKeyed).map((node) => [node.id, node]));
  const used = new Set();
  const next = wanted.map((node) => {
    const match = isKeyed(node)
      ? byId.get(node.id)
      : current.find((old) => !used.has(old) && !isKeyed(old) && old.nodeType === node.nodeType && old.nodeName === node.nodeName);
    if (!match || used.has(match) || match.nodeName !== node.nodeName) return node;
    used.add(match);
    morphNode(match, node);
    return match;
  });
  for (const old of current) {
    if (used.has(old)) continue;
    if (holdsFocus(old)) doomed.push(old);
    else old.remove();
  }
  const anchor = next.find(holdsFocus);
  if (anchor) {
    const at = next.indexOf(anchor);
    for (const node of next.slice(0, at)) parent.insertBefore(node, anchor);
    let previous = anchor;
    for (const node of next.slice(at + 1)) {
      if (previous.nextSibling !== node) parent.insertBefore(node, previous.nextSibling);
      previous = node;
    }
    return;
  }
  let ref = parent.firstChild;
  for (const node of next) {
    if (node === ref) ref = ref.nextSibling;
    else parent.insertBefore(node, ref);
  }
}

/** Makes `node` match `next`: attributes, handlers, a field's text (never the focused field's), and children. */
function morphNode(node, next) {
  if (node.nodeType !== 1) {
    if (node.nodeValue !== next.nodeValue) node.nodeValue = next.nodeValue;
    return;
  }
  for (const name of node.getAttributeNames()) if (!next.hasAttribute(name)) node.removeAttribute(name);
  for (const name of next.getAttributeNames()) {
    const value = next.getAttribute(name);
    if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  }
  for (const handler of HANDLERS) node[handler] = next[handler];
  const field = node.nodeName === "TEXTAREA" || (node.nodeName === "INPUT" && node.type !== "file");
  if (field && node !== document.activeElement && node.value !== next.value) node.value = next.value;
  if (node.nodeName !== "TEXTAREA") morphChildren(node, [...next.childNodes]);
}

/** Hides `node`, after focus has moved on if it is inside. */
function setHidden(node, hidden) {
  if (hidden && !node.hidden && holdsFocus(node)) afterFocus.push(() => (node.hidden = true));
  else node.hidden = hidden;
}

function findLive(id) {
  const live = (node) => !doomed.some((gone) => gone.contains(node));
  const node = $(id);
  if (!node || live(node)) return node;
  return [...document.querySelectorAll(`[id="${id}"]`)].find(live) ?? null;
}

/** Where focus goes when the focused node was taken out and there is no plan: its nearest focusable container. */
function fallbackTarget() {
  const gone = doomed.find(holdsFocus);
  for (let node = gone?.parentElement; node; node = node.parentElement) {
    if (node.hasAttribute("tabindex") && !doomed.includes(node)) return node;
  }
  return $("page-title");
}

/** After a render: focus the plan (never through <body>), then take out what held focus. */
function settleFocus(plan) {
  const planned = typeof plan === "function" ? plan() : plan;
  let target = planned ? findLive(planned) : null;
  if (!target && (doomed.some(holdsFocus) || afterFocus.length > 0)) target = fallbackTarget();
  if (target instanceof HTMLElement && target !== document.activeElement) {
    target.focus({ preventScroll: true });
    keepClear(target);
  }
  for (const node of doomed) node.remove();
  for (const hide of afterFocus) hide();
  doomed = [];
  afterFocus = [];
}

// ---------------------------------------------------------------------------
// Actions and field errors
// ---------------------------------------------------------------------------

function fieldErrorId(controlId) {
  return `${controlId}-error`;
}

function fieldError(controlId) {
  const message = fieldErrors.get(controlId);
  return message ? el("p", { className: "field-error", text: message, attrs: { id: fieldErrorId(controlId) } }) : null;
}

/**
 * A problem with what was typed or chosen: `detail` sits next to the field, and focus goes there (J4). When
 * the refused control already holds focus, though, focus never moves anywhere for a screen reader to read
 * `detail` from -- the line's own `outcome` ("Not uploaded.") was all that was announced. `focusedReason`,
 * when given, replaces `outcome` in the line for exactly that case: a short, line-length sentence (not
 * `detail`'s fuller, field-length one), e.g. "Not uploaded: only .txt or .md files can be uploaded." (P03.2,
 * round-4 UI critic polish 1).
 */
function refuseAt(controlId, detail, outcome, focusedReason) {
  fieldErrors.set(controlId, detail);
  const alreadyFocused = focusedReason && document.activeElement?.id === controlId;
  lastAction(alreadyFocused ? focusedReason : outcome, "refused");
  render(controlId);
}

/** A text box whose typed value survives re-renders (D13). */
function textControl(tag, id, saved, attrs = {}) {
  const { describedby, ...rest } = attrs;
  const control = el(tag, { attrs: { id, ...rest } });
  if (tag === "input") control.type = "text";
  control.value = drafts.has(id) ? drafts.get(id) : saved;
  const described = [describedby, fieldErrors.has(id) ? fieldErrorId(id) : null].filter(Boolean).join(" ");
  if (described) control.setAttribute("aria-describedby", described);
  if (fieldErrors.has(id)) control.setAttribute("aria-invalid", "true");
  control.oninput = (event) => {
    const target = event.currentTarget;
    drafts.set(id, target.value);
    // J6.3: an error clears as soon as its field changes.
    if (fieldErrors.delete(id)) {
      target.removeAttribute("aria-invalid");
      $(fieldErrorId(id))?.remove();
      if (describedby) target.setAttribute("aria-describedby", describedby);
      else target.removeAttribute("aria-describedby");
    }
  };
  return control;
}

/**
 * A button that runs one request at a time. `aria-disabled` (never the
 * disabled attribute) marks it busy, so it keeps focus and its place in the
 * tab order; `data-disabled` is its resting state.
 */
function actionButton(id, text, { secondary = false, disabled = false, type = "button", attrs = {} } = {}, work) {
  const button = el("button", { className: secondary ? "button secondary" : "button", text, attrs: { type, id, ...attrs } });
  button.dataset.disabled = String(disabled);
  button.setAttribute("aria-disabled", String(disabled || busy.has(id)));
  if (work) button.onclick = () => run(id, work);
  return button;
}

function setBusy(id, on) {
  const button = $(id);
  if (!button) return;
  button.setAttribute("aria-disabled", on || button.dataset.disabled === "true" ? "true" : "false");
}

/**
 * Runs an action. Every earlier field error goes first (J6.3). A refused
 * request is announced once; with `field` ({ id, outcome }), a problem with
 * what was typed sits next to that field instead and the line says only
 * `outcome`. While career-profile.md can't be read, a refusal is the server's
 * one short line, with no field error (J3).
 */
async function run(id, work, field) {
  const button = $(id);
  if (busy.has(id) || button?.dataset.disabled === "true") return;
  busy.add(id);
  setBusy(id, true);
  fieldErrors.clear();
  try {
    await work();
  } catch (error) {
    await refused(error, id, field);
  } finally {
    busy.delete(id);
    setBusy(id, false);
  }
}

async function refused(error, id, field) {
  const message = messageOf(error);
  await load().catch(() => undefined);
  if (field && !view?.markdownError) return refuseAt(field.id, message, field.outcome);
  lastAction(message, "refused");
  // Focus stays where the person acted (the button, or the field they pressed Enter in); only a lost focus goes to the button.
  render(document.activeElement && document.activeElement !== document.body ? undefined : id);
}

// ---------------------------------------------------------------------------
// Load and render
// ---------------------------------------------------------------------------

async function load() {
  view = await getJson("/api/onboarding");
  for (const category of openPanels) loadSavedText(category);
}

async function refresh(focusPlan) {
  await load();
  render(focusPlan);
}

/** Renders every section in place, then focuses the plan; the focused control stays where it was on screen. */
function render(focusPlan) {
  if (!view) return;
  const active = document.activeElement;
  const anchor = active && active !== document.body ? { node: active, top: active.getBoundingClientRect().top } : null;
  renderMarkdownProblem();
  renderWithdrawal();
  renderReadiness();
  renderSources();
  renderClaims();
  renderStatements();
  settleFocus(focusPlan);
  if (anchor && document.activeElement === anchor.node) {
    const moved = anchor.node.getBoundingClientRect().top - anchor.top;
    if (Math.abs(moved) >= 1) window.scrollBy(0, moved);
  }
}

// ---------------------------------------------------------------------------
// career-profile.md can't be read (D9, J3) and a withdrawn approval (D11)
// ---------------------------------------------------------------------------

function renderMarkdownProblem() {
  const problem = view.markdownError; // "Line 14: …": the server never puts a marker's id in it
  setHidden($("markdown-problem"), !problem);
  if (problem) $("markdown-problem-text").textContent = problem;
}

function withdrawalCause(withdrawal) {
  const cause = withdrawal.cause;
  if (!cause) return "the profile changed";
  if (cause.kind === "statement") return `a new ${STATEMENT_LABEL[cause.statementKind]} ${quote(cause.statementText)} was added`;
  const change = { disputed: "got an open question", confirmed: "was confirmed", answered: "was answered", reopened: "changed and needs your answer" }[cause.change];
  return `the claim ${quote(cause.claimText)} ${change}`;
}

/** The open question a withdrawal points to: the claim that caused it, else the first one open. */
function openQuestionClaim() {
  const open = view.claims.filter((claim) => claim.status === "disputed");
  const cause = view.withdrawal?.cause;
  return (cause?.kind === "claim" && open.find((claim) => claim.text === cause.claimText)) || open[0];
}

/** J6.8: moves focus to an open question's answer box, which carries the question in its description. */
function focusQuestion(claimId) {
  const target = $(`claim-answer-${claimId}`);
  if (!target) return;
  target.focus({ preventScroll: true });
  keepClear(target);
}

function renderWithdrawal() {
  const withdrawal = view.withdrawal;
  setHidden($("withdrawal"), !withdrawal);
  if (!withdrawal) return;
  $("withdrawal-title").textContent = `Approval of version ${withdrawal.version} was withdrawn`;
  const parts = [el("p", { text: `On ${formatWhen(withdrawal.at)}, ${withdrawalCause(withdrawal)}, so version ${withdrawal.version} is no longer in force and generation is locked.` })];
  if (withdrawal.applied.length > 0) {
    parts.push(
      el("p", { text: withdrawal.applied.length === 1 ? "Your proposed revision was applied to the draft, so it isn't lost:" : "Your proposed revisions were applied to the draft, so they aren't lost:" }),
      el("ul", { className: "applied-list" }, ...withdrawal.applied.map((item) => el("li", { text: `To the ${item.target === "claim" ? "claim" : STATEMENT_LABEL[item.target]}: ${quote(item.text, 90)}` }))),
    );
  }
  const claim = openQuestionClaim();
  if (claim) {
    const link = el("a", { text: `the open question on ${quote(claim.text, 50)}`, attrs: { href: `#question-${claim.id}`, id: "withdrawal-question-link" } });
    link.onclick = (event) => {
      event.preventDefault();
      focusQuestion(claim.id);
    };
    parts.push(el("p", { className: "withdrawal-next" }, "Answer ", link, ", then approve again."));
  } else {
    parts.push(el("p", { className: "withdrawal-next", text: "Review the change, then approve again." }));
  }
  morphChildren($("withdrawal-body"), parts);
}

$("markdown-discard").onclick = () =>
  run("markdown-discard", async () => {
    const outcome = await postJson("/api/onboarding/markdown/discard", {});
    fieldErrors.clear(); // J3: nothing refused while the file couldn't be read stays marked
    await load();
    lastAction(outcome.message, "done");
    render("page-title");
  });

// ---------------------------------------------------------------------------
// Readiness (issue 4) and approval
// ---------------------------------------------------------------------------

function claimsLine(r) {
  if (view.claims.length === 0) return { ok: false, text: "No claims yet" };
  if (r.pendingClaims.length > 0) return { ok: false, text: `${plural(r.pendingClaims.length, "claim")} still ${r.pendingClaims.length === 1 ? "needs" : "need"} a decision` };
  const confirmed = view.claims.filter((claim) => claim.status === "confirmed").length;
  const excluded = view.claims.length - confirmed;
  return { ok: true, text: `Every claim decided (${confirmed} confirmed${excluded > 0 ? `, ${excluded} excluded` : ""})` };
}

function approvalLine(r) {
  if (r.approved && view.approval) return { ok: true, text: `Profile approved (version ${view.approval.version})` };
  if (view.withdrawal) return { ok: false, text: `Approval of version ${view.withdrawal.version} was withdrawn` };
  return { ok: false, text: "Profile not approved yet" };
}

function renderReadiness() {
  const r = view.readiness;
  const lines = [
    r.sourcesAccounted
      ? { ok: true, text: "Every source accounted for" }
      : {
          ok: false,
          text:
            r.unaccounted.length <= 3
              ? `${plural(r.unaccounted.length, "source")} still unaccounted for (${r.unaccounted.map((c) => SOURCE_LABEL[c] ?? c).join(", ")})`
              : `${r.unaccounted.length} of ${SOURCES.length} sources still unaccounted for`,
        },
    claimsLine(r),
    approvalLine(r),
    { ok: r.ready, text: r.ready ? "Ready: generation unlocked" : "Not ready: generation locked", summary: true },
  ];
  morphChildren(
    $("readiness-lines"),
    lines.map((line) =>
      el(
        "li",
        { className: line.ok ? "readiness-line met" : "readiness-line" },
        el("span", { className: "m", text: line.ok ? "●" : "○", attrs: { "aria-hidden": "true" } }),
        // J6.5: the summary already says Ready or Not ready, so it gets no "Done:"/"Not yet:" of its own.
        line.summary ? null : el("span", { className: "visually-hidden", text: line.ok ? "Done: " : "Not yet: " }),
        line.summary ? el("strong", { text: line.text }) : el("span", { text: line.text }),
      ),
    ),
  );

  const button = $("approve-button");
  const disabled = !r.readyToApprove || r.approved;
  button.dataset.disabled = String(disabled);
  button.setAttribute("aria-disabled", String(disabled || busy.has("approve-button")));
  button.textContent = r.approved && view.approval ? `Approved (version ${view.approval.version})` : "Approve career profile";
  $("approve-help").textContent = r.approved
    ? `Version ${view.approval.version} is in force. Editing it on the Profile page proposes a revision; it changes nothing until you accept it.`
    : r.readyToApprove
      ? "Everything is decided. Approving records a new version and unlocks generation."
      : (r.reasons[0] ?? "");

  const pending = view.pendingRevisions ?? [];
  const hint = $("revision-hint");
  hint.hidden = pending.length === 0 || !view.approval;
  morphChildren(
    hint,
    hint.hidden
      ? []
      : [
          document.createTextNode(`${plural(pending.length, "proposed revision")} ${pending.length === 1 ? "is" : "are"} waiting. Version ${view.approval.version} stays in force until you accept or reject ${pending.length === 1 ? "it" : "them"} on the `),
          el("a", { text: "Profile page", attrs: { href: "/ui/profile" } }),
          document.createTextNode("."),
        ],
  );
}

$("approve-button").onclick = () =>
  run("approve-button", async () => {
    const outcome = await postJson("/api/onboarding/approve", {});
    await load();
    lastAction(outcome.message, outcome.ok ? "done" : "refused");
    render("approve-button");
  });

// ---------------------------------------------------------------------------
// Sources (issues 6, 7; D13)
// ---------------------------------------------------------------------------

function statusBadge(status) {
  // C5: only a source with no answer yet needs a decision (amber).
  return status ? el("span", { className: "badge ok", text: STATUS_LABELS[status] }) : el("span", { className: "badge warn", text: "Unaccounted" });
}

function openPanel(category) {
  openPanels.add(category);
  loadSavedText(category);
}

/** Fetches the text box's saved text, raw, the first time its panel opens (D13). */
function loadSavedText(category) {
  if (savedText.has(category) || loadingText.has(category)) return;
  loadingText.add(category);
  getJson(`/api/onboarding/sources/${category}/content`)
    .then((data) => savedText.set(category, typeof data?.text === "string" ? data.text : ""))
    .catch((error) => {
      savedText.set(category, "");
      fieldErrors.set(`source-text-${category}`, `The saved text couldn't be loaded (${messageOf(error)}), so the box starts empty. Saving replaces the saved text.`);
    })
    .finally(() => {
      loadingText.delete(category);
      render();
    });
}

function renderSources() {
  morphChildren(
    $("sources"),
    SOURCES.map(([category, label]) => sourceRow(category, label)),
  );
}

function sourceRow(category, label) {
  const entry = view.sources[category];
  const status = entry?.status;
  const nameId = `source-name-${category}`;
  const group = el("div", { className: "source-status-buttons", attrs: { role: "group", "aria-labelledby": nameId } });
  for (const [value, text] of Object.entries(STATUS_LABELS)) {
    const id = `source-status-${category}-${value}`;
    group.append(actionButton(id, text, { secondary: true, attrs: { "aria-pressed": String(status === value) } }, () => setSourceStatus(category, value, id)));
  }
  const row = el(
    "div",
    { className: "source-row", attrs: { id: `source-row-${category}` } },
    el("div", { className: "source-row-head" }, el("span", { className: "name", text: label, attrs: { id: nameId } }), statusBadge(status), group),
  );
  if (status === "provided") row.append(providedDetails(category, label));
  else if (status) row.append(reasonDetails(category, label, status, entry.note));
  return row;
}

async function setSourceStatus(category, value, buttonId) {
  const reasonId = `source-reason-${category}`;
  const current = view.sources[category];
  // A reason typed before or after choosing is kept (issue 7): the draft, else
  // the saved one when switching between Unavailable and Not applicable.
  const note = value === "provided" ? "" : (drafts.get(reasonId) ?? current?.note ?? "").trim();
  const outcome = await postJson(`/api/onboarding/sources/${category}`, note ? { status: value, note } : { status: value });
  drafts.delete(reasonId);
  if (value === "provided") openPanel(category);
  await load();
  lastAction(outcome.message, outcome.ok ? "done" : "refused");
  render(buttonId);
}

function reasonDetails(category, label, status, note) {
  const id = `source-reason-${category}`;
  const saveId = `source-reason-save-${category}`;
  const details = el("div", { className: "source-details" });
  if (note) details.append(el("p", { className: "source-reason-saved" }, el("span", { className: "muted", text: "Your reason: " }), el("span", { text: note })));
  const question = status === "unavailable" ? `Why is ${label} unavailable?` : `Why doesn't ${label} apply?`;
  add(
    details,
    el("label", { text: note ? `Change the reason for ${label} (optional)` : `${question} (optional)`, attrs: { for: id } }),
    textControl("textarea", id, "", { rows: "2", maxlength: "500" }),
    fieldError(id),
    el(
      "div",
      { className: "form-row" },
      actionButton(saveId, note ? "Save the new reason" : "Save reason", { secondary: true }, () => saveReason(category, label, status, saveId)),
    ),
  );
  return details;
}

async function saveReason(category, label, status, saveId) {
  const id = `source-reason-${category}`;
  const note = (drafts.get(id) ?? "").trim();
  if (!note) return refuseAt(id, `Type a reason first. It is optional: ${label} already counts as accounted for.`, "Not saved.");
  const outcome = await postJson(`/api/onboarding/sources/${category}`, { status, note });
  drafts.delete(id);
  await load();
  lastAction(outcome.message, outcome.ok ? "done" : "refused");
  render(saveId);
}

function providedDetails(category, label) {
  const uploads = view.uploads?.[category] ?? [];
  const extracted = view.claims.filter((claim) => claim.source === category).length;
  const open = openPanels.has(category);
  const toggleId = `source-toggle-${category}`;
  const panelId = `source-panel-${category}`;
  const details = el("div", { className: "source-details" });
  details.append(el("p", { className: "muted small", text: extracted > 0 ? `${plural(extracted, "claim")} extracted from ${label} so far.` : `No claims extracted from ${label} yet.` }));
  if (uploads.length > 0) {
    details.append(el("p", { className: "small upload-names" }, el("span", { className: "muted", text: uploads.length === 1 ? "Uploaded file: " : "Uploaded files: " }), el("span", { text: uploads.join(", ") })));
  }
  const toggle = el("button", {
    className: "button secondary",
    text: open ? "Hide the text box" : "Add or edit text",
    attrs: { type: "button", id: toggleId, "aria-expanded": String(open), "aria-controls": panelId },
  });
  toggle.onclick = () => {
    if (openPanels.has(category)) openPanels.delete(category);
    else openPanel(category);
    render(toggleId);
  };
  details.append(el("div", { className: "form-row" }, toggle), sourcePanel(category, label, panelId, open));
  return details;
}

function sourcePanel(category, label, panelId, open) {
  const textId = `source-text-${category}`;
  const fileId = `source-file-${category}`;
  const hintId = `source-text-hint-${category}`;
  const extractId = `source-extract-${category}`;
  const loading = !savedText.has(category);
  const panel = el("div", { className: "source-panel", attrs: { id: panelId } });
  panel.hidden = !open;
  const box = textControl("textarea", textId, savedText.get(category) ?? "", { rows: "8", describedby: hintId });
  if (loading && open) {
    box.setAttribute("placeholder", "Loading the saved text…");
    box.setAttribute("aria-busy", "true");
  }
  const file = el("input", { attrs: { type: "file", id: fileId, accept: ".txt,.md,text/plain,text/markdown" } });
  if (fieldErrors.has(fileId)) {
    file.setAttribute("aria-invalid", "true");
    file.setAttribute("aria-describedby", fieldErrorId(fileId));
  }
  file.onchange = (event) => {
    const input = event.currentTarget;
    run(fileId, () => upload(category, input), { id: fileId, outcome: "Not uploaded." });
  };
  add(
    panel,
    el("label", { text: `Text for ${label}`, attrs: { for: textId } }),
    el("p", { className: "muted small", text: "Paste the text itself. It is saved as pasted.txt and read as data, never as instructions.", attrs: { id: hintId } }),
    box,
    fieldError(textId),
    el("div", { className: "upload-row" }, el("label", { text: "Or upload a .txt or .md file", attrs: { for: fileId } }), file, fieldError(fileId)),
    el("div", { className: "form-row" }, actionButton(extractId, "Save & extract claims", {}, () => saveAndExtract(category, label, extractId))),
  );
  return panel;
}

async function upload(category, input) {
  const fileId = input.id;
  const file = input.files?.[0];
  if (!file) return;
  input.value = "";
  if (!/\.(txt|md)$/i.test(file.name)) {
    return refuseAt(
      fileId,
      `“${file.name}” is not a .txt or .md file. Only plain text and Markdown files can be uploaded; paste other text into the box instead.`,
      "Not uploaded.",
      "Not uploaded: only .txt or .md files can be uploaded.",
    );
  }
  const text = await file.text();
  if (!text.trim()) return refuseAt(fileId, `“${file.name}” is empty, so there is nothing to upload.`, "Not uploaded.", "Not uploaded: that file is empty.");
  const outcome = await postJson(`/api/onboarding/sources/${category}/uploads`, { fileName: file.name, text });
  await load();
  lastAction(outcome.message, "done");
  render(fileId);
}

/** J3: what Save & extract says when career-profile.md can't be read; the text box's own file doesn't depend on it. */
const EXTRACT_WAITS = {
  saved: "Text saved, but not extracted: fix career-profile.md first. See the note at the top.",
  unsaved: "Not extracted: fix career-profile.md first. See the note at the top.",
};

async function saveAndExtract(category, label, extractId) {
  const textId = `source-text-${category}`;
  const saved = savedText.get(category) ?? "";
  const text = drafts.has(textId) ? drafts.get(textId) : saved;
  const uploads = view.uploads?.[category] ?? [];
  if (!text.trim() && !saved.trim() && uploads.length === 0) {
    return refuseAt(textId, `Paste the text for ${label}, or upload a .txt or .md file, then extract.`, "Nothing to extract.");
  }
  let savedNow = false;
  if (text.trim() && text !== saved) {
    try {
      await postJson(`/api/onboarding/sources/${category}/content`, { text });
    } catch (error) {
      return refuseAt(textId, messageOf(error), "Not saved.");
    }
    savedText.set(category, text);
    savedNow = true;
  }
  drafts.delete(textId);
  workingAfterDelay(`Extracting claims from ${label}; this can take up to 90 seconds.`);
  let outcome;
  try {
    outcome = await postJson(`/api/onboarding/sources/${category}/extract`, {});
  } catch (error) {
    stopWorking();
    await load().catch(() => undefined);
    lastAction(view?.markdownError ? EXTRACT_WAITS[savedNow ? "saved" : "unsaved"] : messageOf(error), "refused");
    render(extractId);
    return;
  }
  stopWorking();
  await load();
  lastAction(outcome.message, outcome.ok ? "done" : "refused");
  render(extractId);
}

// ---------------------------------------------------------------------------
// Claims (issues 1, 5, 6; D10)
// ---------------------------------------------------------------------------

function claimBadge(status) {
  if (status === "confirmed") return el("span", { className: "badge ok", text: "confirmed" });
  if (status === "disputed") return el("span", { className: "badge warn", text: "question open" });
  if (status === "candidate") return el("span", { className: "badge warn", text: "candidate" });
  return el("span", { className: "badge fail", text: "excluded" });
}

function evidenceLine(claim) {
  const evidence = claim.evidence;
  if (evidence.kind === "statement" && evidence.ref.endsWith(NO_DETAIL_REF_SUFFIX)) return el("p", { className: "claim-evidence", text: "Evidence: you confirmed it without adding detail." });
  if (evidence.kind === "statement") return el("p", { className: "claim-evidence", text: `Evidence: your own statement, “${evidence.quote}”` });
  return el("p", { className: "claim-evidence" }, `Evidence: “${evidence.quote}” (`, el("span", { className: "ref", text: refLabel(evidence.ref), attrs: { title: evidence.ref } }), ")");
}

function isPending(claim) {
  return claim.status === "candidate" || claim.status === "disputed";
}

function firstAction(claim) {
  return claim.status === "candidate" ? `claim-confirm-${claim.id}` : `claim-answer-${claim.id}`;
}

/** Issue 1: after deciding a claim, its own next action, else the next undecided claim's first action, else its card. */
function claimFocusTarget(claimId) {
  const claims = view.claims;
  const index = claims.findIndex((claim) => claim.id === claimId);
  const self = claims[index];
  if (self && isPending(self)) return firstAction(self);
  const next = [...claims.slice(index + 1), ...claims.slice(0, Math.max(index, 0))].find(isPending);
  if (next) return firstAction(next);
  return self ? `claim-card-${self.id}` : "claims-title";
}

function renderClaims() {
  morphChildren(
    $("claims"),
    view.claims.length === 0
      ? [el("p", { className: "empty", text: "No claims yet. Mark a source provided, add its text, then extract claims from it." })]
      : [el("ul", { className: "claim-list" }, ...view.claims.map(claimCard))],
  );
}

function claimCard(claim) {
  const textId = `claim-text-${claim.id}`;
  const card = el(
    "li",
    { className: "claim", attrs: { id: `claim-card-${claim.id}`, tabindex: "-1" } },
    el(
      "div",
      { className: "claim-head" },
      el(
        "div",
        { className: "claim-body" },
        el("p", { className: "claim-text", text: claim.text, attrs: { id: textId } }),
        el("p", { className: "claim-meta", text: `${KIND_LABELS[claim.kind] ?? claim.kind} · from ${SOURCE_LABEL[claim.source] ?? "a source"}` }),
        evidenceLine(claim),
      ),
      claimBadge(claim.status),
    ),
  );
  if (claim.status === "candidate") {
    card.append(
      el(
        "div",
        { className: "claim-actions" },
        actionButton(`claim-confirm-${claim.id}`, "Confirm", { attrs: { "aria-describedby": textId } }, () => decide(claim.id, "confirmed")),
        actionButton(`claim-exclude-${claim.id}`, "Exclude", { secondary: true, attrs: { "aria-describedby": textId } }, () => decide(claim.id, "excluded")),
      ),
    );
  }
  if (claim.status === "disputed") card.append(questionBlock(claim, textId));
  return card;
}

function questionBlock(claim, textId) {
  const questionId = `claim-question-${claim.id}`;
  const reasonId = `claim-reason-${claim.id}`;
  const answerId = `claim-answer-${claim.id}`;
  const reason = view.questionReasons?.[claim.id]; // J6.4: "it's a metric claim", or "it says “Led”"
  const notes = view.notes?.[claim.id] ?? [];
  const block = el(
    "div",
    { className: "claim-question", attrs: { id: `question-${claim.id}` } },
    el(
      "p",
      { className: "notice decision" },
      el("strong", { text: "Question: " }),
      el("span", { text: claim.question ?? "This claim needs your answer before it can be confirmed.", attrs: { id: questionId } }),
      reason ? el("span", { className: "question-reason", text: ` Asked because ${reason}.`, attrs: { id: reasonId } }) : null,
    ),
  );
  if (notes.length > 0) {
    // D10: a reply that chose neither option, kept as a note; the question stays open.
    block.append(
      el("p", {
        className: "small muted notes-title",
        text: notes.length === 1 ? "Your earlier reply, kept as a note. It didn't confirm or exclude the claim:" : "Your earlier replies, kept as notes. They didn't confirm or exclude the claim:",
      }),
      el("ul", { className: "question-notes" }, ...notes.map((note) => el("li", {}, el("span", { text: `“${note.text}”` }), el("span", { className: "muted", text: ` · ${formatWhen(note.at)}` })))),
    );
  }
  add(
    block,
    el("label", { text: "Your answer (optional): a ticket, a dashboard, how you know it", attrs: { for: answerId } }),
    // J4: the answer box's description is the question and why it is asked, so the line need only say an answer is needed.
    textControl("textarea", answerId, "", { rows: "3", maxlength: "2000", describedby: reason ? `${questionId} ${reasonId}` : questionId }),
    fieldError(answerId),
    el(
      "div",
      { className: "claim-actions" },
      actionButton(`claim-yes-${claim.id}`, "Yes, I have evidence", { attrs: { "aria-describedby": `${textId} ${questionId}` } }, () => answer(claim.id, true)),
      actionButton(`claim-no-${claim.id}`, "No, exclude it", { secondary: true, attrs: { "aria-describedby": `${textId} ${questionId}` } }, () => answer(claim.id, false)),
    ),
  );
  return block;
}

async function decide(claimId, decision) {
  const outcome = await postJson(`/api/onboarding/claims/${claimId}/decide`, { decision });
  await load();
  // J4: a question opened. Focus goes to its answer box, whose description carries the question and why; the line says only that.
  const opened = outcome.ok && decision === "confirmed" && view.claims.find((claim) => claim.id === claimId)?.status === "disputed";
  lastAction(opened ? "An answer is needed." : outcome.message, outcome.ok ? "done" : "refused");
  render(() => claimFocusTarget(claimId));
}

async function answer(claimId, hasEvidence) {
  const answerId = `claim-answer-${claimId}`;
  const statement = (drafts.get(answerId) ?? "").trim();
  const outcome = await postJson(`/api/onboarding/claims/${claimId}/answer`, hasEvidence && statement ? { hasEvidence, statement } : { hasEvidence });
  if (outcome.ok) drafts.delete(answerId);
  await load();
  lastAction(outcome.message, outcome.ok ? "done" : "refused");
  render(() => claimFocusTarget(claimId));
}

// ---------------------------------------------------------------------------
// Boundaries, preferences, presentation notes (Enter adds)
// ---------------------------------------------------------------------------

function renderStatements() {
  morphChildren($("statements"), STATEMENTS.map(statementForm));
}

function statementForm(spec) {
  const inputId = `statement-input-${spec.kind}`;
  const helpId = `statement-help-${spec.kind}`;
  const addId = `statement-add-${spec.kind}`;
  const items = view[spec.field] ?? [];
  const form = el("form", { className: "statement-kind", attrs: { id: `statement-form-${spec.kind}`, novalidate: "" } });
  add(
    form,
    el("h3", { text: spec.title }),
    el("p", { className: "muted small", text: spec.help, attrs: { id: helpId } }),
    items.length > 0 ? el("ul", { className: "statement-list" }, ...items.map((item) => el("li", { text: item.text }))) : el("p", { className: "empty", text: `No ${spec.many} recorded yet.` }),
    el("label", { text: `Add a ${spec.one}`, attrs: { for: inputId } }),
    el("div", { className: "form-row" }, textControl("input", inputId, "", { maxlength: "600", describedby: helpId }), actionButton(addId, "Add", { secondary: true, type: "submit" })),
    fieldError(inputId),
  );
  form.onsubmit = (event) => {
    event.preventDefault();
    run(addId, () => addStatement(spec, inputId), { id: inputId, outcome: "Not added." });
  };
  return form;
}

async function addStatement(spec, inputId) {
  const text = (drafts.get(inputId) ?? "").trim();
  if (!text) return refuseAt(inputId, `Type a ${spec.one} first, then add it.`, "Not added.", `Not added: type a ${spec.one} first.`);
  const outcome = await postJson(`/api/onboarding/statements/${spec.kind}`, { text });
  if (outcome.ok) {
    drafts.delete(inputId);
    const input = $(inputId);
    if (input) input.value = ""; // a render never rewrites the focused field's text, so it is cleared here
  }
  await load();
  lastAction(outcome.message, outcome.ok ? "done" : "refused");
  render(inputId);
}

// ---------------------------------------------------------------------------

trackLastActionHeight();
refresh()
  .then(() => {
    // J6.8: the Profile page links an open question as /ui/onboarding#question-<claim id>.
    const linked = /^#question-(.+)$/.exec(window.location.hash);
    if (linked) focusQuestion(linked[1]);
  })
  .catch((error) => {
    const node = $("page-error");
    node.textContent = `The onboarding page couldn't load: ${messageOf(error)} Reload the page to try again.`;
    node.hidden = false;
  });
