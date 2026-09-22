/* global document */
// The Runs page: the run log, newest first (server/routes/runs.ts GET /api/runs).
import { el, formatTime, getJson } from "./runner.js";

const $ = (id) => document.getElementById(id);

const KIND_LABELS = {
  prepare_newly_saved_jobs: "Prepare newly saved jobs",
  review_open_applications: "Review open applications",
  manual: "Manual run",
};

const OUTCOME_BADGE = { success: "ok", failure: "fail", paused: "warn" };

function kindLabel(kind) {
  return KIND_LABELS[kind] ?? kind;
}

/** Short, human duration: "420 ms", "12s", "1m 04s". Never a raw millisecond count once it gets large. */
function formatDuration(ms) {
  if (typeof ms !== "number" || Number.isNaN(ms)) return "";
  if (ms < 1000) return `${ms} ms`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

function announce(message, kind) {
  const node = $("status-message");
  node.textContent = message;
  node.className = `status-message${kind ? ` ${kind}` : ""}`;
}

function itemCapNote(inputs) {
  if (!inputs || typeof inputs !== "object" || typeof inputs.itemCap !== "number") return undefined;
  const remaining = Array.isArray(inputs.remainingItemIds) ? inputs.remainingItemIds.length : 0;
  if (remaining <= 0) return undefined;
  return `Stopped at the per-run cap (${inputs.itemCap}); ${remaining} job${remaining === 1 ? "" : "s"} stay Saved.`;
}

function renderRun(run) {
  const badgeClass = OUTCOME_BADGE[run.outcome] ?? "warn";
  const head = el(
    "div",
    { className: "run-head" },
    el("span", { className: `badge ${badgeClass}`, text: run.outcome }),
    el("span", { className: "run-kind", text: kindLabel(run.kind) }),
    run.isCatchUp ? el("span", { className: "badge warn", text: "catch-up" }) : undefined,
    el("span", { className: "muted small", text: formatTime(run.startedAt) }),
  );

  const meta = el(
    "div",
    { className: "run-meta" },
    el("span", { text: `Duration ${formatDuration(run.durationMs)}` }),
    el("span", { text: `Tokens in ${run.tokens?.input ?? 0} · out ${run.tokens?.output ?? 0}` }),
    el("span", {}, el("span", { text: "Model " }), el("code", { text: run.model })),
  );

  const card = el("li", { className: "run-card" }, head, meta);

  if (run.error) card.append(el("p", { className: "run-reason small", text: run.error }));
  const note = itemCapNote(run.inputs);
  if (note) card.append(el("p", { className: "run-reason small", text: note }));

  const pathLine = el(
    "p",
    { className: "run-path small" },
    el("span", { className: "muted", text: "File " }),
    el("code", { text: run.path, attrs: { title: run.runId } }),
  );
  card.append(pathLine);

  // The run id itself is never shown as visible text: only in the path's title attribute above, and inside this
  // opt-in JSON disclosure (a deliberate raw-data view, not glanceable text).
  const details = el("details", { className: "run-json" }, el("summary", { text: "View JSON" }), el("pre", { text: JSON.stringify(run, null, 2) }));
  card.append(details);

  return card;
}

async function loadRuns() {
  const list = $("runs-list");
  const empty = $("empty-state");
  const invalidNote = $("invalid-note");
  try {
    const { runs, invalidCount } = await getJson("/api/runs");
    list.replaceChildren();
    if (invalidCount > 0) {
      invalidNote.textContent = `${invalidCount} run record${invalidCount === 1 ? "" : "s"} could not be read and ${invalidCount === 1 ? "was" : "were"} skipped.`;
      invalidNote.hidden = false;
    } else {
      invalidNote.hidden = true;
    }
    if (runs.length === 0) {
      empty.hidden = false;
      announce(invalidCount > 0 ? `No readable runs yet. ${invalidNote.textContent}` : "No runs yet.", "success");
      return;
    }
    empty.hidden = true;
    for (const run of runs) list.append(renderRun(run));
    announce(`Loaded ${runs.length} run${runs.length === 1 ? "" : "s"}.`, "success");
  } catch (error) {
    list.replaceChildren();
    empty.hidden = true;
    announce(error instanceof Error ? error.message : String(error), "error");
  }
}

loadRuns();
