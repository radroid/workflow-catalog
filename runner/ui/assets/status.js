/* global document, requestAnimationFrame */
// The status page: install checklist, model check, paired browsers, workspace.
import { el, formatTime, getJson, postJson } from "./runner.js";

const $ = (id) => document.getElementById(id);

/** "Failed to fetch" (a network-level failure, not an API error) reads better as a plain sentence (K8, round-1
 * revision) -- the same wording and check runs.js/settings-budget.js already use for the identical case. */
function friendlyError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message === "Failed to fetch" || message.includes("NetworkError") ? "Can't reach the runner. Is it still running?" : message;
}

/** Renders `text`, wrapping any `` `backticked` `` spans as <code> (K8, round-1 revision): server text this page
 * shows verbatim -- model_not_configured's and eve_not_running's messages, and the checklist's own Fix: lines --
 * can carry a literal command this way. Never innerHTML with data. */
function withCode(text) {
  const nodes = [];
  let from = 0;
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    nodes.push(text.slice(from, match.index));
    nodes.push(el("code", { text: match[1] }));
    from = match.index + match[0].length;
  }
  nodes.push(text.slice(from));
  return nodes.filter((node) => node !== "");
}

function showError(error) {
  const node = $("page-error");
  node.replaceChildren(...withCode(friendlyError(error)));
  node.hidden = false;
}

function renderChecklist(report) {
  const list = $("checklist");
  list.replaceChildren();
  if (!report) {
    list.append(el("li", {}, el("span"), el("span", { className: "muted", text: "The checklist is not available." })));
    return;
  }
  $("checked-at").textContent = `Checked ${formatTime(report.checkedAt)}`;
  for (const item of report.items) {
    const body = el("div", {}, el("div", { className: "label", text: item.label }), el("div", { className: "detail", text: item.detail }));
    if (item.fix && item.status !== "ok") body.append(el("div", { className: "fix" }, "Fix: ", ...withCode(item.fix)));
    list.append(el("li", {}, el("span", { className: `badge ${item.status}`, text: item.status }), body));
  }
}

async function loadStatus() {
  const status = await getJson("/api/status");
  renderChecklist(status.checklist);
  $("workspace-root").textContent = status.workspace.root;
  $("package-version").textContent = status.packageVersion;
  // P06.1 item 4.2: status.eve.detail is the eve client's own raw error text (eve-gateway.ts's shorten(error.message),
  // e.g. a bare fetch/connection error) -- never shown to a person. One plain sentence covers every cause.
  // K8 (round-1 revision): the eve url is in <code>, and the down line names eve and how to start it again.
  const eveStatus = $("eve-status");
  eveStatus.replaceChildren();
  if (!status.eve) {
    eveStatus.textContent = "eve is not connected to this bridge.";
  } else if (status.eve.ok) {
    eveStatus.append("eve is answering at ", el("code", { text: status.eve.url }), ".");
  } else {
    eveStatus.append("eve isn't answering at ", el("code", { text: status.eve.url }), ". Start eve again with ", el("code", { text: "npm run runner" }), " in runner/.");
  }
}

async function loadModel() {
  const data = await getJson("/api/model");
  const summary = $("model-summary");
  if (!data.model) {
    summary.textContent = "No model is configured. Run npm run setup in runner/.";
    return;
  }
  const check = data.lastCheck;
  const state = data.verified
    ? `verified ${formatTime(check.checkedAt)}`
    : check && check.provider === data.model.provider && check.model === data.model.model && !check.ok
      ? `last check failed ${formatTime(check.checkedAt)}`
      : "not verified yet";
  summary.textContent = `${data.model.provider} · ${data.model.model} · ${state}`;
}

async function loadDevices() {
  const { devices } = await getJson("/api/devices");
  const body = $("devices");
  body.replaceChildren();
  if (devices.length === 0) {
    body.append(el("tr", {}, el("td", { className: "muted", text: "No browser is paired yet.", attrs: { colspan: "4" } })));
    return;
  }
  for (const device of devices) {
    // K11 (round-1 revision): aria-disabled, never disabled -- see the new-code handler above.
    const revoke = el("button", { className: "button secondary", text: "Revoke", attrs: { type: "button", "aria-disabled": "false" } });
    revoke.addEventListener("click", async () => {
      if (revoke.getAttribute("aria-disabled") === "true") return;
      revoke.setAttribute("aria-disabled", "true");
      try {
        await postJson(`/api/devices/${encodeURIComponent(device.deviceId)}/revoke`);
        await Promise.all([loadDevices(), loadStatus()]);
      } catch (error) {
        showError(error);
        revoke.setAttribute("aria-disabled", "false");
      }
    });
    body.append(
      el(
        "tr",
        {},
        el("td", {}, el("code", { text: device.deviceId.slice(0, 8) }), el("div", { className: "muted small", text: device.active ? "active" : "expired" })),
        el("td", { text: formatTime(device.pairedAt) }),
        el("td", { text: formatTime(device.expiresAt) }),
        el("td", {}, revoke),
      ),
    );
  }
}

// K11 (round-1 revision): aria-disabled, never the disabled attribute, which drops focus to the page body the
// instant it's set -- the same reason item 4.1's Check-the-model button already uses it.
$("new-code").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (button.getAttribute("aria-disabled") === "true") return;
  button.setAttribute("aria-disabled", "true");
  try {
    const { code, expiresAt } = await postJson("/api/pairing/codes");
    $("pairing-code-value").textContent = code;
    $("pairing-code-expiry").textContent = `Expires ${formatTime(expiresAt)}.`;
    $("pairing-code").hidden = false;
  } catch (error) {
    showError(error);
  } finally {
    button.setAttribute("aria-disabled", "false");
  }
});

// P06.1 item 4.1: aria-disabled, never the disabled attribute, which drops focus to the page body the instant it's
// set (a disabled element can't hold focus) -- the same pattern onboarding.css/profile.css/jobs.css's busy buttons
// use elsewhere. The click handler ignores a press while already busy, and #model-result's role="status" (in
// status.html) means setting its text is itself the announcement, with focus never having left the button.
$("check-model").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (button.getAttribute("aria-disabled") === "true") return;
  const result = $("model-result");
  button.setAttribute("aria-disabled", "true");
  result.hidden = false;
  result.className = "small muted";
  // K8 (round-1 revision): unhidden with nothing to say yet, so the *next* frame's "Checking…" is a genuine
  // mutation on an already-present live region, which assistive tech reliably announces -- setting the text in the
  // same tick as unhiding a previously `hidden` node (removed from the accessibility tree until now) often isn't.
  result.textContent = "";
  requestAnimationFrame(() => {
    if (result.textContent === "") result.textContent = "Checking…"; // still pending; a very fast check may have already finished
  });
  try {
    const outcome = await postJson("/api/model/check");
    result.className = outcome.ok ? "small" : "small error";
    result.textContent = outcome.ok ? "The model answered." : `The check failed: ${outcome.detail ?? "no detail"}`;
    await Promise.all([loadModel(), loadStatus()]);
  } catch (error) {
    result.className = "small error";
    // K8: "Can't reach the runner…" instead of a raw "Failed to fetch", and any backticked command in the server's
    // own message (model_not_configured, eve_not_running) rendered as <code>, never literal backticks.
    result.replaceChildren(...withCode(friendlyError(error)));
  } finally {
    button.setAttribute("aria-disabled", "false");
  }
});

Promise.all([loadStatus(), loadModel(), loadDevices()]).catch(showError);
