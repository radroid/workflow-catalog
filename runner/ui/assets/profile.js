/* global document */
// The profile page: approval status, pending revisions, and career-profile.md's
// editable, round-tripping text (store/profile-markdown.ts renders and
// parses it; this page is just a thin client over server/routes/onboarding.ts).
import { el, formatTime, getJson, postJson } from "./runner.js";

const $ = (id) => document.getElementById(id);

const CLAIM_EDIT_PREFIX = "claim-edit:";

/** Mirrors store/profile-reducer.ts's decodeClaimEditSummary: this page cannot import that server module, so the same small, documented format is read here too. */
function decodeClaimEditSummary(summary) {
  if (!summary.startsWith(CLAIM_EDIT_PREFIX)) return undefined;
  const rest = summary.slice(CLAIM_EDIT_PREFIX.length);
  const newline = rest.indexOf("\n");
  if (newline === -1) return undefined;
  const claimId = rest.slice(0, newline);
  const text = rest.slice(newline + 1);
  if (!claimId || !text) return undefined;
  return { claimId, text };
}

let state = null;

function showError(error) {
  const node = $("page-error");
  node.textContent = error instanceof Error ? error.message : String(error);
  node.hidden = false;
}

function clearError() {
  $("page-error").hidden = true;
}

function shortId(id) {
  return id.slice(0, 8);
}

async function reload() {
  state = await getJson("/api/onboarding");
  renderStatus();
  renderRevisions();
  $("markdown-editor").value = state.markdown;
  $("save-markdown").disabled = false;
}

function renderStatus() {
  const node = $("status-summary");
  node.textContent = state.approval
    ? `Approved as version ${state.approval.version} on ${formatTime(state.approval.at)}.`
    : "Not yet approved — generation stays locked until every source is accounted for, no claim is left needing a decision, and you approve this profile on the Onboarding page.";
}

function renderRevisions() {
  const section = $("revisions-section");
  const container = $("revisions");
  container.replaceChildren();
  const pending = state.revisions.filter((revision) => revision.status === "proposed");
  section.hidden = pending.length === 0;
  if (pending.length === 0) return;

  for (const revision of pending) {
    const decoded = decodeClaimEditSummary(revision.summary);
    const claim = decoded ? state.claims.find((c) => c.id === decoded.claimId) : undefined;
    const card = el("div", { className: "revision" });
    if (decoded && claim) {
      card.append(
        el(
          "p",
          { className: "revision-diff" },
          el("span", { className: "old", text: claim.text }),
          document.createTextNode(" → "),
          el("span", { className: "new", text: decoded.text }),
        ),
      );
    } else {
      card.append(el("p", { className: "revision-diff", text: revision.summary }));
    }
    card.append(el("p", { className: "revision-meta", text: `Proposed ${formatTime(revision.proposedAt)} · claim ${decoded ? shortId(decoded.claimId) : "?"}` }));

    const accept = el("button", { className: "button", text: "Accept", attrs: { type: "button" } });
    const reject = el("button", { className: "button secondary", text: "Reject", attrs: { type: "button" } });
    const result = el("p", { className: "small" });
    const decide = async (action) => {
      clearError();
      accept.disabled = true;
      reject.disabled = true;
      try {
        const outcome = await postJson(`/api/onboarding/revisions/${revision.id}/${action}`, {});
        result.textContent = outcome.message;
        await reload();
      } catch (error) {
        showError(error);
        accept.disabled = false;
        reject.disabled = false;
      }
    };
    accept.addEventListener("click", () => decide("accept"));
    reject.addEventListener("click", () => decide("reject"));
    card.append(el("div", { className: "revision-actions" }, accept, reject), result);
    container.append(card);
  }
}

$("save-markdown").addEventListener("click", async () => {
  clearError();
  const button = $("save-markdown");
  const result = $("markdown-result");
  button.disabled = true;
  result.hidden = false;
  result.className = "small";
  result.textContent = "Saving…";
  try {
    const outcome = await postJson("/api/onboarding/markdown", { markdown: $("markdown-editor").value });
    result.textContent = `Saved. ${outcome.claims.length} claim(s) in the profile.`;
    await reload();
  } catch (error) {
    result.className = "small error";
    result.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    button.disabled = false;
  }
});

reload().catch(showError);
