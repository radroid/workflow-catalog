/* global document, navigator, requestAnimationFrame, setTimeout, clearTimeout */
// The Runs page: the run log, newest first (server/routes/runs.ts GET /api/runs).
import { el, formatTime, getJson } from "./runner.js";

const $ = (id) => document.getElementById(id);

/** Mirror store/runs.ts's NO_MODEL and UNKNOWN_MODEL: no server import path exists from the browser, so these are duplicated. */
const NO_MODEL = "n/a";
const UNKNOWN_MODEL = "unknown";

/** How long the visible "Copied" / "Couldn't copy" note stays next to the button that was pressed. */
const COPY_FEEDBACK_MS = 4000;

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

/** "runs/2026-09-22/a82b1274-....json" -> "runs/2026-09-22/a82b1274….json" (G8: full path stays in `title`). Anything else is shown as it is. */
function shortRunPath(path) {
  const match = /^(runs\/\d{4}-\d{2}-\d{2}\/)([0-9a-f-]{8})[0-9a-f-]*(\.json)$/i.exec(path);
  return match ? `${match[1]}${match[2]}…${match[3]}` : path;
}

// The one visible copy note showing right now, so pressing another Copy path clears the previous one.
let activeCopyFeedback;
let copyFeedbackTimer;

function showCopyFeedback(node, text, failed) {
  if (activeCopyFeedback && activeCopyFeedback !== node) activeCopyFeedback.textContent = "";
  clearTimeout(copyFeedbackTimer);
  node.textContent = text;
  node.classList.toggle("failed", failed);
  activeCopyFeedback = node;
  copyFeedbackTimer = setTimeout(() => {
    node.textContent = "";
  }, COPY_FEEDBACK_MS);
}

/**
 * "Copy path" plus a visible result right next to it (I4, UI critic issue 3): the live region at the top of the
 * page can be far off-screen when the button is pressed deep in the list. The visible note is aria-hidden and
 * keeps its space reserved in the CSS, so the live region still makes the one announcement and nothing moves.
 */
function copyPathControls(run) {
  const label = `Copy path — ${kindLabel(run.kind)}, ${formatTime(run.startedAt)}`;
  const button = el("button", { className: "button secondary small copy-path", text: "Copy path", attrs: { type: "button", "aria-label": label } });
  const feedback = el("span", { className: "copy-feedback small", attrs: { "aria-hidden": "true" } });
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(run.absolutePath);
      showCopyFeedback(feedback, "Copied", false);
      announce("Path copied.", "success");
    } catch {
      showCopyFeedback(feedback, "Couldn't copy", true);
      announce("Couldn't copy the path.", "error");
    }
  });
  return [button, feedback];
}

/**
 * The duration/tokens/model line. None for a record that never finished (G10) or never called the model at all
 * (`n/a`: paused, or a body that failed before any turn; G8). A run that sent a turn but never learned the model
 * (`unknown`, a timeout before the first step, say) still shows its duration and tokens, and hides only the
 * model (I3, nit 8).
 */
function metaLine(run) {
  if (!run.finishedAt || run.model === NO_MODEL) return undefined;
  const meta = el(
    "div",
    { className: "run-meta" },
    el("span", { text: `Duration ${formatDuration(run.durationMs)}` }),
    el("span", { text: `Tokens in ${(run.tokens?.input ?? 0).toLocaleString()} · out ${(run.tokens?.output ?? 0).toLocaleString()}` }),
  );
  if (run.model !== UNKNOWN_MODEL) meta.append(el("span", {}, el("span", { text: "Model " }), el("code", { text: run.model })));
  return meta;
}

/** The record exactly as it is on disk: the list API adds `path` and `absolutePath`, which the file itself doesn't have (I4). */
function recordOnDisk(run) {
  const record = { ...run };
  delete record.path;
  delete record.absolutePath;
  return record;
}

function renderRun(run) {
  const unfinished = !run.finishedAt;
  const badgeClass = unfinished ? "neutral" : (OUTCOME_BADGE[run.outcome] ?? "neutral");
  const badgeText = unfinished ? "Did not finish (or still running)" : run.outcome;
  const when = formatTime(run.startedAt);

  const head = el(
    "div",
    { className: "run-head" },
    el("span", { className: "run-kind", text: kindLabel(run.kind) }),
    run.isCatchUp ? el("span", { className: "badge neutral", text: "catch-up" }) : undefined,
    el("span", { className: "muted small", text: when }),
  );

  // P4: the reason sits right next to the outcome pill, on the same line.
  const outcome = el("p", { className: "run-outcome small" }, el("span", { className: `badge ${badgeClass}`, text: badgeText }));
  if (!unfinished && run.error) outcome.append(el("span", { className: "run-reason", text: humanizeReason(run.error) }));

  const card = el("li", { className: "run-card" }, head, outcome);

  const meta = metaLine(run);
  if (meta) card.append(meta);
  if (!unfinished) {
    const note = itemCapNote(run.inputs);
    if (note) card.append(el("p", { className: "run-note small", text: note }));
  }

  const pathLine = el(
    "p",
    { className: "run-path small" },
    el("span", { className: "muted", text: "File " }),
    el("code", { text: shortRunPath(run.path), attrs: { title: run.path } }),
  );
  pathLine.append(...copyPathControls(run));
  card.append(pathLine);

  // The run id itself is never shown as visible text: only in the path's short form/title above, and inside
  // this opt-in JSON disclosure (a deliberate raw-data view, not glanceable text). Error codes such as
  // "MODEL_CALL_FAILED:" likewise appear only here, never in the visible reason above (G8).
  const summary = el("summary", { text: "View JSON", attrs: { "aria-label": `View JSON — ${kindLabel(run.kind)}, ${when}` } });
  const paths = el(
    "dl",
    { className: "run-json-paths" },
    el("div", {}, el("dt", { text: "In the workspace" }), el("dd", {}, el("code", { text: run.path }))),
    el("div", {}, el("dt", { text: "On this computer" }), el("dd", {}, el("code", { text: run.absolutePath }))),
  );
  const details = el("details", { className: "run-json" }, summary, paths, el("pre", { text: JSON.stringify(recordOnDisk(run), null, 2) }));
  card.append(details);

  return card;
}

/**
 * Neutral note (G9: not a decision) naming the skipped files as short paths in <code>, one per line, full path in
 * `title` (I4). A folder that couldn't be listed at all is one entry ("runs/2026-09-23/", or "runs/" for the whole
 * log; I2), so the count then says "records or folders" rather than claim it counted records inside it.
 */
function renderSkippedNote(node, invalidCount, skippedFiles) {
  node.replaceChildren();
  if (invalidCount <= 0) {
    node.hidden = true;
    return;
  }
  const noun = skippedFiles.some((file) => file.endsWith("/")) ? `run record${invalidCount === 1 ? " or folder" : "s or folders"}` : `run record${invalidCount === 1 ? "" : "s"}`;
  node.append(el("p", { text: `${invalidCount} ${noun} could not be read:` }));
  const list = el("ul", { className: "skipped-files" });
  for (const file of skippedFiles) list.append(el("li", {}, el("code", { text: shortRunPath(file), attrs: { title: file } })));
  node.append(list);
  if (invalidCount > skippedFiles.length) node.append(el("p", { text: `and ${invalidCount - skippedFiles.length} more.` }));
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
