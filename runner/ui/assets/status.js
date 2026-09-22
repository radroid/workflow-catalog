/* global document */
// The status page: install checklist, model check, paired browsers, workspace.
import { el, formatTime, getJson, postJson } from "./runner.js";

const $ = (id) => document.getElementById(id);

function showError(error) {
  const node = $("page-error");
  node.textContent = error instanceof Error ? error.message : String(error);
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
    if (item.fix && item.status !== "ok") body.append(el("div", { className: "fix", text: `Fix: ${item.fix}` }));
    list.append(el("li", {}, el("span", { className: `badge ${item.status}`, text: item.status }), body));
  }
}

async function loadStatus() {
  const status = await getJson("/api/status");
  renderChecklist(status.checklist);
  $("workspace-root").textContent = status.workspace.root;
  $("package-version").textContent = status.packageVersion;
  $("eve-status").textContent = status.eve
    ? status.eve.ok
      ? `eve is answering at ${status.eve.url}.`
      : `eve is not answering at ${status.eve.url}${status.eve.detail ? `: ${status.eve.detail}` : "."}`
    : "eve is not connected to this bridge.";
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
    const revoke = el("button", { className: "button secondary", text: "Revoke", attrs: { type: "button" } });
    revoke.addEventListener("click", async () => {
      revoke.disabled = true;
      try {
        await postJson(`/api/devices/${encodeURIComponent(device.deviceId)}/revoke`);
        await Promise.all([loadDevices(), loadStatus()]);
      } catch (error) {
        showError(error);
        revoke.disabled = false;
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

$("new-code").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const { code, expiresAt } = await postJson("/api/pairing/codes");
    $("pairing-code-value").textContent = code;
    $("pairing-code-expiry").textContent = `Expires ${formatTime(expiresAt)}.`;
    $("pairing-code").hidden = false;
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
  }
});

$("check-model").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const result = $("model-result");
  button.disabled = true;
  result.hidden = false;
  result.className = "small muted";
  result.textContent = "Checking…";
  try {
    const outcome = await postJson("/api/model/check");
    result.className = outcome.ok ? "small" : "small error";
    result.textContent = outcome.ok ? "The model answered." : `The check failed: ${outcome.detail ?? "no detail"}`;
    await Promise.all([loadModel(), loadStatus()]);
  } catch (error) {
    result.className = "small error";
    result.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    button.disabled = false;
  }
});

Promise.all([loadStatus(), loadModel(), loadDevices()]).catch(showError);
