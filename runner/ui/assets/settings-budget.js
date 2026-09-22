/* global document, requestAnimationFrame */
// Settings → Budget section: server/routes/runs.ts GET/POST /api/runs/budget[/resume].
import { formatTime, getJson, postJson } from "./runner.js";

const $ = (id) => document.getElementById(id);

/** The most recently rendered budget state, so an action (e.g. Resume) can see what it's about to change. */
let lastState;

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

// Clears then re-sets the live region's text (on the next frame) rather than
// just overwriting it, so a repeated message ("Saved." twice in a row) is
// still re-announced by assistive tech, not silently skipped as unchanged
// (P9). A destructive-colored left border (settings.css) plus a literal
// "Error: " prefix carries the failure signal for non-visual and
// insufficient-contrast-color cases alike (UI issue 2).
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

/** "Failed to fetch" (a network-level failure, not an API error) reads better as a plain sentence (P10). */
function friendlyError(error) {
  return isNetworkFailure(error) ? "Can't reach the runner. Is it still running?" : error instanceof Error ? error.message : String(error);
}

/** "budget settings unreadable (runs/budget.json)" -> text node + <code>runs/budget.json</code> (G9). */
function renderPauseReason(node, state) {
  node.replaceChildren();
  const match = state.corruptOrigin ? /^(.*)\(([^()]+)\)$/.exec(state.pausedReason ?? "") : null;
  if (match) {
    node.append(document.createTextNode(match[1]));
    const code = document.createElement("code");
    code.textContent = match[2];
    node.append(code);
  } else {
    node.append(document.createTextNode(state.pausedReason ?? "paused"));
  }
}

function renderBudget(state) {
  lastState = state;
  $("daily-run-limit").value = state.dailyRunLimit;
  $("item-cap").value = state.itemCap;
  $("budget-usage-value").textContent = `${state.runsUsedToday} / ${state.dailyRunLimit}`;

  const pause = $("budget-pause");
  if (state.paused) {
    renderPauseReason($("budget-pause-reason"), state);
    $("budget-pause-since").textContent = state.pausedSince ? `(since ${formatTime(state.pausedSince)})` : "";
    $("budget-corrupt-note").hidden = !state.corrupt;
    pause.hidden = false;
  } else {
    pause.hidden = true;
  }

  // G6/P1: "paused" only ever means this manual/provider-limit pause; the daily limit reached on its own is a
  // separate, non-pausing state a consumer derives from runsUsedToday >= dailyRunLimit. Don't stack both
  // messages when the pause notice above already explains why runs are stopped.
  $("budget-limit-note").hidden = state.paused || state.runsUsedToday < state.dailyRunLimit;
}

async function loadBudget() {
  const state = await getJson("/api/runs/budget");
  renderBudget(state);
}

const BOUNDS = {
  dailyRunLimit: { min: 1, max: 50, sentence: "Daily run limit must be a whole number from 1 to 50." },
  itemCap: { min: 1, max: 20, sentence: "Per-run item cap must be a whole number from 1 to 20." },
};

/** Client-side bounds check (issue 4): a server 400 is never shown raw; this makes reaching one unlikely at all. */
function validateField(id, key) {
  const input = $(id);
  const raw = input.value.trim();
  const value = Number(raw);
  const bounds = BOUNDS[key];
  const valid = raw !== "" && Number.isInteger(value) && value >= bounds.min && value <= bounds.max;
  if (valid) {
    input.removeAttribute("aria-invalid");
    return { valid: true, value, input };
  }
  input.setAttribute("aria-invalid", "true");
  return { valid: false, sentence: bounds.sentence, input };
}

$("budget-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("budget-save");
  if (isBusy(button)) return;

  const daily = validateField("daily-run-limit", "dailyRunLimit");
  const item = validateField("item-cap", "itemCap");
  const firstInvalid = !daily.valid ? daily : !item.valid ? item : undefined;
  if (firstInvalid) {
    announce(firstInvalid.sentence, "error");
    firstInvalid.input.focus();
    return;
  }

  setBusy(button, true);
  try {
    const state = await postJson("/api/runs/budget", { dailyRunLimit: daily.value, itemCap: item.value });
    renderBudget(state);
    // Section-specific (P9): never the bare "Saved." once a second section could also say it. Decision 2: Save
    // keeps any existing pause, so say so rather than implying the budget is back in effect.
    announce(state.paused ? "Saved. Runs stay paused until you press Resume." : "Budget saved.", "success");
  } catch (error) {
    // Never the raw 400 body (issue 4) — client-side validation above already covers every in-range case, so
    // reaching here is a genuine surprise (a stale bound, a network blip mid-flight, ...). A network failure
    // still gets its own specific, useful message; anything else gets one fixed, friendly sentence.
    announce(isNetworkFailure(error) ? friendlyError(error) : "Couldn't save the budget. Check the values and try again.", "error");
  } finally {
    setBusy(button, false);
  }
});

$("budget-resume").addEventListener("click", async () => {
  const button = $("budget-resume");
  if (isBusy(button)) return;
  const wasCorrupt = lastState?.corruptOrigin === true;
  setBusy(button, true);
  try {
    const state = await postJson("/api/runs/budget/resume");
    // Focus a stable element *before* the pause notice (and the Resume button inside it) is hidden by
    // renderBudget below, so focus never falls back to <body> (UI issue 3).
    $("budget-title").focus();
    renderBudget(state);
    announce(wasCorrupt ? "Resumed. The default limits (10 runs a day, 5 jobs per run) were saved." : "Runs resumed.", "success");
  } catch (error) {
    announce(friendlyError(error), "error");
  } finally {
    setBusy(button, false);
  }
});

loadBudget().catch((error) => announce(friendlyError(error), "error"));
