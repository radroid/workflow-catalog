/* global document, requestAnimationFrame */
// Settings → Upgrade section (F12): server/routes/upgrade.ts GET/POST /api/upgrade[/confirm].
import { el, getJson, postJson } from "./runner.js";

const $ = (id) => document.getElementById(id);

// aria-disabled, not the disabled attribute: the button stays focusable while busy (house rule, settings-budget.js).
function setBusy(button, busy) {
  if (busy) button.setAttribute("aria-disabled", "true");
  else button.removeAttribute("aria-disabled");
}

function isBusy(button) {
  return button.getAttribute("aria-disabled") === "true";
}

/** Same idiom as settings-budget.js's announce(): clears then re-sets on the next frame, so a repeated message is still re-announced by assistive tech. */
function announce(message, kind) {
  const node = $("status-message");
  const text = kind === "error" ? `Error: ${message}` : message;
  node.textContent = "";
  node.className = `status-message${kind ? ` ${kind}` : ""}`;
  requestAnimationFrame(() => {
    node.textContent = text;
  });
}

function isNetworkFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message === "Failed to fetch" || message.includes("NetworkError");
}

function friendlyError(error) {
  return isNetworkFailure(error) ? "Can't reach the runner. Is it still running?" : error instanceof Error ? error.message : String(error);
}

/** The release the page currently shows as available, so Confirm always sends exactly the version the person saw and clicked (never a value re-read from an input the person could have raced with a fresh check). */
let shown = null;

function renderChangelog(changelog) {
  const container = $("upgrade-changelog");
  container.replaceChildren();
  for (const entry of changelog) {
    const notes = el("ul", { className: "upgrade-changelog-notes" });
    for (const note of entry.notes) notes.append(el("li", { text: note }));
    container.append(el("div", { className: "upgrade-changelog-entry" }, el("p", { className: "small", text: `${entry.version} (${entry.date})` }), notes));
  }
}

/** Shows exactly one of: up-to-date, refused, available (with Confirm hidden), or the confirm panel (with Available's own "Update to this version" trigger hidden, since Confirm's own buttons take over). */
function showState(state) {
  $("upgrade-up-to-date").hidden = state !== "up_to_date";
  $("upgrade-refused").hidden = state !== "refused";
  $("upgrade-available").hidden = !(state === "available" || state === "confirming");
  $("upgrade-start").hidden = state === "confirming";
  $("upgrade-confirm").hidden = state !== "confirming";
}

function render(check) {
  $("upgrade-current-value").textContent = check.currentVersion;
  if (check.status === "available") shown = check;
  if (check.status === "up_to_date") {
    showState("up_to_date");
  } else if (check.status === "refused") {
    $("upgrade-refused-message").textContent = check.message;
    showState("refused");
  } else if (check.status === "available") {
    $("upgrade-next-version").textContent = check.nextVersion;
    $("upgrade-confirm-version").textContent = check.nextVersion;
    renderChangelog(check.changelog);
    showState("available");
  }
  // "error" (the check itself could not complete, e.g. GitHub unreachable): leaves whatever was already shown in
  // place and only announces the plain message, rather than replacing a known-good state with a guess.
}

async function loadUpgrade() {
  const check = await getJson("/api/upgrade");
  render(check);
  if (check.status === "error") announce(check.message, "error");
}

$("upgrade-check").addEventListener("click", async () => {
  const button = $("upgrade-check");
  if (isBusy(button)) return;
  setBusy(button, true);
  try {
    const check = await getJson("/api/upgrade");
    render(check);
    if (check.status === "up_to_date") announce("You're on the latest release.", "success");
    else if (check.status === "available") announce(`An update is available: version ${check.nextVersion}.`, "success");
    else if (check.status === "refused") announce(check.message, "error");
    else announce(check.message, "error");
  } catch (error) {
    announce(friendlyError(error), "error");
  } finally {
    setBusy(button, false);
  }
});

$("upgrade-start").addEventListener("click", () => {
  const button = $("upgrade-start");
  if (isBusy(button) || !shown) return;
  showState("confirming");
  $("upgrade-confirm-yes").focus();
});

$("upgrade-confirm-cancel").addEventListener("click", () => {
  showState("available");
  $("upgrade-start").focus();
});

$("upgrade-confirm-yes").addEventListener("click", async () => {
  const button = $("upgrade-confirm-yes");
  if (isBusy(button) || !shown) return;
  setBusy(button, true);
  setBusy($("upgrade-confirm-cancel"), true);
  try {
    const result = await postJson("/api/upgrade/confirm", { nextVersion: shown.nextVersion });
    // Focus a stable anchor *before* the confirm panel is hidden and its own buttons removed from view, so focus
    // never falls back to <body> (same rule as Budget's Resume, settings-budget.js).
    $("upgrade-title").focus();
    shown = null;
    render({ status: "up_to_date", currentVersion: result.toVersion });
    announce(`Upgraded to version ${result.toVersion}.`, "success");
  } catch (error) {
    announce(friendlyError(error), "error");
  } finally {
    setBusy(button, false);
    setBusy($("upgrade-confirm-cancel"), false);
  }
});

loadUpgrade().catch((error) => announce(friendlyError(error), "error"));
