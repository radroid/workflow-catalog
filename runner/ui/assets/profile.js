/* global document, HTMLElement, HTMLTextAreaElement, ResizeObserver, requestAnimationFrame */
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
// The helpers shared with onboarding.js are repeated here: both are plain
// browser modules and a shared asset would sit outside this packet's Owns.
import { el, formatTime, getJson, postJson } from "./runner.js";

const $ = (id) => document.getElementById(id);

const STATEMENT_LABEL = { boundary: "boundary", preference: "preference", presentation: "presentation note" };

let view = null; // the last GET /api/onboarding
let loadedMarkdown = null; // the file text the editor was last filled with
let baseHash = null; // its hash, sent with a save (D9)
const busy = new Set();

function quote(text, max = 60) {
  const line = text.replace(/\s+/g, " ").trim();
  return `“${line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line}”`;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Feedback (D12)
// ---------------------------------------------------------------------------

const TAGS = { done: "Last action", refused: "Refused", working: "Working" };

function lastAction(message, tone = "done") {
  const node = $("last-action");
  const tag = node.querySelector(".tag");
  const text = node.querySelector(".text");
  const apply = () => {
    node.className = `last-action ${tone}`;
    tag.textContent = TAGS[tone];
    text.textContent = message;
  };
  if (text.textContent === message && tag.textContent === TAGS[tone]) {
    text.textContent = "";
    requestAnimationFrame(apply);
  } else {
    apply();
  }
}

function trackLastActionHeight() {
  const node = $("last-action");
  const update = () => document.documentElement.style.setProperty("--last-action-offset", `${Math.ceil(node.getBoundingClientRect().height) + 16}px`);
  new ResizeObserver(update).observe(node);
  update();
}

function setEditorError(message) {
  const editor = $("markdown-editor");
  const node = $("markdown-editor-error");
  node.hidden = !message;
  node.textContent = message ?? "";
  if (message) {
    editor.setAttribute("aria-invalid", "true");
    editor.setAttribute("aria-describedby", "markdown-help markdown-editor-error");
  } else {
    editor.removeAttribute("aria-invalid");
    editor.setAttribute("aria-describedby", "markdown-help");
  }
}

// ---------------------------------------------------------------------------
// Actions and focus
// ---------------------------------------------------------------------------

function actionButton(id, text, { secondary = false, attrs = {} } = {}, work) {
  const button = el("button", { className: secondary ? "button secondary" : "button", text, attrs: { type: "button", id, ...attrs } });
  button.setAttribute("aria-disabled", String(busy.has(id)));
  if (work) button.addEventListener("click", () => run(id, work));
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
    lastAction(messageOf(error), "refused");
    await refresh(id).catch(() => render(id));
  } finally {
    busy.delete(id);
    setBusy(id, false);
  }
}

function captureFocus() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !active.id) return null;
  return { id: active.id, selection: active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] : null };
}

function restoreFocus(plan, saved) {
  const planned = typeof plan === "function" ? plan() : plan;
  const target = (planned && $(planned)) || (saved && $(saved.id));
  if (!(target instanceof HTMLElement)) return;
  if (document.activeElement !== target) target.focus();
  if (saved?.selection && target.id === saved.id && typeof target.setSelectionRange === "function") target.setSelectionRange(...saved.selection);
}

// ---------------------------------------------------------------------------
// Load and render
// ---------------------------------------------------------------------------

async function refresh(focusPlan) {
  view = await getJson("/api/onboarding");
  render(focusPlan);
}

function render(focusPlan) {
  if (!view) return;
  const saved = captureFocus();
  renderMarkdownProblem();
  renderWithdrawal();
  renderStatus();
  renderRevisions();
  renderEditor();
  restoreFocus(focusPlan, saved);
}

const UNREADABLE_PREFIX = "career-profile.md has an edit the runner can't read. ";

function renderMarkdownProblem() {
  const problem = view.markdownError;
  $("markdown-problem").hidden = !problem;
  $("markdown-problem-text").textContent = problem ? problem.replace(UNREADABLE_PREFIX, "") : "";
}

function withdrawalCause(withdrawal) {
  const cause = withdrawal.cause;
  if (!cause) return "the profile changed";
  if (cause.kind === "statement") return `a new ${STATEMENT_LABEL[cause.statementKind]} ${quote(cause.statementText)} was added`;
  const change = { disputed: "got an open question", confirmed: "was confirmed", answered: "was answered", reopened: "changed and needs your answer" }[cause.change];
  return `the claim ${quote(cause.claimText)} ${change}`;
}

/** D11: which version, what changed, which revision was applied, and what to do next. */
function renderWithdrawal() {
  const withdrawal = view.withdrawal;
  $("withdrawal").hidden = !withdrawal;
  if (!withdrawal) return;
  $("withdrawal-title").textContent = `Approval of version ${withdrawal.version} was withdrawn`;
  const parts = [el("p", { text: `On ${formatTime(withdrawal.at)}, ${withdrawalCause(withdrawal)}, so version ${withdrawal.version} is no longer in force and generation is locked.` })];
  if (withdrawal.applied.length > 0) {
    parts.push(
      el("p", { text: withdrawal.applied.length === 1 ? "Your proposed revision was applied to the draft, so it isn't lost:" : "Your proposed revisions were applied to the draft, so they aren't lost:" }),
      el("ul", { className: "applied-list" }, ...withdrawal.applied.map((item) => el("li", { text: `To the ${item.target === "claim" ? "claim" : STATEMENT_LABEL[item.target]}: ${quote(item.text, 90)}` }))),
    );
  }
  const open = view.readiness.pendingClaims.length > 0;
  parts.push(
    el(
      "p",
      { className: "withdrawal-next" },
      document.createTextNode(open ? "Answer the open question on the " : "Review the change on the "),
      el("a", { text: "Onboarding page", attrs: { href: "/ui/onboarding" } }),
      document.createTextNode(", then approve again."),
    ),
  );
  $("withdrawal-body").replaceChildren(...parts);
}

function renderStatus() {
  const node = $("status-summary");
  if (view.approval) {
    node.replaceChildren(`Approved as version ${view.approval.version} on ${formatTime(view.approval.at)}. Generation is unlocked.`);
  } else if (view.withdrawal) {
    node.replaceChildren(`Not approved: approval of version ${view.withdrawal.version} was withdrawn, as explained above. Generation is locked.`);
  } else {
    node.replaceChildren(
      "Not approved yet. Generation stays locked until every source is accounted for, every claim is decided, and you approve the profile on the ",
      el("a", { text: "Onboarding page", attrs: { href: "/ui/onboarding" } }),
      ".",
    );
  }
}

// ---------------------------------------------------------------------------
// Pending revisions (issue 8, D11)
// ---------------------------------------------------------------------------

function renderRevisions() {
  const pending = view.pendingRevisions ?? [];
  const container = $("revisions");
  if (pending.length === 0) {
    container.replaceChildren(
      el("p", { className: "empty", text: view.approval ? "No pending revisions." : "No pending revisions. Until the profile is approved, an edit to the file applies directly." }),
    );
    return;
  }
  container.replaceChildren(el("ul", { className: "revision-list" }, ...pending.map(revisionCard)));
}

function revisionCard(revision) {
  const what = revision.target === "claim" ? "claim" : STATEMENT_LABEL[revision.target];
  const card = el(
    "li",
    { className: "revision", attrs: { id: `revision-card-${revision.id}`, tabindex: "-1" } },
    el("p", { className: "revision-meta", text: `To the ${what}, proposed ${formatTime(revision.proposedAt)}` }),
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
  lastAction(outcome.message, outcome.ok ? "done" : "refused");
  await refresh(() => revisionFocusTarget(revisionId, order));
}

// ---------------------------------------------------------------------------
// The career-profile.md editor
// ---------------------------------------------------------------------------

function isDirty() {
  return loadedMarkdown !== null && $("markdown-editor").value !== loadedMarkdown;
}

function renderEditor() {
  if (!isDirty()) {
    $("markdown-editor").value = view.markdown;
    loadedMarkdown = view.markdown;
    baseHash = view.markdownHash;
  }
  $("drop-markdown").hidden = !isDirty();
}

$("markdown-editor").addEventListener("input", () => {
  if (!$("markdown-editor-error").hidden) setEditorError(null);
  $("drop-markdown").hidden = !isDirty();
});

$("save-markdown").addEventListener("click", () =>
  run("save-markdown", async () => {
    try {
      const outcome = await postJson("/api/onboarding/markdown", { markdown: $("markdown-editor").value, base: baseHash });
      setEditorError(null);
      loadedMarkdown = null; // show the file as saved
      lastAction(outcome.message, "done");
    } catch (error) {
      setEditorError(messageOf(error));
      lastAction(messageOf(error), "refused");
    }
    await refresh("save-markdown");
  }),
);

$("drop-markdown").addEventListener("click", () =>
  run("drop-markdown", async () => {
    loadedMarkdown = null;
    setEditorError(null);
    await refresh("markdown-editor");
    lastAction("Your unsaved changes were dropped. The box shows the file as it is now.", "done");
  }),
);

$("markdown-discard").addEventListener("click", () =>
  run("markdown-discard", async () => {
    const outcome = await postJson("/api/onboarding/markdown/discard", {});
    loadedMarkdown = null;
    setEditorError(null);
    lastAction(outcome.message, "done");
    await refresh("page-title");
  }),
);

trackLastActionHeight();
refresh().catch((error) => {
  const node = $("page-error");
  node.textContent = `The profile couldn't load: ${messageOf(error)} Reload the page to try again.`;
  node.hidden = false;
});
