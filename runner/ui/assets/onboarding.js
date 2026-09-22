/* global document, HTMLElement, HTMLInputElement, HTMLTextAreaElement, ResizeObserver, requestAnimationFrame */
// The Onboarding page (P03): account for every career source, extract claims
// from what is provided, decide each claim, record preferences, and approve.
// It follows docs/spec/visuals/index.html's walkthrough against the real API
// (server/routes/onboarding.ts). Everything a person reads comes from the API
// already worded for them; this file never shows an id or an internal key.
//
// P03 revision 2 (UI critic round 2, decisions D9-D13):
//  - Feedback (D12): one live region, the sticky "Last action" line
//    (role="status"). A field error sits next to its control, with
//    aria-invalid and aria-describedby. #page-error (role="alert") is only for
//    a page that failed to load.
//  - Focus (issue 1): every control has a stable id. After an action the page
//    focuses a planned target (for a claim: its own next action, else the next
//    undecided claim, else its card), otherwise the control that had focus.
//  - Drafts (issue 6, D13): typed text lives in `drafts`, keyed by control id,
//    so a re-render never empties a box. A source's saved text is fetched raw
//    when its panel opens.
import { el, formatTime, getJson, postJson } from "./runner.js";

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

// ---------------------------------------------------------------------------
// Feedback: the one live region (D12) and field errors
// ---------------------------------------------------------------------------

const TAGS = { done: "Last action", refused: "Refused", working: "Working" };

/** Announces one outcome, once. The same text twice in a row is cleared first so it is announced again. */
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

/** Keeps a focused control clear of the sticky "Last action" line (D12). */
function trackLastActionHeight() {
  const node = $("last-action");
  const update = () => document.documentElement.style.setProperty("--last-action-offset", `${Math.ceil(node.getBoundingClientRect().height) + 16}px`);
  new ResizeObserver(update).observe(node);
  update();
}

function fieldErrorId(controlId) {
  return `${controlId}-error`;
}

function fieldError(controlId) {
  const message = fieldErrors.get(controlId);
  return message ? el("p", { className: "field-error", text: message, attrs: { id: fieldErrorId(controlId) } }) : null;
}

/** Refuses an action at its control: the message sits next to the field and is announced once. */
function refuseAt(controlId, message) {
  fieldErrors.set(controlId, message);
  lastAction(message, "refused");
  render(controlId);
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/** A text box whose typed value survives re-renders (D13). */
function textControl(tag, id, saved, attrs = {}) {
  const { describedby, ...rest } = attrs;
  const control = el(tag, { attrs: { id, ...rest } });
  if (tag === "input") control.type = "text";
  control.value = drafts.has(id) ? drafts.get(id) : saved;
  const described = [describedby, fieldErrors.has(id) ? fieldErrorId(id) : null].filter(Boolean).join(" ");
  if (described) control.setAttribute("aria-describedby", described);
  if (fieldErrors.has(id)) control.setAttribute("aria-invalid", "true");
  control.addEventListener("input", () => {
    drafts.set(id, control.value);
    if (fieldErrors.delete(id)) {
      control.removeAttribute("aria-invalid");
      $(fieldErrorId(id))?.remove();
      if (describedby) control.setAttribute("aria-describedby", describedby);
      else control.removeAttribute("aria-describedby");
    }
  });
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
  if (work) button.addEventListener("click", () => run(id, work));
  return button;
}

function setBusy(id, on) {
  const button = $(id);
  if (!button) return;
  button.setAttribute("aria-disabled", on || button.dataset.disabled === "true" ? "true" : "false");
}

/** Runs an action. A failed request is announced once; with `fieldId` its message also sits next to that field. */
async function run(id, work, { fieldId } = {}) {
  const button = $(id);
  if (busy.has(id) || button?.dataset.disabled === "true") return;
  busy.add(id);
  setBusy(id, true);
  try {
    await work();
  } catch (error) {
    const message = messageOf(error);
    if (fieldId) fieldErrors.set(fieldId, message);
    lastAction(message, "refused");
    await refresh(fieldId ?? id).catch(() => render(fieldId ?? id));
  } finally {
    busy.delete(id);
    setBusy(id, false);
  }
}

// ---------------------------------------------------------------------------
// Load and render
// ---------------------------------------------------------------------------

async function refresh(focusPlan) {
  view = await getJson("/api/onboarding");
  for (const category of openPanels) loadSavedText(category);
  render(focusPlan);
}

function captureFocus() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !active.id) return null;
  const hasText = active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && active.type === "text");
  return { id: active.id, selection: hasText ? [active.selectionStart, active.selectionEnd] : null };
}

/** Focuses the planned target, else the control that had focus before the re-render. */
function restoreFocus(plan, saved) {
  const planned = typeof plan === "function" ? plan() : plan;
  const target = (planned && $(planned)) || (saved && $(saved.id));
  if (!(target instanceof HTMLElement)) return;
  if (document.activeElement !== target) target.focus();
  if (saved?.selection && target.id === saved.id && typeof target.setSelectionRange === "function") target.setSelectionRange(...saved.selection);
}

function render(focusPlan) {
  if (!view) return;
  const saved = captureFocus();
  renderMarkdownProblem();
  renderWithdrawal();
  renderReadiness();
  renderSources();
  renderClaims();
  renderStatements();
  restoreFocus(focusPlan, saved);
}

// ---------------------------------------------------------------------------
// career-profile.md can't be read (D9) and a withdrawn approval (D11)
// ---------------------------------------------------------------------------

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
  parts.push(el("p", { className: "withdrawal-next", text: open ? "Answer the open question below, then approve again." : "Review the change, then approve again." }));
  $("withdrawal-body").replaceChildren(...parts);
}

$("markdown-discard").addEventListener("click", () =>
  run("markdown-discard", async () => {
    const outcome = await postJson("/api/onboarding/markdown/discard", {});
    lastAction(outcome.message, "done");
    await refresh("page-title");
  }),
);

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
    { ok: r.ready, text: r.ready ? "Ready: generation unlocked" : "Not ready: generation locked", strong: true },
  ];
  $("readiness-lines").replaceChildren(
    ...lines.map((line) =>
      el(
        "li",
        { className: line.ok ? "readiness-line met" : "readiness-line" },
        el("span", { className: "m", text: line.ok ? "●" : "○", attrs: { "aria-hidden": "true" } }),
        el("span", { className: "visually-hidden", text: line.ok ? "Done: " : "Not yet: " }),
        line.strong ? el("strong", { text: line.text }) : el("span", { text: line.text }),
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
  if (!hint.hidden) {
    hint.replaceChildren(
      document.createTextNode(`${plural(pending.length, "proposed revision")} ${pending.length === 1 ? "is" : "are"} waiting. Version ${view.approval.version} stays in force until you accept or reject ${pending.length === 1 ? "it" : "them"} on the `),
      el("a", { text: "Profile page", attrs: { href: "/ui/profile" } }),
      document.createTextNode("."),
    );
  }
}

$("approve-button").addEventListener("click", () =>
  run("approve-button", async () => {
    const outcome = await postJson("/api/onboarding/approve", {});
    lastAction(outcome.message, outcome.ok ? "done" : "refused");
    await refresh("approve-button");
  }),
);

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
  $("sources").replaceChildren(...SOURCES.map(([category, label]) => sourceRow(category, label)));
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
  fieldErrors.delete(reasonId);
  if (value === "provided") openPanel(category);
  lastAction(outcome.message, outcome.ok ? "done" : "refused");
  await refresh(buttonId);
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
    el("div", { className: "form-row" }, actionButton(saveId, note ? "Save the new reason" : "Save reason", { secondary: true }, () => saveReason(category, label, status, saveId))),
  );
  return details;
}

async function saveReason(category, label, status, saveId) {
  const id = `source-reason-${category}`;
  const note = (drafts.get(id) ?? "").trim();
  if (!note) return refuseAt(id, `Type a reason first. It is optional: ${label} already counts as accounted for.`);
  const outcome = await postJson(`/api/onboarding/sources/${category}`, { status, note });
  drafts.delete(id);
  fieldErrors.delete(id);
  lastAction(outcome.message, outcome.ok ? "done" : "refused");
  await refresh(saveId);
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
  toggle.addEventListener("click", () => {
    if (openPanels.has(category)) openPanels.delete(category);
    else openPanel(category);
    render(toggleId);
  });
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
  file.addEventListener("change", () => run(fileId, () => upload(category, file), { fieldId: fileId }));
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
    return refuseAt(fileId, `“${file.name}” is not a .txt or .md file. Only plain text and Markdown files can be uploaded; paste other text into the box instead.`);
  }
  const text = await file.text();
  if (!text.trim()) return refuseAt(fileId, `“${file.name}” is empty, so there is nothing to upload.`);
  const outcome = await postJson(`/api/onboarding/sources/${category}/uploads`, { fileName: file.name, text });
  fieldErrors.delete(fileId);
  lastAction(outcome.message, "done");
  await refresh(fileId);
}

async function saveAndExtract(category, label, extractId) {
  const textId = `source-text-${category}`;
  const saved = savedText.get(category) ?? "";
  const text = drafts.has(textId) ? drafts.get(textId) : saved;
  const uploads = view.uploads?.[category] ?? [];
  if (!text.trim() && !saved.trim() && uploads.length === 0) {
    return refuseAt(textId, `Paste the text for ${label}, or upload a .txt or .md file, then extract.`);
  }
  if (text.trim() && text !== saved) {
    try {
      await postJson(`/api/onboarding/sources/${category}/content`, { text });
    } catch (error) {
      return refuseAt(textId, messageOf(error));
    }
    savedText.set(category, text);
  }
  drafts.delete(textId);
  fieldErrors.delete(textId);
  lastAction(`Extracting claims from ${label}. This can take up to a minute and a half.`, "working");
  const outcome = await postJson(`/api/onboarding/sources/${category}/extract`, {});
  lastAction(outcome.message, outcome.ok ? "done" : "refused");
  await refresh(extractId);
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

function evidenceText(claim) {
  const evidence = claim.evidence;
  if (evidence.kind === "statement" && evidence.ref.endsWith(NO_DETAIL_REF_SUFFIX)) return "Evidence: you confirmed it without adding detail.";
  if (evidence.kind === "statement") return `Evidence: your own statement, “${evidence.quote}”`;
  return `Evidence: “${evidence.quote}” (${evidence.ref})`;
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
  const container = $("claims");
  if (view.claims.length === 0) {
    container.replaceChildren(el("p", { className: "empty", text: "No claims yet. Mark a source provided, add its text, then extract claims from it." }));
    return;
  }
  container.replaceChildren(el("ul", { className: "claim-list" }, ...view.claims.map(claimCard)));
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
        el("p", { className: "claim-evidence", text: evidenceText(claim) }),
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
  const answerId = `claim-answer-${claim.id}`;
  const notes = view.notes?.[claim.id] ?? [];
  const block = el(
    "div",
    { className: "claim-question" },
    el("p", { className: "notice decision" }, el("strong", { text: "Question: " }), el("span", { text: claim.question ?? "This claim needs your answer before it can be confirmed.", attrs: { id: questionId } })),
  );
  if (notes.length > 0) {
    // D10: a reply that chose neither option, kept as a note; the question stays open.
    block.append(
      el("p", {
        className: "small muted notes-title",
        text: notes.length === 1 ? "Your earlier reply, kept as a note. It didn't confirm or exclude the claim:" : "Your earlier replies, kept as notes. They didn't confirm or exclude the claim:",
      }),
      el("ul", { className: "question-notes" }, ...notes.map((note) => el("li", {}, el("span", { text: `“${note.text}”` }), el("span", { className: "muted", text: ` · ${formatTime(note.at)}` })))),
    );
  }
  add(
    block,
    el("label", { text: "Your answer (optional): a ticket, a dashboard, how you know it", attrs: { for: answerId } }),
    textControl("textarea", answerId, "", { rows: "3", maxlength: "2000", describedby: questionId }),
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
  lastAction(outcome.message, outcome.ok ? "done" : "refused");
  await refresh(() => claimFocusTarget(claimId));
}

async function answer(claimId, hasEvidence) {
  const answerId = `claim-answer-${claimId}`;
  const statement = (drafts.get(answerId) ?? "").trim();
  const outcome = await postJson(`/api/onboarding/claims/${claimId}/answer`, hasEvidence && statement ? { hasEvidence, statement } : { hasEvidence });
  if (outcome.ok) drafts.delete(answerId);
  lastAction(outcome.message, outcome.ok ? "done" : "refused");
  await refresh(() => claimFocusTarget(claimId));
}

// ---------------------------------------------------------------------------
// Boundaries, preferences, presentation notes (Enter adds)
// ---------------------------------------------------------------------------

function renderStatements() {
  $("statements").replaceChildren(...STATEMENTS.map(statementForm));
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
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run(addId, () => addStatement(spec, inputId), { fieldId: inputId });
  });
  return form;
}

async function addStatement(spec, inputId) {
  const text = (drafts.get(inputId) ?? "").trim();
  if (!text) return refuseAt(inputId, `Type a ${spec.one} first, then add it.`);
  const outcome = await postJson(`/api/onboarding/statements/${spec.kind}`, { text });
  if (outcome.ok) drafts.delete(inputId);
  fieldErrors.delete(inputId);
  lastAction(outcome.message, outcome.ok ? "done" : "refused");
  await refresh(inputId);
}

// ---------------------------------------------------------------------------

trackLastActionHeight();
refresh().catch((error) => {
  const node = $("page-error");
  node.textContent = `The onboarding page couldn't load: ${messageOf(error)} Reload the page to try again.`;
  node.hidden = false;
});
