/* global document */
// Settings → Budget section: server/routes/runs.ts GET/POST /api/runs/budget[/resume].
import { formatTime, getJson, postJson } from "./runner.js";

const $ = (id) => document.getElementById(id);

function announce(message, kind) {
  const node = $("status-message");
  node.textContent = message;
  node.className = `status-message${kind ? ` ${kind}` : ""}`;
}

// aria-disabled, not the disabled attribute: the button stays focusable
// while busy, so an action never moves focus away (UI-critic rule).
// aria-disabled does not stop a click on its own, so every handler below
// checks isBusy() first.
function setBusy(button, busy) {
  if (busy) button.setAttribute("aria-disabled", "true");
  else button.removeAttribute("aria-disabled");
}

function isBusy(button) {
  return button.getAttribute("aria-disabled") === "true";
}

function renderBudget(state) {
  $("daily-run-limit").value = state.dailyRunLimit;
  $("item-cap").value = state.itemCap;
  $("budget-usage-value").textContent = `${state.runsUsedToday} / ${state.dailyRunLimit}`;
  const pause = $("budget-pause");
  if (state.paused) {
    $("budget-pause-reason").textContent = state.pausedReason ?? "paused";
    $("budget-pause-since").textContent = state.pausedSince ? `(since ${formatTime(state.pausedSince)})` : "";
    pause.hidden = false;
  } else {
    pause.hidden = true;
  }
}

async function loadBudget() {
  const state = await getJson("/api/runs/budget");
  renderBudget(state);
}

$("budget-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("budget-save");
  if (isBusy(button)) return;
  setBusy(button, true);
  try {
    const dailyRunLimit = Number($("daily-run-limit").value);
    const itemCap = Number($("item-cap").value);
    const state = await postJson("/api/runs/budget", { dailyRunLimit, itemCap });
    renderBudget(state);
    announce("Saved.", "success");
  } catch (error) {
    announce(error instanceof Error ? error.message : String(error), "error");
  } finally {
    setBusy(button, false);
  }
});

$("budget-resume").addEventListener("click", async () => {
  const button = $("budget-resume");
  if (isBusy(button)) return;
  setBusy(button, true);
  try {
    const state = await postJson("/api/runs/budget/resume");
    renderBudget(state);
    announce("Resumed.", "success");
  } catch (error) {
    announce(error instanceof Error ? error.message : String(error), "error");
  } finally {
    setBusy(button, false);
  }
});

loadBudget().catch((error) => announce(error instanceof Error ? error.message : String(error), "error"));
