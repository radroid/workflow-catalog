/* global document, window, HTMLElement, ResizeObserver, requestAnimationFrame */
// The Profile page (P03): approval status, pending revisions, and
// career-profile.md's editable text. store/profile-markdown.ts renders and
// reads the file; this page is a thin client over server/routes/onboarding.ts,
// which also decodes every revision record for it (pendingRevisions,
// withdrawal), so nothing here parses a stored summary.
//
// P03 revision 2 (UI critic round 2, D9, D11, D12): one live region (the
// sticky "Last action" line); focus moves to the next revision's Accept, else
// the revisions heading, after a decision; Accept and Reject are never offered
// while the profile is unapproved; a withdrawn approval is explained; the
// editor keeps unsaved text across refreshes and sends the hash of the text it
// loaded, so a stale copy is refused rather than saved over a newer file.
//
// P03 revision 3 (UI critic round 3, J3-J6): the page renders in place, so
// the focused control is never replaced (J4); a refused save puts its reason
// on the editor and focuses it, and the line says only "Not saved." (J4, J6.6);
// while career-profile.md can't be read the editor shows the file as it is on
// disk, read-only, and "Save edits" isn't offered, and Discard keeps unsaved
// text in the box (J3); open questions are listed and linked (J6.8, J6.10).
//
// The helpers shared with onboarding.js are repeated here: both are plain
// browser modules and a shared asset would sit outside this packet's Owns.
import { el, getJson, postJson } from "./runner.js";

const $ = (id) => document.getElementById(id);

const STATEMENT_LABEL = { boundary: "boundary", preference: "preference", presentation: "presentation note" };
// SOURCE_CATEGORIES with store/profile-types.ts's labels, as onboarding.js has them (the browser can't import that module).
const SOURCE_LABEL = {
  resume: "Resume",
  previousCoverLetters: "Previous cover letters",
  portfolioSite: "Portfolio / personal site",
  repositories: "Repositories",
  socialProfiles: "Social profiles (exported)",
  workSamples: "Work samples",
  targetRolesAndPreferences: "Target roles & preferences",
};
const SOURCE_COUNT = Object.keys(SOURCE_LABEL).length;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

let view = null; // the last GET /api/onboarding
let loadedMarkdown = null; // the file text the editor was last filled with
let baseHash = null; // the hash of the render it was based on, sent with a save (D9)
let editorError = null; // why the last save was refused (J4: it sits on the editor, not in the line)
const busy = new Set();

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function quote(text, max = 60) {
  const line = text.replace(/\s+/g, " ").trim();
  return `“${line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line}”`;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
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

// ---------------------------------------------------------------------------
// Feedback (D12), kept clear of the focused control (J5, J6.6)
// ---------------------------------------------------------------------------

const TAGS = { done: "Last action", refused: "Refused", working: "Working" };
const COMMAND = /npm run runner/g;

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

/** Runs `change`, then scrolls so the focused control is where it was on screen. */
function keepInPlace(change) {
  const node = document.activeElement;
  const top = node && node !== document.body ? node.getBoundingClientRect().top : null;
  change();
  if (top === null || document.activeElement !== node) return;
  const moved = node.getBoundingClientRect().top - top;
  if (Math.abs(moved) >= 1) window.scrollBy(0, moved);
}

function lastAction(message, tone = "done") {
  const node = $("last-action");
  const tag = node.querySelector(".tag");
  const text = node.querySelector(".text");
  const apply = () =>
    keepInPlace(() => {
      node.className = `last-action ${tone}`;
      tag.textContent = TAGS[tone];
      text.replaceChildren(...lineParts(message));
      text.title = message;
    });
  if (text.textContent === message && tag.textContent === TAGS[tone]) {
    keepInPlace(() => {
      text.textContent = "";
    });
    requestAnimationFrame(apply);
  } else {
    apply();
  }
}

function trackLastActionHeight() {
  const node = $("last-action");
  const update = () => document.documentElement.style.setProperty("--last-action-offset", `${Math.ceil(node.getBoundingClientRect().height) + 16}px`);
  if (typeof ResizeObserver === "function") new ResizeObserver(update).observe(node);
  update();
}

/** J5: scrolls `node` fully clear of the sticky line: its top below the line, and its bottom in view when it fits. */
function keepClear(node) {
  if (!(node instanceof HTMLElement) || !node.isConnected) return;
  const top = $("last-action").getBoundingClientRect().bottom + 8;
  const rect = node.getBoundingClientRect();
  if (rect.top < top || rect.height > window.innerHeight - top) window.scrollBy(0, rect.top - top);
  else if (rect.bottom > window.innerHeight) window.scrollBy(0, rect.bottom - window.innerHeight + 8);
}

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
// Rendering in place (J4); see onboarding.js for the rules
// ---------------------------------------------------------------------------

const HANDLERS = ["onclick", "oninput", "onchange", "onsubmit"];
let doomed = [];
let afterFocus = [];

function holdsFocus(node) {
  const active = document.activeElement;
  return Boolean(active) && active !== document.body && node.contains(active);
}

function isKeyed(node) {
  return node.nodeType === 1 && node.id !== "";
}

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
  morphChildren(node, [...next.childNodes]);
}

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

function settleFocus(plan) {
  const planned = typeof plan === "function" ? plan() : plan;
  let target = planned ? findLive(planned) : null;
  if (!target && (doomed.some(holdsFocus) || afterFocus.length > 0)) target = $("page-title");
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
// Actions
// ---------------------------------------------------------------------------

function actionButton(id, text, { secondary = false, attrs = {} } = {}, work) {
  const button = el("button", { className: secondary ? "button secondary" : "button", text, attrs: { type: "button", id, ...attrs } });
  button.setAttribute("aria-disabled", String(busy.has(id)));
  if (work) button.onclick = () => run(id, work);
  return button;
}

function setBusy(id, on) {
  $(id)?.setAttribute("aria-disabled", on ? "true" : "false");
}

async function run(id, work) {
  if (busy.has(id)) return;
  busy.add(id);
  setBusy(id, true);
  try {
    await work();
  } catch (error) {
    await load().catch(() => undefined);
    lastAction(messageOf(error), "refused");
    render(document.activeElement && document.activeElement !== document.body ? undefined : id);
  } finally {
    busy.delete(id);
    setBusy(id, false);
  }
}

// ---------------------------------------------------------------------------
// Load and render
// ---------------------------------------------------------------------------

async function load() {
  view = await getJson("/api/onboarding");
}

async function refresh(focusPlan) {
  await load();
  render(focusPlan);
}

function render(focusPlan) {
  if (!view) return;
  const active = document.activeElement;
  const anchor = active && active !== document.body ? { node: active, top: active.getBoundingClientRect().top } : null;
  renderMarkdownProblem();
  renderWithdrawal();
  renderStatus();
  renderRevisions();
  renderEditor();
  settleFocus(focusPlan);
  if (anchor && document.activeElement === anchor.node) {
    const moved = anchor.node.getBoundingClientRect().top - anchor.top;
    if (Math.abs(moved) >= 1) window.scrollBy(0, moved);
  }
}

function renderMarkdownProblem() {
  const problem = view.markdownError; // "Line 14: …": the server never puts a marker's id in it (J3)
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

function openQuestions() {
  return (view.claims ?? []).filter((claim) => claim.status === "disputed");
}

/** J6.8: a link to an open question on the Onboarding page, which moves focus to its answer box. */
function questionLink(claim, text = quote(claim.text, 50)) {
  return el("a", { text, attrs: { href: `/ui/onboarding#question-${claim.id}` } });
}

/** D11: which version, what changed, which revision was applied, and what to do next. */
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
  const open = openQuestions();
  const cause = withdrawal.cause;
  const claim = (cause?.kind === "claim" && open.find((c) => c.text === cause.claimText)) || open[0];
  parts.push(
    claim
      ? el("p", { className: "withdrawal-next" }, "Answer ", questionLink(claim, `the open question on ${quote(claim.text, 50)}`), " on the Onboarding page, then approve again.")
      : el("p", { className: "withdrawal-next" }, "Review the change on the ", el("a", { text: "Onboarding page", attrs: { href: "/ui/onboarding" } }), ", then approve again."),
  );
  morphChildren($("withdrawal-body"), parts);
}

/** What is left before the profile can be approved, in the Onboarding page's readiness words; each open question is listed and linked (J6.10). */
function stepsLeft() {
  const r = view.readiness;
  const claims = view.claims ?? [];
  const open = openQuestions();
  const steps = [];
  if (!r.sourcesAccounted) {
    steps.push([
      r.unaccounted.length <= 3
        ? `${plural(r.unaccounted.length, "source")} still unaccounted for (${r.unaccounted.map((c) => SOURCE_LABEL[c] ?? c).join(", ")})`
        : `${r.unaccounted.length} of ${SOURCE_COUNT} sources still unaccounted for`,
    ]);
  }
  const undecided = r.pendingClaims.length - open.length;
  if (claims.length === 0) steps.push(["No claims yet: extract them from a provided source"]);
  else if (undecided > 0) steps.push([`${plural(undecided, "claim")} still ${undecided === 1 ? "needs" : "need"} a decision`]);
  for (const claim of open) steps.push(["Answer the question on ", questionLink(claim), `: ${claim.question ?? "it needs your answer"}`]);
  if (claims.length > 0 && r.pendingClaims.length === 0 && !r.hasConfirmedClaims) steps.push(["Every claim was excluded, so there is nothing to write from"]);
  return steps;
}

/** Where the profile stands, so each state reads differently here too (not only on the Onboarding page). */
function renderStatus() {
  const onboardingLink = () => el("a", { text: "Onboarding page", attrs: { href: "/ui/onboarding" } });
  let summary;
  let steps = [];
  if (view.approval) {
    summary = [`Approved as version ${view.approval.version} on ${formatWhen(view.approval.at)}. Generation is unlocked.`];
  } else if (view.readiness.readyToApprove) {
    summary = view.withdrawal
      ? [`Not approved: approval of version ${view.withdrawal.version} was withdrawn, as explained above. Everything is decided: approve again on the `, onboardingLink(), "."]
      : ["Not approved yet. Everything is decided: approve the profile on the ", onboardingLink(), " to unlock generation."];
  } else {
    steps = stepsLeft();
    const lead = view.withdrawal ? `Not approved: approval of version ${view.withdrawal.version} was withdrawn, as explained above.` : "Not approved yet, so generation is locked.";
    summary = steps.length > 0 ? [`${lead} Still to do on the `, onboardingLink(), ":"] : [`${lead} Approve the profile on the `, onboardingLink(), "."];
  }
  morphChildren($("status-summary"), summary.map((part) => (typeof part === "string" ? document.createTextNode(part) : part)));
  const list = $("status-steps");
  list.hidden = steps.length === 0;
  morphChildren(
    list,
    steps.map((parts) => el("li", {}, ...parts)),
  );
}

// ---------------------------------------------------------------------------
// Pending revisions (issue 8, D11)
// ---------------------------------------------------------------------------

function renderRevisions() {
  const pending = view.pendingRevisions ?? [];
  morphChildren(
    $("revisions"),
    pending.length === 0
      ? [el("p", { className: "empty", text: view.approval ? "No pending revisions." : "No pending revisions. Until the profile is approved, an edit to the file applies directly." })]
      : [el("ul", { className: "revision-list" }, ...pending.map(revisionCard))],
  );
}

function revisionCard(revision) {
  const what = revision.target === "claim" ? "claim" : STATEMENT_LABEL[revision.target];
  const card = el(
    "li",
    { className: "revision", attrs: { id: `revision-card-${revision.id}`, tabindex: "-1" } },
    el("p", { className: "revision-meta", text: `To the ${what}, proposed ${formatWhen(revision.proposedAt)}` }),
    el("p", { className: "revision-line" }, el("span", { className: "revision-label", text: "Now: " }), el("span", { className: "old", text: revision.before })),
    el("p", { className: "revision-line" }, el("span", { className: "revision-label", text: "Proposed: " }), el("span", { className: "new", text: revision.after })),
  );
  if (view.approval) {
    const name = `the revision to the ${what} ${quote(revision.before, 50)}`;
    card.append(
      el(
        "div",
        { className: "revision-actions" },
        actionButton(`revision-accept-${revision.id}`, "Accept", { attrs: { "aria-label": `Accept ${name}` } }, () => decideRevision(revision.id, "accept")),
        actionButton(`revision-reject-${revision.id}`, "Reject", { secondary: true, attrs: { "aria-label": `Reject ${name}` } }, () => decideRevision(revision.id, "reject")),
      ),
    );
  } else {
    card.append(el("p", { className: "muted small", text: "The profile isn't approved, so this revision has nothing to change yet." }));
  }
  return card;
}

/** Issue 1: the next revision's Accept, else the revisions heading. */
function revisionFocusTarget(decidedId, order) {
  const remaining = new Set((view.pendingRevisions ?? []).map((revision) => revision.id));
  if (remaining.has(decidedId) && view.approval) return `revision-accept-${decidedId}`;
  const index = order.indexOf(decidedId);
  const next = [...order.slice(index + 1), ...order.slice(0, Math.max(index, 0))].find((id) => remaining.has(id));
  return next && view.approval ? `revision-accept-${next}` : "revisions-title";
}

async function decideRevision(revisionId, action) {
  const order = (view.pendingRevisions ?? []).map((revision) => revision.id);
  const outcome = await postJson(`/api/onboarding/revisions/${revisionId}/${action}`, {});
  await load();
  lastAction(outcome.message, outcome.ok ? "done" : "refused");
  render(() => revisionFocusTarget(revisionId, order));
}

// ---------------------------------------------------------------------------
// The career-profile.md editor
// ---------------------------------------------------------------------------

function isDirty() {
  return loadedMarkdown !== null && $("markdown-editor").value !== loadedMarkdown;
}

/**
 * The editor shows the render of the profile, or, while career-profile.md
 * can't be read, the file as it is on disk, read-only, with no "Save edits"
 * (J3). Text typed and not saved is never replaced.
 */
function renderEditor() {
  const editor = $("markdown-editor");
  const unreadable = Boolean(view.markdownError);
  if (!isDirty()) {
    const text = unreadable ? (view.markdownOnDisk ?? view.markdown) : view.markdown;
    if (editor.value !== text) editor.value = text;
    loadedMarkdown = text;
    baseHash = unreadable ? null : view.markdownHash;
  }
  editor.readOnly = unreadable && !isDirty();
  $("markdown-editor-label").textContent = unreadable && !isDirty() ? "The file as it is on disk (read-only until the problem above is fixed)" : "The file's text";
  const error = $("markdown-editor-error");
  error.hidden = !editorError;
  error.textContent = editorError ?? "";
  if (editorError) {
    editor.setAttribute("aria-invalid", "true");
    editor.setAttribute("aria-describedby", "markdown-help markdown-editor-error");
  } else {
    editor.removeAttribute("aria-invalid");
    editor.setAttribute("aria-describedby", "markdown-help");
  }
  setHidden($("save-markdown"), unreadable);
  setHidden($("drop-markdown"), !isDirty());
}

$("markdown-editor").oninput = () => {
  if (editorError) {
    editorError = null; // J6.3: the reason goes once the text changes
    renderEditor();
  }
  $("drop-markdown").hidden = !isDirty();
};

$("save-markdown").onclick = () =>
  run("save-markdown", async () => {
    let outcome;
    try {
      outcome = await postJson("/api/onboarding/markdown", { markdown: $("markdown-editor").value, base: baseHash });
    } catch (error) {
      await load();
      if (view.markdownError) {
        // J3: the file itself can't be read. The note at the top says why; Save isn't offered until it is fixed.
        editorError = null;
        lastAction(messageOf(error), "refused");
        render("markdown-problem");
      } else {
        // J4: the reason sits on the editor, focus goes there, and the line says only the outcome.
        editorError = messageOf(error);
        lastAction("Not saved.", "refused");
        render("markdown-editor");
      }
      return;
    }
    editorError = null;
    loadedMarkdown = null; // show the file as saved
    await load();
    lastAction(outcome.message, "done");
    render("save-markdown");
  });

$("drop-markdown").onclick = () =>
  run("drop-markdown", async () => {
    loadedMarkdown = null;
    editorError = null;
    await load();
    lastAction("Your unsaved changes were dropped. The box shows the file as it is now.", "done");
    render("markdown-editor");
  });

$("markdown-discard").onclick = () =>
  run("markdown-discard", async () => {
    const outcome = await postJson("/api/onboarding/markdown/discard", {});
    editorError = null;
    // J3: text typed in the box stays. Its base is the render the discard restores, so it can still be saved.
    const kept = isDirty();
    if (!kept) loadedMarkdown = null;
    await load();
    lastAction(kept ? "File edits discarded; your unsaved text in the box is kept." : outcome.message, "done");
    render("page-title");
  });

trackLastActionHeight();
refresh().catch((error) => {
  const node = $("page-error");
  node.textContent = `The profile couldn't load: ${messageOf(error)} Reload the page to try again.`;
  node.hidden = false;
});
