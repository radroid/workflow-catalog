/* global document, navigator, requestAnimationFrame */
// The Runs page: the run log, newest first (server/routes/runs.ts GET /api/runs).
import { el, formatTime, getJson } from "./runner.js";

const $ = (id) => document.getElementById(id);

/** Mirrors store/runs.ts's NO_MODEL: no server import path exists from the browser, so this is duplicated. */
const NO_MODEL = "n/a";

const KIND_LABELS = {
  prepare_newly_saved_jobs: "Prepare newly saved jobs",
  review_open_applications: "Review open applications",
  manual: "Manual run",
};

const OUTCOME_BADGE = { success: "ok", failure: "fail", paused: "neutral" };

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

/** Clears then re-sets the live region's text on the next frame, so a repeated message is still re-announced (P9). */
function announce(message, kind) {
  const node = $("status-message");
  node.textContent = "";
  node.className = `status-message${kind ? ` ${kind}` : ""}`;
  requestAnimationFrame(() => {
    node.textContent = kind === "error" ? `Error: ${message}` : message;
  });
}

function friendlyError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message === "Failed to fetch" || message.includes("NetworkError") ? "Can't reach the runner. Is it still running?" : message;
}

function itemCapNote(inputs) {
  if (!inputs || typeof inputs !== "object" || typeof inputs.itemCap !== "number") return undefined;
  const remaining = Array.isArray(inputs.remainingItemIds) ? inputs.remainingItemIds.length : 0;
  if (remaining <= 0) return undefined;
  return `Stopped at the per-run cap (${inputs.itemCap}); ${remaining} job${remaining === 1 ? "" : "s"} stay Saved.`;
}

/** An internal error code prefix ("MODEL_CALL_FAILED: ...") is stripped from the visible text; the raw string still appears in the JSON view (G8). */
function humanizeReason(error) {
  const match = /^[A-Z][A-Z0-9_]+:\s*/.exec(error);
  return match ? error.slice(match[0].length) : error;
}

/** "runs/2026-09-22/a82b1274-....json" -> "runs/2026-09-22/a82b1274….json" (G8: full path stays in `title`). */
function shortRunPath(path) {
  const match = /^(runs\/\d{4}-\d{2}-\d{2}\/)([0-9a-f-]{8})[0-9a-f-]*(\.json)$/i.exec(path);
  return match ? `${match[1]}${match[2]}…${match[3]}` : path;
}

function copyPathButton(run) {
  const button = el("button", { className: "button secondary small copy-path", text: "Copy path", attrs: { type: "button" } });
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(run.absolutePath);
      announce("Path copied.", "success");
    } catch {
      announce("Couldn't copy the path.", "error");
    }
  });
  return button;
}

function renderRun(run) {
  const unfinished = !run.finishedAt;
  const badgeClass = unfinished ? "neutral" : (OUTCOME_BADGE[run.outcome] ?? "neutral");
  const badgeText = unfinished ? "Did not finish (or still running)" : run.outcome;
  const jsonLabel = `View JSON — ${kindLabel(run.kind)}, ${formatTime(run.startedAt)}`;

  const head = el(
    "div",
    { className: "run-head" },
    el("span", { className: `badge ${badgeClass}`, text: badgeText }),
    el("span", { className: "run-kind", text: kindLabel(run.kind) }),
    run.isCatchUp ? el("span", { className: "badge neutral", text: "catch-up" }) : undefined,
    el("span", { className: "muted small", text: formatTime(run.startedAt) }),
  );

  const card = el("li", { className: "run-card" }, head);

  if (!unfinished) {
    // Records that never reached the model (paused; the rare finished-but-uncontacted case) show no
    // duration/tokens/model line at all — a "0 ms · 0 · 0 · n/a" line said nothing useful (G8/G10).
    if (run.model !== NO_MODEL) {
      const meta = el(
        "div",
        { className: "run-meta" },
        el("span", { text: `Duration ${formatDuration(run.durationMs)}` }),
        el("span", { text: `Tokens in ${(run.tokens?.input ?? 0).toLocaleString()} · out ${(run.tokens?.output ?? 0).toLocaleString()}` }),
        el("span", {}, el("span", { text: "Model " }), el("code", { text: run.model })),
      );
      card.append(meta);
    }
    if (run.error) card.append(el("p", { className: "run-reason small", text: humanizeReason(run.error) }));
    const note = itemCapNote(run.inputs);
    if (note) card.append(el("p", { className: "run-reason small", text: note }));
  }

  const pathLine = el(
    "p",
    { className: "run-path small" },
    el("span", { className: "muted", text: "File " }),
    el("code", { text: shortRunPath(run.path), attrs: { title: run.path } }),
  );
  pathLine.append(copyPathButton(run));
  card.append(pathLine);

  // The run id itself is never shown as visible text: only in the path's short form/title above, and inside
  // this opt-in JSON disclosure (a deliberate raw-data view, not glanceable text). Error codes such as
  // "MODEL_CALL_FAILED:" likewise appear only here, never in the visible reason paragraph above (G8).
  const summary = el("summary", { text: "View JSON", attrs: { "aria-label": jsonLabel } });
  const details = el("details", { className: "run-json" }, summary, el("pre", { text: JSON.stringify(run, null, 2) }));
  card.append(details);

  return card;
}

/** Neutral note naming skipped files in <code>, not amber "decision" styling (G9: these aren't a decision). */
function renderSkippedNote(node, invalidCount, skippedFiles) {
  node.replaceChildren();
  if (invalidCount <= 0) {
    node.hidden = true;
    return;
  }
  node.append(el("span", { text: `${invalidCount} run record${invalidCount === 1 ? "" : "s"} could not be read: ` }));
  skippedFiles.forEach((file, index) => {
    if (index > 0) node.append(document.createTextNode(", "));
    node.append(el("code", { text: file }));
  });
  node.append(document.createTextNode(invalidCount > skippedFiles.length ? ` and ${invalidCount - skippedFiles.length} more.` : "."));
  node.hidden = false;
}

async function loadRuns() {
  const list = $("runs-list");
  const empty = $("empty-state");
  const invalidNote = $("invalid-note");
  try {
    const { runs, invalidCount, skippedFiles } = await getJson("/api/runs");
    list.replaceChildren();
    renderSkippedNote(invalidNote, invalidCount, skippedFiles);
    if (runs.length === 0) {
      empty.hidden = false;
      list.hidden = true;
      // No live-region echo on load (issue 6): the empty state is ordinary page content, not an interruption.
      return;
    }
    empty.hidden = true;
    list.hidden = false;
    for (const run of runs) list.append(renderRun(run));
    announce(`Loaded ${runs.length} run${runs.length === 1 ? "" : "s"}.`, "success");
  } catch (error) {
    list.replaceChildren();
    list.hidden = true;
    empty.hidden = true;
    announce(friendlyError(error), "error");
  }
}

loadRuns();
