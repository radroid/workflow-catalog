/* global document */
// The onboarding page: source accounting, extraction, claim decisions, and
// approval. Mirrors docs/spec/visuals/index.html's walkthrough logic
// (accounting -> extraction -> deciding -> readiness -> approval) against
// the real API (server/routes/onboarding.ts).
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

const STATUS_LABELS = { provided: "Provided", unavailable: "Unavailable", not_applicable: "Not applicable" };

let state = null; // the last GET /api/onboarding response
let openContent = new Set(); // categories whose paste-content panel is expanded

function announce(text) {
  $("live-region").textContent = text;
}

function showError(error) {
  const node = $("page-error");
  node.textContent = error instanceof Error ? error.message : String(error);
  node.hidden = false;
}

function clearError() {
  $("page-error").hidden = true;
}

async function reload() {
  state = await getJson("/api/onboarding");
  renderReadiness();
  renderSources();
  renderClaims();
}

function renderReadiness() {
  const r = state.readiness;
  const list = $("readiness-reasons");
  list.replaceChildren();
  for (const reason of r.reasons) list.append(el("li", { text: reason }));
  $("readiness-ready").hidden = r.reasons.length > 0;
  $("approve-button").disabled = !r.readyToApprove || r.approved;
  $("approve-button").textContent = r.approved ? "Approved" : "Approve career profile";
}

function sourceCategoryClaims(category) {
  return state.claims.filter((claim) => claim.source === category);
}

function renderSourceRow(category, label) {
  const entry = state.sources[category];
  const status = entry?.status;
  const row = el("div", { className: "source-row" });
  const badge = status ? el("span", { className: `badge ${status === "provided" ? "ok" : "warn"}`, text: STATUS_LABELS[status] }) : el("span", { className: "badge", text: "Unaccounted" });

  const buttons = el("div", { className: "source-status-buttons" });
  for (const [value, text] of Object.entries(STATUS_LABELS)) {
    const button = el("button", { className: `button secondary`, text, attrs: { type: "button" } });
    if (status === value) button.setAttribute("aria-pressed", "true");
    button.addEventListener("click", async () => {
      clearError();
      button.disabled = true;
      try {
        const result = await postJson(`/api/onboarding/sources/${category}`, { status: value });
        announce(result.message);
        await reload();
        if (value === "provided") openContent.add(category);
        renderSources();
      } catch (error) {
        showError(error);
      } finally {
        button.disabled = false;
      }
    });
    buttons.append(button);
  }

  const head = el(
    "div",
    { className: "source-row-head" },
    el("span", { className: "name", text: label }),
    badge,
    buttons,
    status === "provided" ? toggleContentButton(category) : el("span"),
  );
  row.append(head);
  if (status === "provided") row.append(sourceContentPanel(category));
  return row;
}

function toggleContentButton(category) {
  const button = el("button", { className: "button secondary", text: openContent.has(category) ? "Hide source text" : "Add / edit source text", attrs: { type: "button" } });
  button.addEventListener("click", () => {
    if (openContent.has(category)) openContent.delete(category);
    else openContent.add(category);
    renderSources();
  });
  return button;
}

function sourceContentPanel(category) {
  const panel = el("div", { className: `source-content${openContent.has(category) ? " open" : ""}` });
  const labelId = `source-text-label-${category}`;
  const textarea = el("textarea", { attrs: { id: labelId, "aria-label": `${category} source text` } });
  const extractButton = el("button", { className: "button", text: "Save & extract claims", attrs: { type: "button" } });
  const result = el("p", { className: "small claim-result" });

  extractButton.addEventListener("click", async () => {
    const text = textarea.value.trim();
    if (!text) {
      result.className = "small claim-result error";
      result.textContent = "Paste or type the source text first.";
      return;
    }
    clearError();
    extractButton.disabled = true;
    result.className = "small claim-result";
    result.textContent = "Saving and extracting…";
    try {
      await postJson(`/api/onboarding/sources/${category}/content`, { fileName: "pasted.txt", text });
      const outcome = await postJson(`/api/onboarding/sources/${category}/extract`, {});
      result.className = outcome.ok ? "small claim-result" : "small claim-result error";
      result.textContent = outcome.ok ? (outcome.message ?? "Extraction complete.") : `Extraction did not complete: ${outcome.message ?? outcome.status}`;
      await reload();
    } catch (error) {
      result.className = "small claim-result error";
      result.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      extractButton.disabled = false;
    }
  });

  const existing = sourceCategoryClaims(category).length;
  panel.append(
    el("label", { attrs: { for: labelId }, text: "Source text (resume, cover letter, profile export — whatever applies)" }),
    textarea,
    el("div", { className: "form-row" }, extractButton, el("span", { className: "muted small", text: existing > 0 ? `${existing} claim(s) already extracted from this source.` : "No claims extracted from this source yet." })),
    result,
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

function claimBadgeClass(status) {
  if (status === "confirmed") return "ok";
  if (status === "candidate" || status === "disputed") return "warn";
  return "badge"; // excluded: plain
}

function renderClaim(claim) {
  const card = el("div", { className: "claim" });
  card.append(
    el(
      "div",
      { className: "claim-head" },
      el("div", {}, el("div", { className: "claim-text", text: claim.text }), el("div", { className: "claim-meta", text: `${claim.kind} · ${claim.source} · ${shortId(claim.id)}` })),
      el("span", { className: `badge ${claimBadgeClass(claim.status)}`, text: claim.status }),
    ),
  );

  const result = el("p", { className: "small claim-result" });

  if (claim.status === "candidate") {
    const actions = el("div", { className: "claim-actions" });
    const confirm = el("button", { className: "button", text: "Confirm", attrs: { type: "button" } });
    const exclude = el("button", { className: "button secondary", text: "Exclude", attrs: { type: "button" } });
    const decide = async (decision) => {
      clearError();
      confirm.disabled = true;
      exclude.disabled = true;
      try {
        const outcome = await postJson(`/api/onboarding/claims/${claim.id}/decide`, { decision });
        announce(outcome.message);
        await reload();
      } catch (error) {
        showError(error);
      } finally {
        confirm.disabled = false;
        exclude.disabled = false;
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
    const statementId = `statement-${claim.id}`;
    const statement = el("textarea", { attrs: { id: statementId, "aria-label": `Your answer for ${shortId(claim.id)}`, placeholder: "Optional detail — a ticket, a dashboard, how you know it." } });
    const yes = el("button", { className: "button", text: "Yes — I have evidence", attrs: { type: "button" } });
    const no = el("button", { className: "button secondary", text: "No — exclude it", attrs: { type: "button" } });
    const answer = async (hasEvidence) => {
      clearError();
      yes.disabled = true;
      no.disabled = true;
      try {
        const outcome = await postJson(`/api/onboarding/claims/${claim.id}/answer`, hasEvidence ? { hasEvidence, statement: statement.value.trim() || undefined } : { hasEvidence });
        announce(outcome.message);
        await reload();
      } catch (error) {
        showError(error);
      } finally {
        yes.disabled = false;
        no.disabled = false;
      }
    };
    yes.addEventListener("click", () => answer(true));
    no.addEventListener("click", () => answer(false));
    form.append(statement, el("div", { className: "claim-actions" }, yes, no));
    card.append(form);
  }

  card.append(result);
  return card;
}

function renderClaims() {
  const container = $("claims");
  container.replaceChildren();
  if (state.claims.length === 0) {
    container.append(el("p", { className: "empty", text: "No claims yet. Mark a source provided and paste its text to extract some." }));
    return;
  }
  const list = el("div", { className: "claim-list" });
  for (const claim of state.claims) list.append(renderClaim(claim));
  container.append(list);
}

$("approve-button").addEventListener("click", async () => {
  clearError();
  const button = $("approve-button");
  const result = $("approve-result");
  button.disabled = true;
  result.hidden = false;
  result.className = "small";
  result.textContent = "Approving…";
  try {
    const outcome = await postJson("/api/onboarding/approve", {});
    result.className = outcome.ok ? "small" : "small error";
    result.textContent = outcome.message;
    await reload();
  } catch (error) {
    result.className = "small error";
    result.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    button.disabled = false;
  }
});

reload().catch(showError);
