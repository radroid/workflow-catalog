/* global document, requestAnimationFrame */
// Settings → Schedules section: server/routes/runs.ts GET/POST /api/runs/schedules[...].
import { el, formatTime, getJson, postJson } from "./runner.js";

const $ = (id) => document.getElementById(id);

// aria-disabled, not the disabled attribute: the button stays focusable while busy (house rule, settings-budget.js).
function setBusy(button, busy) {
  if (busy) button.setAttribute("aria-disabled", "true");
  else button.removeAttribute("aria-disabled");
}

function isBusy(button) {
  return button.getAttribute("aria-disabled") === "true";
}

/** Same idiom as settings-budget.js's announce(): clears then re-sets on the next frame, so a repeated message is still re-announced. */
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

const KIND_LABELS = {
  prepare_newly_saved_jobs: "Prepare newly saved jobs",
  review_open_applications: "Review open applications",
};

function kindLabel(kind) {
  return KIND_LABELS[kind] ?? kind;
}

/** Every state (paused or not) currently being fetched again after a pause/resume click, so the whole list re-renders from the server's own state rather than guessing locally (I4's rule for Budget messages, applied here too). */
function renderSchedules(schedules) {
  const list = $("schedules-list");
  list.replaceChildren();
  for (const schedule of schedules) list.append(renderSchedule(schedule));
}

async function handlePauseResume(id, action, button) {
  if (isBusy(button)) return;
  setBusy(button, true);
  try {
    const { schedules } = await postJson(`/api/runs/schedules/${id}/${action}`);
    // Focus a stable anchor *before* the list is rebuilt (the pressed button itself gets replaced), so focus
    // never falls back to <body> (same rule as Budget's Resume, settings-budget.js).
    $("schedules-title").focus();
    renderSchedules(schedules);
    announce(action === "pause" ? "Schedule paused." : "Schedule resumed.", "success");
  } catch (error) {
    announce(friendlyError(error), "error");
  } finally {
    if (button.isConnected) setBusy(button, false);
  }
}

function renderSchedule(schedule) {
  const head = el(
    "div",
    { className: "schedule-head" },
    el("span", { className: "schedule-kind", text: kindLabel(schedule.kind) }),
    schedule.paused ? el("span", { className: "badge warn", text: "paused" }) : undefined,
  );

  const description = el("p", { className: "small muted", text: schedule.description });

  const meta = el(
    "div",
    { className: "schedule-meta" },
    el("span", { text: `Next run ${formatTime(schedule.nextRunAt)}` }),
    el("span", { text: schedule.lastRunAt ? `Last successful run ${formatTime(schedule.lastRunAt)}` : "No successful run yet" }),
  );
  if (typeof schedule.itemCap === "number") {
    meta.append(el("span", { text: `Up to ${schedule.itemCap} job${schedule.itemCap === 1 ? "" : "s"} per run` }));
  }

  const card = el("li", { className: "schedule-card" }, head, description, meta);

  if (schedule.lastAttemptAt && schedule.lastSummary) {
    card.append(el("p", { className: "small run-note", text: `Last attempt (${formatTime(schedule.lastAttemptAt)}): ${schedule.lastSummary}` }));
  }

  if (schedule.paused) {
    const notice = el("div", { className: "notice decision small schedule-pause" });
    const reasonLine = el("p", { className: "small" }, el("strong", { text: "Paused: " }));
    reasonLine.append(document.createTextNode(schedule.pausedReason ?? "paused"));
    if (schedule.pausedSince) reasonLine.append(el("span", { className: "muted", text: ` (since ${formatTime(schedule.pausedSince)})` }));
    const resumeButton = el("button", { className: "button secondary small", text: "Resume", attrs: { type: "button", "aria-label": `Resume — ${kindLabel(schedule.kind)}` } });
    resumeButton.addEventListener("click", () => handlePauseResume(schedule.id, "resume", resumeButton));
    notice.append(reasonLine, resumeButton);
    card.append(notice);
  } else {
    const pauseButton = el("button", { className: "button secondary small", text: "Pause", attrs: { type: "button", "aria-label": `Pause — ${kindLabel(schedule.kind)}` } });
    pauseButton.addEventListener("click", () => handlePauseResume(schedule.id, "pause", pauseButton));
    card.append(pauseButton);
  }

  return card;
}

async function loadSchedules() {
  const { schedules } = await getJson("/api/runs/schedules");
  renderSchedules(schedules);
}

loadSchedules().catch((error) => announce(friendlyError(error), "error"));
