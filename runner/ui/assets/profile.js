/* global document, HTMLElement */
// The profile page: approval status, pending revisions, and career-profile.md's
// editable, round-tripping text (store/profile-markdown.ts renders and
// parses it; this page is just a thin client over server/routes/onboarding.ts).
//
// P03 revision 1 (UI critic C1, C2, C6, polish): this file previously had no
// announce()/live-region usage at all, no stable ids to restore focus by
// after a reload() rebuild, and a "Saved. N claim(s)" message that did not
// say whether an edit to an already-approved fact had actually been applied
// or only proposed as a revision. See onboarding.js's header comment for the
// shared C1/C2 design (stable ids + captureFocus/restoreFocus, a single
// announce() outcome channel, aria-disabled + a busy guard instead of the
// disabled attribute) — mirrored here rather than shared, since this page
// cannot import onboarding.js and both are plain browser ES modules with no
// shared non-runner.css module to put it in.
import { el, formatTime, getJson, postJson } from "./runner.js";

const $ = (id) => document.getElementById(id);

const CLAIM_EDIT_PREFIX = "claim-edit:";
const STATEMENT_EDIT_PREFIX = "statement-edit:";

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

/**
 * Mirrors store/profile-reducer.ts's decodeStatementEditSummary (P03
 * revision 1, C6). Before this existed, a proposed boundary/preference/
 * presentation edit fell through renderRevisions' "else" branch and showed
 * the raw encoded summary verbatim (e.g. "statement-edit:boundary\n<uuid>\n...")
 * — exactly the kind of internal value a person reading this page should
 * never have to see.
 */
function decodeStatementEditSummary(summary) {
  if (!summary.startsWith(STATEMENT_EDIT_PREFIX)) return undefined;
  const rest = summary.slice(STATEMENT_EDIT_PREFIX.length);
  const firstNewline = rest.indexOf("\n");
  if (firstNewline === -1) return undefined;
  const kind = rest.slice(0, firstNewline);
  if (kind !== "boundary" && kind !== "preference" && kind !== "presentation") return undefined;
  const rest2 = rest.slice(firstNewline + 1);
  const secondNewline = rest2.indexOf("\n");
  if (secondNewline === -1) return undefined;
  const statementId = rest2.slice(0, secondNewline);
  const text = rest2.slice(secondNewline + 1);
  if (!statementId || !text) return undefined;
  return { kind, statementId, text };
}

const STATEMENT_KIND_LABELS = { boundary: "Boundary", preference: "Preference", presentation: "Presentation note" };

/** Mirrors store/profile-types.ts's statementField — see that file's own doc comment; the browser cannot import it. */
function statementField(kind) {
  return kind === "boundary" ? "boundaries" : kind === "preference" ? "preferences" : "presentation";
}

let state = null;

/** C2: every outcome (success or failure) goes through this — the polite live region, and a persistent visible line reload()'s rebuild does not discard. */
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

/** C1: aria-disabled (not the disabled attribute) so an in-flight button never drops out of the tab order — see onboarding.css's [aria-disabled="true"] rule (mirrored in profile.css) for why. */
function setBusy(button, busy) {
  button.setAttribute("aria-disabled", busy ? "true" : "false");
}

function isBusy(button) {
  return button.getAttribute("aria-disabled") === "true";
}

function captureFocus() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return null;
  const scope = active.closest("[id^='revision-']");
  return { id: active.id || null, scopeId: scope && scope !== active ? scope.id : null };
}

function restoreFocus(saved) {
  if (!saved) return;
  const target = (saved.id && document.getElementById(saved.id)) || (saved.scopeId && document.getElementById(saved.scopeId));
  if (target instanceof HTMLElement) target.focus();
}

function shortId(id) {
  return id.slice(0, 8);
}

async function reload() {
  const saved = captureFocus();
  state = await getJson("/api/onboarding");
  renderStatus();
  renderRevisions();
  $("markdown-editor").value = state.markdown;
  $("save-markdown").setAttribute("aria-disabled", "false");
  restoreFocus(saved);
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
    const decodedClaim = decodeClaimEditSummary(revision.summary);
    const decodedStatement = decodedClaim ? undefined : decodeStatementEditSummary(revision.summary);
    const claim = decodedClaim ? state.claims.find((c) => c.id === decodedClaim.claimId) : undefined;
    const statement = decodedStatement ? state[statementField(decodedStatement.kind)].find((s) => s.id === decodedStatement.statementId) : undefined;
    const card = el("div", { className: "revision", attrs: { id: `revision-${revision.id}`, tabindex: "-1" } });

    if (decodedClaim && claim) {
      card.append(
        el(
          "p",
          { className: "revision-diff" },
          el("span", { className: "old", text: claim.text }),
          document.createTextNode(" → "),
          el("span", { className: "new", text: decodedClaim.text }),
        ),
      );
      card.append(el("p", { className: "revision-meta", text: `Proposed ${formatTime(revision.proposedAt)} · claim ${shortId(decodedClaim.claimId)}` }));
    } else if (decodedStatement && statement) {
      card.append(
        el(
          "p",
          { className: "revision-diff" },
          el("span", { className: "muted small", text: `${STATEMENT_KIND_LABELS[decodedStatement.kind]}: ` }),
          el("span", { className: "old", text: statement.text }),
          document.createTextNode(" → "),
          el("span", { className: "new", text: decodedStatement.text }),
        ),
      );
      card.append(el("p", { className: "revision-meta", text: `Proposed ${formatTime(revision.proposedAt)} · ${STATEMENT_KIND_LABELS[decodedStatement.kind].toLowerCase()} ${shortId(decodedStatement.statementId)}` }));
    } else {
      // Last resort only (an id this page's own state no longer has a
      // matching claim/statement for) — never the routine path.
      card.append(el("p", { className: "revision-diff", text: "A change was proposed to something no longer in the current profile." }));
      card.append(el("p", { className: "revision-meta", text: `Proposed ${formatTime(revision.proposedAt)}` }));
    }

    const accept = el("button", { className: "button", text: "Accept", attrs: { type: "button", id: `revision-accept-${revision.id}` } });
    const reject = el("button", { className: "button secondary", text: "Reject", attrs: { type: "button", id: `revision-reject-${revision.id}` } });
    const decide = async (action) => {
      if (isBusy(accept) || isBusy(reject)) return;
      clearError();
      setBusy(accept, true);
      setBusy(reject, true);
      try {
        const outcome = await postJson(`/api/onboarding/revisions/${revision.id}/${action}`, {});
        announce(outcome.message, !outcome.ok);
        await reload();
      } catch (error) {
        showError(error);
        setBusy(accept, false);
        setBusy(reject, false);
      }
    };
    accept.addEventListener("click", () => decide("accept"));
    reject.addEventListener("click", () => decide("reject"));
    card.append(el("div", { className: "revision-actions" }, accept, reject));
    container.append(card);
  }
}

$("save-markdown").addEventListener("click", async () => {
  const button = $("save-markdown");
  if (isBusy(button)) return;
  clearError();
  const result = $("markdown-result");
  // Polish: whether this save applies directly or only proposes a revision
  // depends on approval *before* the request (once approved, every edit
  // through this route becomes a revision — store/profile-markdown.ts's
  // header comment). Captured now, since `state` is about to be replaced by
  // reload() regardless of which branch this turns out to be.
  const wasApproved = Boolean(state.approval);
  setBusy(button, true);
  result.hidden = false;
  result.className = "small";
  result.textContent = "Saving…";
  try {
    const outcome = await postJson("/api/onboarding/markdown", { markdown: $("markdown-editor").value });
    const message = wasApproved
      ? "Saved. Changes to already-approved facts were proposed as revisions above — accept them to apply. Any not-yet-approved sections were saved directly."
      : `Saved. ${outcome.claims.length} claim(s) in the profile.`;
    result.textContent = message;
    announce(message);
    await reload();
    result.focus?.();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.className = "small error";
    result.textContent = message;
    announce(message, true);
  } finally {
    setBusy(button, false);
  }
});

reload().catch(showError);
