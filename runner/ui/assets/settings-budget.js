/* global document, requestAnimationFrame */
// Settings → Budget section: server/routes/runs.ts GET/POST /api/runs/budget[/resume].
import { formatTime, getJson, postJson } from "./runner.js";

const $ = (id) => document.getElementById(id);

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
// just overwriting it, so a repeated message ("Budget saved." twice in a
// row) is still re-announced by assistive tech, not silently skipped as
// unchanged (P9). A destructive-colored left border (settings.css) plus a
// literal "Error: " prefix carries the failure signal for non-visual and
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

/**
 * The note under the pause reason, by which pause the server says is showing (store/budget.ts has the
 * precedence). Written from the state the server just returned, never from what the page saw earlier (I4).
 * The two budget-file notes keep about the same length, so a repairing Save doesn't move Save (P9).
 */
const PAUSE_NOTES = {
  budget_unreadable: "The limits shown are the defaults. Resume saves them and restarts runs; Save keeps runs paused.",
  budget_repaired: "Your limits are saved now. Press Resume to restart runs; until then, Save keeps runs paused.",
  run_log_unreadable: "Runs stay paused until the runner can read this folder again. Resume can't clear this pause.",
};

/** The pauses whose fixed reason names a workspace path, "… (runs/…)": the path goes in <code> (G9, I2). */
const PATH_REASON_KINDS = new Set(["budget_unreadable", "budget_repaired", "run_log_unreadable"]);

/** "budget settings unreadable (runs/budget.json)" -> text + "(" + <code>runs/budget.json</code> + ")". */
function renderPauseReason(node, state) {
  node.replaceChildren();
  const reason = state.pausedReason ?? "paused";
  const match = PATH_REASON_KINDS.has(state.pauseKind) ? /^(.*\()(runs\/[^()]*)(\))$/.exec(reason) : null;
  if (!match) {
    node.append(document.createTextNode(reason));
    return;
  }
  const code = document.createElement("code");
  code.textContent = match[2];
  node.append(document.createTextNode(match[1]), code, document.createTextNode(match[3]));
}

function renderBudget(state) {
  $("daily-run-limit").value = state.dailyRunLimit;
  $("item-cap").value = state.itemCap;
  // I2: when today's run folder can't be read, the count is unknown; don't show the 0 the server reports.
  $("budget-usage-value").textContent = state.runLogUnreadable ? "unknown" : `${state.runsUsedToday} / ${state.dailyRunLimit}`;

  const pause = $("budget-pause");
  if (state.paused) {
    renderPauseReason($("budget-pause-reason"), state);
    $("budget-pause-since").textContent = state.pausedSince ? `(since ${formatTime(state.pausedSince)})` : "";
    const note = PAUSE_NOTES[state.pauseKind];
    $("budget-pause-note").textContent = note ?? "";
    $("budget-pause-note").hidden = !note;
    // Resume only clears a stored pause (or rewrites an unreadable file); it can't make the run folder readable.
    $("budget-resume").hidden = state.pauseKind === "run_log_unreadable";
    pause.hidden = false;
  } else {
    pause.hidden = true;
  }

  // G6/P1: "paused" only ever means a pause that needs attention; the daily limit reached on its own is a
  // separate, non-pausing state a consumer derives from runsUsedToday >= dailyRunLimit. Don't stack both
  // messages when the pause notice above already explains why runs are stopped.
  $("budget-limit-note").hidden = state.paused || state.runLogUnreadable || state.runsUsedToday < state.dailyRunLimit;
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

/** What a Save says, from the state it returned: decision 2 keeps any pause, so say so rather than implying runs restart. */
function savedMessage(state) {
  if (!state.paused) return "Budget saved.";
  if (state.pauseKind === "run_log_unreadable") return "Budget saved. Runs stay paused until the run log can be read.";
  return "Budget saved. Runs stay paused until you press Resume.";
}

/** What a Resume says, from the state it returned (I4): defaults only when the file was unreadable at that moment. */
function resumedMessage(state) {
  if (state.paused) return state.pauseKind === "run_log_unreadable" ? "Resumed, but runs stay paused: today's run log can't be read." : "Runs are still paused.";
  if (state.restoredDefaults) return `Runs resumed with the default limits: ${state.dailyRunLimit} runs a day, ${state.itemCap} jobs per run.`;
  return "Runs resumed.";
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
    announce(savedMessage(state), "success");
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
  setBusy(button, true);
  try {
    const state = await postJson("/api/runs/budget/resume");
    // Focus a stable element *before* renderBudget can hide the pause notice (and the Resume button inside it),
    // so focus never falls back to <body> (UI issue 3).
    $("budget-title").focus();
    renderBudget(state);
    announce(resumedMessage(state), "success");
  } catch (error) {
    announce(friendlyError(error), "error");
  } finally {
    setBusy(button, false);
  }
});

loadBudget().catch((error) => announce(friendlyError(error), "error"));
