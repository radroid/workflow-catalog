/* global document, HTMLElement */
// The onboarding page: source accounting, extraction, claim decisions, and
// approval. Mirrors docs/spec/visuals/index.html's walkthrough logic
// (accounting -> extraction -> deciding -> readiness -> approval) against
// the real API (server/routes/onboarding.ts).
//
// P03 revision 1 (UI critic C1-C10, D3, polish) reshaped this file
// significantly; see docs/spec/implementation/P03-onboarding-and-career-profile.md's
// "Revision 1" report section for the full per-issue map. The load-bearing
// ideas, referenced by comment throughout below:
//  - C1: every interactive element gets a stable id so focus can be
//    restored by id after a reload() rebuild; captureFocus/restoreFocus do
//    this once, generically, instead of per-handler.
//  - C2: every outcome (success or failure) goes through announce(), which
//    updates both the aria-live region and a persistent, visible
//    #last-action line — neither of which reload() rebuilds away.
//  - Buttons use aria-disabled + a busy guard while a request is in
//    flight, not the disabled attribute: disabling a focused element
//    immediately drops it from the tab order and can silently move focus,
//    which is the more fundamental cause behind several of C1's reports.
import { el, getJson, postJson } from "./runner.js";

const $ = (id) => document.getElementById(id);

// SOURCE_CATEGORIES, in the same order as packages/contracts/src/source.ts.
const SOURCE_LABELS = [
  ["resume", "Resume"],
  ["previousCoverLetters", "Previous cover letters"],
  ["portfolioSite", "Portfolio / personal site"],
  ["repositories", "Repositories"],
  ["socialProfiles", "Social profiles (exported)"],
  ["workSamples", "Work samples"],
  ["targetRolesAndPreferences", "Target roles & preferences"],
];
const SOURCE_LABEL_BY_KEY = Object.fromEntries(SOURCE_LABELS);

const STATUS_LABELS = { provided: "Provided", unavailable: "Unavailable", not_applicable: "Not applicable" };

// Mirrors store/profile-types.ts's StatementKind/statementField: the browser
// cannot import that server module (same convention profile.js already
// documents for decodeClaimEditSummary/shortId).
const STATEMENT_KINDS = [
  ["boundary", "Boundary", "A rule generation must never cross — an invented metric, a changed date, a changed title, a changed credential."],
  ["preference", "Preference", "How you want to be represented: tone, emphasis, anything you want considered."],
  ["presentation", "Presentation note", "A wording rule for how an already-confirmed claim gets presented. Never a new fact, never a status change."],
];
function statementField(kind) {
  return kind === "boundary" ? "boundaries" : kind === "preference" ? "preferences" : "presentation";
}

let state = null; // the last GET /api/onboarding response
let openContent = new Set(); // categories whose paste/upload content panel is expanded
let loadedSourceText = new Set(); // categories whose saved source text has already been fetched into the textarea this session

/** C2: the one channel every outcome (success or failure) goes through — the polite live region for assistive tech, and a persistent visible line neither renderReadiness/renderSources/renderClaims/renderStatements rebuilds away. */
function announce(message, isError = false) {
  $("live-region").textContent = message;
  const last = $("last-action");
  last.hidden = false;
  last.className = isError ? "small error" : "small";
  last.textContent = message;
}

function showError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const node = $("page-error");
  node.textContent = message;
  node.hidden = false;
  announce(message, true);
}

function clearError() {
  $("page-error").hidden = true;
}

/** C1: marks a button busy without removing it from the tab order (which `disabled` does immediately, dropping focus). CSS (`onboarding.css`) renders `[aria-disabled="true"]` like a disabled button and blocks pointer clicks; this guards the keyboard-activation path a `pointer-events` rule cannot. */
function setBusy(button, busy) {
  button.setAttribute("aria-disabled", busy ? "true" : "false");
}

function isBusy(button) {
  return button.getAttribute("aria-disabled") === "true";
}

/** C1: focus lives on a stable id (or, when that exact control no longer exists after a reload — e.g. a claim's Confirm button once it is confirmed — the nearest claim/source-row container, which is always re-rendered so it can receive focus). */
function captureFocus() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return null;
  const scope = active.closest("[id^='claim-'], [id^='source-row-']");
  return { id: active.id || null, scopeId: scope && scope !== active ? scope.id : null };
}

function restoreFocus(saved) {
  if (!saved) return;
  const target = (saved.id && document.getElementById(saved.id)) || (saved.scopeId && document.getElementById(saved.scopeId));
  if (target instanceof HTMLElement) target.focus();
}

async function reload() {
  const saved = captureFocus();
  state = await getJson("/api/onboarding");
  renderReadiness();
  renderSources();
  renderClaims();
  renderStatements();
  restoreFocus(saved);
}

/** C3: the walkthrough's (docs/spec/visuals/index.html) four-line ●/○ readiness display — sources, claims, approval, then a bold overall summary — replacing a raw `<ul>` of server-formatted sentences (which also left a stale "Ready. Approving unlocks generation." line visible even once already approved). */
function renderReadiness() {
  const r = state.readiness;
  const list = $("readiness-reasons");
  list.replaceChildren();

  const lines = [
    { ok: r.sourcesAccounted, text: r.sourcesAccounted ? "Every source accounted for" : `Every source accounted for — ${r.unaccounted.length} pending (${r.unaccounted.map((c) => SOURCE_LABEL_BY_KEY[c] ?? c).join(", ")})` },
    { ok: r.claimsSettled, text: r.claimsSettled ? "Every claim decided" : `Every claim decided — ${r.pendingClaims.map((c) => shortId(c.id)).join(", ")} open` },
    { ok: r.approved, text: r.approved && state.approval ? `Profile approved (v${state.approval.version})` : "Profile approved" },
    { ok: r.ready, text: r.ready ? "Ready: generation unlocked" : "Not ready: generation locked", strong: true },
  ];
  for (const line of lines) {
    const marker = el("span", { className: "m", text: line.ok ? "●" : "○", attrs: { "aria-hidden": "true" } });
    const label = line.strong ? el("strong", { text: line.text }) : el("span", { text: line.text });
    list.append(el("div", { className: "readiness-line" }, marker, label));
  }

  const button = $("approve-button");
  setBusy(button, false);
  button.setAttribute("aria-disabled", !r.readyToApprove || r.approved ? "true" : "false");
  button.textContent = r.approved ? "Approved" : "Approve career profile";
  button.setAttribute("aria-describedby", "readiness-reasons");
}

function sourceCategoryClaims(category) {
  return state.claims.filter((claim) => claim.source === category);
}

/** C5: `provided`/`unavailable`/`not_applicable` are all a completed decision — "ok" — never amber. Only a category with no status yet ("Unaccounted") is the warn state; the previous logic had this backwards (`status === "provided" ? "ok" : "warn"` marked a deliberate Unavailable/Not applicable answer as if it were still outstanding). */
function statusBadge(status) {
  if (!status) return el("span", { className: "badge warn", text: "Unaccounted" });
  return el("span", { className: "badge ok", text: STATUS_LABELS[status] });
}

function renderSourceRow(category, label) {
  const entry = state.sources[category];
  const status = entry?.status;
  const nameId = `source-name-${category}`;
  const reasonId = `source-reason-${category}`;
  const row = el("div", { className: "source-row", attrs: { id: `source-row-${category}`, tabindex: "-1" } });

  // D3: a reason for Unavailable/Not applicable — the API already accepts
  // an optional `note` (sourceEntrySchema), this was the missing UI. Left
  // visible (not just for the two negative statuses) so an existing note is
  // never hidden, and pre-filled from the current entry so it round-trips
  // if the person re-submits the same status.
  const reasonInput = el("input", {
    attrs: { type: "text", id: reasonId, maxlength: "500", placeholder: "Why (optional) — used for Unavailable / Not applicable", value: entry?.note ?? "" },
  });

  // C9: buttons grouped under the source's own name via aria-labelledby (so
  // "Provided" reads as "Resume, Provided" to assistive tech, not a bare
  // "Provided" with no context), and every button now gets an explicit
  // aria-pressed (true or false) — previously only the selected one had the
  // attribute at all, so the others were not exposed as toggle buttons.
  const buttons = el("div", { className: "source-status-buttons", attrs: { role: "group", "aria-labelledby": nameId } });
  for (const [value, text] of Object.entries(STATUS_LABELS)) {
    const button = el("button", {
      className: "button secondary",
      text,
      attrs: { type: "button", id: `source-status-${category}-${value}`, "aria-pressed": String(status === value) },
    });
    button.addEventListener("click", async () => {
      if (isBusy(button)) return;
      clearError();
      setBusy(button, true);
      try {
        const note = value === "provided" ? undefined : reasonInput.value.trim() || undefined;
        const result = await postJson(`/api/onboarding/sources/${category}`, { status: value, note });
        announce(result.message);
        if (value === "provided") openContent.add(category);
        await reload();
      } catch (error) {
        showError(error);
      } finally {
        setBusy(button, false);
      }
    });
    buttons.append(button);
  }

  const head = el(
    "div",
    { className: "source-row-head" },
    el("span", { className: "name", text: label, attrs: { id: nameId } }),
    statusBadge(status),
    buttons,
    status === "provided" ? toggleContentButton(category) : el("span"),
  );
  row.append(head);
  // The reason field only ever applies to Unavailable/Not applicable — showing
  // it under an already-Provided source is dead UI (it can never be sent).
  if (status !== "provided") {
    row.append(el("div", { className: "source-reason-row" }, el("label", { className: "visually-hidden", text: `Reason ${label} is unavailable or not applicable`, attrs: { for: reasonId } }), reasonInput));
  }
  if (status === "provided") row.append(sourceContentPanel(category));
  return row;
}

/** C9: aria-expanded reflects whether the content panel this button controls is currently open. */
function toggleContentButton(category) {
  const open = openContent.has(category);
  const button = el("button", {
    className: "button secondary",
    text: open ? "Hide source text" : "Add / edit source text",
    attrs: { type: "button", "aria-expanded": String(open), "aria-controls": `source-content-${category}` },
  });
  button.addEventListener("click", () => {
    if (openContent.has(category)) openContent.delete(category);
    else openContent.add(category);
    renderSources();
  });
  return button;
}

/** Client-side gate for D3's TXT/MD upload — the server route stores whatever text it is sent; this is where "refuse other types with a plain message" happens, before anything is uploaded. */
function isAcceptableUploadName(name) {
  const lower = name.toLowerCase();
  return lower.endsWith(".txt") || lower.endsWith(".md");
}

function sourceContentPanel(category) {
  const panel = el("div", { className: `source-content${openContent.has(category) ? " open" : ""}`, attrs: { id: `source-content-${category}` } });
  const labelId = `source-text-label-${category}`;
  const textarea = el("textarea", { attrs: { id: labelId, "aria-label": `${SOURCE_LABEL_BY_KEY[category] ?? category} source text` } });
  const extractButton = el("button", { className: "button", text: "Save & extract claims", attrs: { type: "button" } });

  // Polish: the box used to always start empty, even when text had already
  // been saved for this category — there was no way to see what you had
  // previously provided. Fetched once per category per page session (fire
  // and forget; paste/upload still work if this fails) via the new
  // GET /sources/:category/content route.
  if (!loadedSourceText.has(category)) {
    loadedSourceText.add(category);
    getJson(`/api/onboarding/sources/${category}/content`)
      .then((data) => {
        if (!textarea.value && data?.text) textarea.value = data.text;
      })
      .catch(() => undefined);
  }

  // D3: TXT/MD upload alongside paste. Client-side read only — the file's
  // text lands in the same textarea and goes through the same
  // save-and-extract path a pasted value already did.
  const fileInputId = `source-file-${category}`;
  const fileInput = el("input", { attrs: { type: "file", id: fileInputId, accept: ".txt,.md,text/plain,text/markdown" } });
  const fileLabel = el("label", { text: "Or upload a .txt or .md file", attrs: { for: fileInputId } });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (!isAcceptableUploadName(file.name)) {
      announce(`"${file.name}" is not a .txt or .md file. Only plain text and Markdown are supported here — paste the text instead, or save it as .txt/.md first.`, true);
      fileInput.value = "";
      return;
    }
    try {
      textarea.value = await file.text();
      announce(`Loaded "${file.name}" into the text box below. Review it, then Save & extract.`);
    } catch (error) {
      announce(error instanceof Error ? error.message : String(error), true);
    }
  });

  extractButton.addEventListener("click", async () => {
    if (isBusy(extractButton)) return;
    const text = textarea.value.trim();
    if (!text) {
      announce("Paste or type the source text first.", true);
      return;
    }
    clearError();
    setBusy(extractButton, true);
    announce("Saving and extracting…");
    try {
      await postJson(`/api/onboarding/sources/${category}/content`, { fileName: "pasted.txt", text });
      const outcome = await postJson(`/api/onboarding/sources/${category}/extract`, {});
      announce(outcome.ok ? (outcome.message ?? "Extraction complete.") : `Extraction did not complete: ${outcome.message ?? outcome.status}`, !outcome.ok);
      await reload();
    } catch (error) {
      announce(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(extractButton, false);
    }
  });

  const existing = sourceCategoryClaims(category).length;
  panel.append(
    el("label", { attrs: { for: labelId }, text: "Source text (resume, cover letter, profile export — whatever applies)" }),
    textarea,
    el("div", { className: "form-row" }, fileLabel, fileInput),
    el("div", { className: "form-row" }, extractButton, el("span", { className: "muted small", text: existing > 0 ? `${existing} claim(s) already extracted from this source.` : "No claims extracted from this source yet." })),
  );
  return panel;
}

function renderSources() {
  const container = $("sources");
  container.replaceChildren();
  for (const [category, label] of SOURCE_LABELS) container.append(renderSourceRow(category, label));
}

function shortId(id) {
  return id.slice(0, 8);
}

/** C6: "disputed" reads as "question open" (docs/spec/visuals/index.html's claimPill convention) — a person is not expected to know the internal status vocabulary. C7 (390px overflow) depends on `.badge` staying `flex: none` in CSS while this stays plain text. */
function claimBadge(status) {
  if (status === "confirmed") return { className: "ok", text: "confirmed" };
  if (status === "disputed") return { className: "warn", text: "question open" };
  if (status === "candidate") return { className: "warn", text: "candidate" };
  return { className: "fail", text: "excluded" };
}

/** C10: the walkthrough's `profileMarkdown()` shows "Evidence: …" under every confirmed claim; claim cards here showed no evidence at all. `passage` evidence is a verbatim quote from a source; `statement` evidence is the person's own words, recorded once a follow-up question is answered (R6). */
function evidenceText(claim) {
  return claim.evidence.kind === "statement" ? `Evidence: your own statement — "${claim.evidence.quote}"` : `Evidence: "${claim.evidence.quote}"`;
}

function renderClaim(claim) {
  const badge = claimBadge(claim.status);
  const card = el("li", { className: "claim", attrs: { id: `claim-${claim.id}`, tabindex: "-1" } });
  card.append(
    el(
      "div",
      { className: "claim-head" },
      el(
        "div",
        { className: "claim-body" },
        el("div", { className: "claim-text", text: claim.text }),
        el("div", { className: "claim-meta", text: `${claim.kind} · ${SOURCE_LABEL_BY_KEY[claim.source] ?? claim.source} · ${shortId(claim.id)}` }),
        el("div", { className: "claim-evidence small muted", text: evidenceText(claim) }),
      ),
      el("span", { className: `badge ${badge.className}`, text: badge.text }),
    ),
  );

  if (claim.status === "candidate") {
    const actions = el("div", { className: "claim-actions" });
    const confirm = el("button", { className: "button", text: "Confirm", attrs: { type: "button", id: `claim-confirm-${claim.id}` } });
    const exclude = el("button", { className: "button secondary", text: "Exclude", attrs: { type: "button", id: `claim-exclude-${claim.id}` } });
    const decide = async (decision) => {
      if (isBusy(confirm) || isBusy(exclude)) return;
      clearError();
      setBusy(confirm, true);
      setBusy(exclude, true);
      try {
        const outcome = await postJson(`/api/onboarding/claims/${claim.id}/decide`, { decision });
        announce(outcome.message, !outcome.ok);
        await reload();
      } catch (error) {
        showError(error);
      } finally {
        setBusy(confirm, false);
        setBusy(exclude, false);
      }
    };
    confirm.addEventListener("click", () => decide("confirmed"));
    exclude.addEventListener("click", () => decide("excluded"));
    actions.append(confirm, exclude);
    card.append(actions);
  }

  if (claim.status === "disputed" && claim.question) {
    card.append(el("div", { className: "notice decision claim-question" }, el("p", { className: "small", text: claim.question })));
    const form = el("div", { className: "claim-answer-form" });
    const statementId = `claim-statement-${claim.id}`;
    const statement = el("textarea", { attrs: { id: statementId, "aria-label": `Your evidence for: ${claim.question}`, placeholder: "Optional detail — a ticket, a dashboard, how you know it." } });
    const yes = el("button", { className: "button", text: "Yes — I have evidence", attrs: { type: "button", id: `claim-yes-${claim.id}` } });
    const no = el("button", { className: "button secondary", text: "No — exclude it", attrs: { type: "button", id: `claim-no-${claim.id}` } });
    const answer = async (hasEvidence) => {
      if (isBusy(yes) || isBusy(no)) return;
      clearError();
      setBusy(yes, true);
      setBusy(no, true);
      try {
        const outcome = await postJson(`/api/onboarding/claims/${claim.id}/answer`, hasEvidence ? { hasEvidence, statement: statement.value.trim() || undefined } : { hasEvidence });
        announce(outcome.message, !outcome.ok);
        await reload();
      } catch (error) {
        showError(error);
      } finally {
        setBusy(yes, false);
        setBusy(no, false);
      }
    };
    yes.addEventListener("click", () => answer(true));
    no.addEventListener("click", () => answer(false));
    form.append(statement, el("div", { className: "claim-actions" }, yes, no));
    card.append(form);
  }

  return card;
}

function renderClaims() {
  const container = $("claims");
  container.replaceChildren();
  if (state.claims.length === 0) {
    container.append(el("p", { className: "empty", text: "No claims yet. Mark a source provided and paste its text to extract some." }));
    return;
  }
  // Polish: a semantic list (<ul>/<li>), not an unordered stack of <div>s.
  const list = el("ul", { className: "claim-list" });
  for (const claim of state.claims) list.append(renderClaim(claim));
  container.append(list);
}

/** D3: "Recordable Preferences" — boundaries/preferences/presentation notes previously had no way to be created at all from this page, only edited once they already existed via career-profile.md (Profile page). Calls the new POST /statements/:kind route. */
function renderStatementForm(kind, label, help) {
  const items = state[statementField(kind)];
  const wrap = el("div", { className: "statement-kind" });
  const inputId = `statement-input-${kind}`;
  const input = el("input", { attrs: { type: "text", id: inputId, maxlength: "600", placeholder: `Add a ${label.toLowerCase()}…` } });
  const addButton = el("button", { className: "button secondary", text: "Add", attrs: { type: "button", id: `statement-add-${kind}` } });

  addButton.addEventListener("click", async () => {
    if (isBusy(addButton)) return;
    const text = input.value.trim();
    if (!text) {
      announce(`Type a ${label.toLowerCase()} first.`, true);
      return;
    }
    clearError();
    setBusy(addButton, true);
    try {
      const outcome = await postJson(`/api/onboarding/statements/${kind}`, { text });
      announce(outcome.message, !outcome.ok);
      input.value = "";
      await reload();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(addButton, false);
    }
  });

  wrap.append(
    el("label", { text: label, attrs: { for: inputId } }),
    el("p", { className: "muted small", text: help }),
    el("div", { className: "form-row" }, input, addButton),
    el("p", { className: "muted small", text: items.length ? `${items.length} recorded: ${items.map((s) => s.text).join(" · ")}` : "None recorded yet." }),
  );
  return wrap;
}

function renderStatements() {
  const container = $("statements");
  container.replaceChildren();
  for (const [kind, label, help] of STATEMENT_KINDS) container.append(renderStatementForm(kind, label, help));
}

$("approve-button").addEventListener("click", async () => {
  const button = $("approve-button");
  if (isBusy(button)) return;
  clearError();
  const result = $("approve-result");
  setBusy(button, true);
  result.hidden = false;
  result.className = "small";
  result.textContent = "Approving…";
  try {
    const outcome = await postJson("/api/onboarding/approve", {});
    result.className = outcome.ok ? "small" : "small error";
    result.textContent = outcome.message;
    announce(outcome.message, !outcome.ok);
    // C4: reload()'s renderReadiness() is the single source of truth for
    // this button's disabled state from here on (readyToApprove/approved,
    // freshly computed) — do not also reset aria-disabled in a `finally`
    // below, which previously stomped the correct post-approval "stay
    // disabled" state back to enabled unconditionally, on every outcome
    // including success.
    await reload();
    if (outcome.ok) result.focus?.();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.className = "small error";
    result.textContent = message;
    announce(message, true);
    // The request never completed, so readiness truly has not changed from
    // what renderReadiness last set — restore the pre-click state instead
    // of leaving the button stuck busy.
    setBusy(button, false);
  }
});

reload().catch(showError);
