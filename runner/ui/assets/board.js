/* global document, window, fetch, requestAnimationFrame, ResizeObserver, setTimeout, clearTimeout, AbortController */
// The board (P06, mvp-spec F8): every application by its stage, with the last preparation's outcome shown apart
// from it; the run budget and its pause; and starting a session from Ready applications. Talks to
// server/routes/applications.ts (GET /board, POST /:taskId/stage), server/routes/sessions.ts (POST /) and
// server/routes/runs.ts (GET /budget).
//
// House rules (runner/ui/assets/application.js and jobs.js, copied rather than shared, as each page owns its
// script):
// - One sticky "Last action" line is the page's only live region; each outcome is announced once, whole.
// - A focused node is never replaced (morphChildren/morphNode), and a refresh never moves it on screen.
// - A control is aria-disabled while its request is in flight.
// - No field name, status code or id in visible text.
// - Amber marks one thing only: a preparation waiting on the person's answer.
import { el } from "./runner.js";

const $ = (id) => document.getElementById(id);

/** A line that names a job is fitted to 80 characters, so it stays within the two-line clamp at 390 px (P04's T18). */
const NAMED_LINE_MAX = 80;
const REFRESH_MS = 5_000;
/** A runner that hangs rather than stops is noticed: a request unanswered this long counts as "can't reach". */
export const REQUEST_TIMEOUT_MS = 15_000;
const CANT_REACH = "Can't reach the runner. Is it still running?";

const STAGES = [
  ["saved", "Saved"],
  ["preparing", "Preparing"],
  ["ready", "Ready"],
  ["applied", "Applied"],
  ["interviewing", "Interviewing"],
  ["offer", "Offer"],
  ["rejected", "Rejected"],
  ["withdrawn", "Withdrawn"],
];
const STAGE_WORDS = Object.fromEntries(STAGES);

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor({ code, status, taskId } = {}) {
    super(code ?? "request_failed");
    this.code = code;
    this.status = status;
    this.taskId = taskId;
  }
}

async function api(method, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  let data = null;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      signal: controller.signal,
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    try {
      data = await response.json();
    } catch {
      if (controller.signal.aborted) throw new Error("timed out");
      // not JSON
    }
  } catch {
    throw new ApiError({ code: "unreachable" });
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401) {
    window.location.reload();
    throw new ApiError({ code: "signed_out", status: 401 });
  }
  if (!response.ok) throw new ApiError({ code: data?.error?.code, status: response.status, taskId: data?.error?.taskId });
  return data;
}

const getJson = (path) => api("GET", path);
const postJson = (path, body) => api("POST", path, body ?? {});

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Messages: hand-written strings, where `code` spans and [label](/path) links render, and data(...) values (a
// job's name, the budget's reason), which are always plain text and never parsed.
// ---------------------------------------------------------------------------

const data = (text) => ({ data: String(text) });
const MARKUP = /`([^`]+)`|\[([^\]]+)\]\((\/[^)\s]*)\)/g;

function piecesOf(message) {
  return Array.isArray(message) ? message : [message];
}

function renderPieces(message) {
  const nodes = [];
  for (const piece of piecesOf(message)) {
    if (typeof piece !== "string") {
      nodes.push(piece.data);
      continue;
    }
    let from = 0;
    for (const match of piece.matchAll(MARKUP)) {
      nodes.push(piece.slice(from, match.index));
      nodes.push(match[1] !== undefined ? el("code", { text: match[1] }) : el("a", { text: match[2], attrs: { href: match[3] } }));
      from = match.index + match[0].length;
    }
    nodes.push(piece.slice(from));
  }
  return nodes.filter((node) => node !== "");
}

function plainOf(message) {
  return piecesOf(message)
    .map((piece) => (typeof piece === "string" ? piece.replace(MARKUP, (_all, code, label) => code ?? label) : piece.data))
    .join("");
}

/** Cut at a word, never mid-word unless one word is longer than half the room, and never after a separator. */
export function shorten(text, max) {
  const line = String(text).replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  const base = space >= Math.floor(max / 2) ? cut.slice(0, space) : cut;
  return `${base.replace(/[\s·,;:–—-]+$/u, "")}…`;
}

/** `before“name”after`, with the name shortened so the whole sentence fits the line. */
function withName(before, name, after) {
  const room = Math.max(16, NAMED_LINE_MAX - plainOf(before).length - plainOf(after).length - 2);
  return [before, data(`“${shorten(name, room)}”`), after];
}

/** “A”, “A” and “B”, “A”, “B” and 2 more: names that fit one line. */
function namesPhrase(names, room) {
  const quoted = names.map((name) => `“${name}”`);
  for (let shown = names.length; shown >= 1; shown -= 1) {
    const rest = names.length - shown;
    const each = Math.max(12, Math.floor((room - (rest > 0 ? 12 : 0)) / shown) - 4);
    const parts = names.slice(0, shown).map((name) => `“${shorten(name, each)}”`);
    const tail = rest > 0 ? ` and ${rest} more` : "";
    const text = rest > 0 ? `${parts.join(", ")}${tail}` : parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
    if (text.length <= room || shown === 1) return text;
  }
  return quoted[0];
}

// ---------------------------------------------------------------------------
// The "Last action" line
// ---------------------------------------------------------------------------

const TAGS = { done: "Last action", refused: "Refused", working: "Working" };

function keepInPlace(change) {
  const node = document.activeElement;
  const top = node && node !== document.body ? node.getBoundingClientRect().top : null;
  change();
  if (top === null || document.activeElement !== node || !node.isConnected) return;
  const moved = node.getBoundingClientRect().top - top;
  if (Math.abs(moved) >= 1) window.scrollBy(0, moved);
}

let working = null;

function stopWorking() {
  if (working) clearTimeout(working);
  working = null;
}

/**
 * Announces one outcome, once, whole. The same text twice in a row is cleared first, tag and text together, so
 * it is announced again, and never as the tag alone.
 */
function lastAction(message, tone = "done") {
  if (tone !== "working") stopWorking();
  const node = $("last-action");
  const tag = node.querySelector(".tag");
  const text = node.querySelector(".text");
  const plain = plainOf(message);
  const apply = () =>
    keepInPlace(() => {
      node.className = `last-action ${tone}`;
      tag.textContent = TAGS[tone];
      text.replaceChildren(...renderPieces(message));
      text.title = plain;
    });
  if (text.textContent === plain && tag.textContent === TAGS[tone]) {
    keepInPlace(() => {
      tag.textContent = "";
      text.textContent = "";
    });
    requestAnimationFrame(apply);
  } else {
    apply();
  }
}

function workingAfterDelay(message) {
  stopWorking();
  working = setTimeout(() => {
    working = null;
    lastAction(message, "working");
  }, 300);
}

function trackLastActionHeight() {
  const node = $("last-action");
  const update = () => document.documentElement.style.setProperty("--last-action-offset", `${Math.ceil(node.getBoundingClientRect().height) + 16}px`);
  if (typeof ResizeObserver === "function") new ResizeObserver(update).observe(node);
  update();
}

// ---------------------------------------------------------------------------
// Rendering in place: a re-render never replaces a node that holds focus.
// ---------------------------------------------------------------------------

const HANDLERS = ["onclick", "oninput", "onchange"];

function holdsFocus(node) {
  const active = document.activeElement;
  return Boolean(active) && active !== document.body && node.contains(active);
}

function isKeyed(node) {
  return node.nodeType === 1 && node.id !== "";
}

function morphChildren(parent, wanted) {
  const current = [...parent.childNodes];
  const byId = new Map(current.filter(isKeyed).map((node) => [node.id, node]));
  const used = new Set();
  const next = wanted.map((node) => {
    const match = isKeyed(node) ? byId.get(node.id) : current.find((old) => !used.has(old) && !isKeyed(old) && old.nodeType === node.nodeType && old.nodeName === node.nodeName);
    if (!match || used.has(match) || match.nodeName !== node.nodeName) return node;
    used.add(match);
    morphNode(match, node);
    return match;
  });
  for (const old of current) {
    if (used.has(old) || holdsFocus(old)) continue;
    old.remove();
  }
  let ref = parent.firstChild;
  for (const node of next) {
    if (node === ref) ref = ref.nextSibling;
    else parent.insertBefore(node, ref);
  }
}

function morphNode(node, next) {
  if (node.nodeType !== 1) {
    if (node.nodeValue !== next.nodeValue) node.nodeValue = next.nodeValue;
    return;
  }
  for (const name of node.getAttributeNames()) if (!next.hasAttribute(name)) node.removeAttribute(name);
  for (const name of next.getAttributeNames()) {
    const value = next.getAttribute(name);
    if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  }
  for (const handler of HANDLERS) node[handler] = next[handler];
  morphChildren(node, [...next.childNodes]);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let board = null;
let budget = null;
let boardKey = "";
/** Ready applications chosen for the next session. */
const picked = new Set();
/** Applications whose stage move is in flight. */
const moving = new Set();
let starting = false;
/** Whether the "can't reach the runner" line is up: announced once per outage, cleared by the next good refresh. */
let unreachableShown = false;

/** The page's own sentences name Settings and the Runs page; on this page each is a link. Only runner-written text passes through here. */
function withPageLinks(message) {
  return message.replace(/\bin Settings\b/g, "in [Settings](/ui/settings)").replace(/\bthe Runs page\b/g, "the [Runs](/ui/runs) page");
}

function entryOf(taskId) {
  return board?.applications.find((entry) => entry.taskId === taskId);
}

function formatDay(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

/** "budget settings unreadable (runs/budget.json)": the path goes in <code>, as Settings shows it. */
function reasonPieces(reason) {
  const match = /^(.*\()(runs\/[^()`]*)(\))$/.exec(reason);
  return match ? [data(match[1]), `\`${match[2]}\``, data(match[3])] : [data(reason)];
}

function renderBudget() {
  const node = $("runs-line");
  let message;
  let tone;
  if (!budget) {
    message = "The run budget can't be read right now.";
    tone = "runs-line blocked";
  } else if (budget.paused) {
    // P08's deliverable: the paused budget and its reason, on the board. Resuming is Settings' (P08-A).
    message = ["Runs are paused: ", ...reasonPieces(budget.pausedReason ?? "paused"), ". Nothing is prepared until you resume them in [Settings](/ui/settings#budget-section); the [Runs](/ui/runs) page shows why."];
    tone = "runs-line blocked";
  } else if (budget.runLogUnreadable) {
    message = `Runs today: unknown of ${budget.dailyRunLimit}.`;
    tone = "runs-line";
  } else {
    message = `Runs today: ${budget.runsUsedToday} of ${budget.dailyRunLimit}. Each preparation uses one.`;
    tone = "runs-line";
  }
  const next = el("p", { className: tone, attrs: { id: "runs-line" } }, ...renderPieces(message));
  morphNode(node, next);
}

// ---------------------------------------------------------------------------
// The cards
// ---------------------------------------------------------------------------

/** How the last preparation went, apart from the stage (F8): it never moves it. */
function processingLine(entry) {
  const state = entry.state;
  const id = `state-${entry.taskId}`;
  if (state.status === "running") return el("p", { className: "card-state muted small", attrs: { id }, text: "Preparing now…" });
  if (state.status === "parked" && state.open > 0) {
    return el("p", { className: "card-state decision small", attrs: { id } }, el("span", { className: "badge warn", text: "Needs your answer" }), " ", ...renderPieces(`${state.message} Answer on the [Applications](/ui/application) page.`));
  }
  if (state.status === "parked") return el("p", { className: "card-state small", attrs: { id }, text: state.message });
  if (state.status === "failed" || state.status === "interrupted") return el("p", { className: "card-state refused small", attrs: { id } }, ...renderPieces(withPageLinks(state.message)));
  return null;
}

function moveControls(entry) {
  const select = el(
    "select",
    { attrs: { id: `move-${entry.taskId}`, "aria-label": `Stage for ${entry.jobName}` } },
    ...STAGES.map(([stage, word]) => el("option", { text: word, attrs: { value: stage, ...(stage === entry.stage ? { selected: "" } : {}) } })),
  );
  const button = el("button", {
    className: "button secondary move",
    text: "Move",
    attrs: { type: "button", id: `move-submit-${entry.taskId}`, "aria-disabled": String(moving.has(entry.taskId)), "aria-describedby": `name-${entry.taskId}` },
  });
  button.onclick = (event) => void moveCard(entry.taskId, event.currentTarget);
  return el("div", { className: "move-row" }, select, button);
}

function renderCard(entry) {
  const meta = entry.latestVersion ? `Documents: version ${entry.latestVersion}` : "No documents yet";
  const children = [];
  if (entry.stage === "ready" && !entry.waiting) {
    const box = el("input", { attrs: { type: "checkbox", id: `pick-${entry.taskId}`, ...(picked.has(entry.taskId) ? { checked: "" } : {}) } });
    box.onchange = (event) => {
      if (event.currentTarget.checked) picked.add(entry.taskId);
      else picked.delete(entry.taskId);
      renderStart();
    };
    children.push(el("div", { className: "pick" }, box, el("label", { className: "card-name", text: entry.jobName, attrs: { for: `pick-${entry.taskId}`, id: `name-${entry.taskId}` } })));
  } else {
    children.push(el("p", { className: "card-name", text: entry.jobName, attrs: { id: `name-${entry.taskId}` } }));
  }
  children.push(el("p", { className: "card-meta muted small", text: meta }));
  if (entry.waiting) children.push(el("p", { className: "card-state muted small", attrs: { id: `waiting-${entry.taskId}` }, text: "Waiting to open in your browser." }));
  children.push(processingLine(entry));
  children.push(moveControls(entry));
  return el("li", { className: "board-card", attrs: { id: `card-${entry.taskId}` } }, ...children.filter(Boolean));
}

/** The column a card is in now, when it holds focus: a background refresh never moves it out from under the person. */
function heldColumn(taskId) {
  const card = $(`card-${taskId}`);
  if (!card || !holdsFocus(card)) return undefined;
  return card.closest("[data-stage]")?.getAttribute("data-stage") ?? undefined;
}

function renderBoard() {
  const key = JSON.stringify([board, [...moving]]);
  if (key === boardKey) return;
  boardKey = key;
  const columns = new Map(STAGES.map(([stage]) => [stage, []]));
  for (const entry of board.applications) {
    const stage = heldColumn(entry.taskId) ?? entry.stage;
    (columns.get(stage) ?? columns.get("saved")).push(entry);
  }
  const sections = STAGES.map(([stage, word]) => {
    const entries = columns.get(stage);
    return el(
      "section",
      { className: "stage", attrs: { id: `stage-${stage}`, "data-stage": stage, "aria-labelledby": `stage-title-${stage}` } },
      el("h3", { attrs: { id: `stage-title-${stage}`, tabindex: "-1" } }, word, " ", el("span", { className: "count muted", text: `(${entries.length})` })),
      entries.length > 0 ? el("ul", { className: "cards", attrs: { id: `cards-${stage}` } }, ...entries.map(renderCard)) : el("p", { className: "muted small", attrs: { id: `empty-${stage}` }, text: "None." }),
    );
  });
  keepInPlace(() => {
    morphChildren($("board"), sections);
    // A checkbox's checked state is the property, not the attribute a morph compares.
    for (const entry of board.applications) {
      const box = $(`pick-${entry.taskId}`);
      if (box) box.checked = picked.has(entry.taskId);
    }
  });
  const unreadable = $("board-unreadable");
  const damaged = board.unreadable.length;
  unreadable.hidden = damaged === 0;
  if (damaged > 0) {
    const text = damaged === 1 ? "One application's record can't be read, so it isn't on the board: " : `${damaged} application records can't be read, so they aren't on the board: `;
    morphChildren(unreadable, [document.createTextNode(text), ...board.unreadable.flatMap((entry, index) => [...(index > 0 ? [document.createTextNode(", ")] : []), el("code", { text: entry.path })]), document.createTextNode(".")]);
  }
}

// ---------------------------------------------------------------------------
// Starting a session
// ---------------------------------------------------------------------------

function chosenEntries() {
  return [...picked].map(entryOf).filter((entry) => entry && entry.stage === "ready" && !entry.waiting);
}

function renderStart() {
  const device = board?.device;
  const deviceLine = device?.paired
    ? `A session opens in the browser you paired on ${formatDay(device.pairedAt)}, when you start it from the extension there.`
    : "No browser is paired, so a session is written to `outbox/application-session.json` for the extension to import by hand. Pair one on the [Status](/ui/status) page.";
  morphNode($("start-device"), el("p", { className: "small", attrs: { id: "start-device" } }, ...renderPieces(deviceLine)));

  const chosen = chosenEntries();
  const line = chosen.length === 0 ? "Choose Ready applications below." : ["Chosen: ", data(namesPhrase(chosen.map((entry) => entry.jobName), 72)), "."];
  morphNode($("start-chosen"), el("p", { className: "small muted", attrs: { id: "start-chosen" } }, ...renderPieces(line)));
  $("start-submit").setAttribute("aria-disabled", String(starting || chosen.length === 0));

  const sync = $("start-sync");
  const notes = [];
  if (board?.review > 0) notes.push(`${plural(board.review, "browser result")} ${board.review === 1 ? "needs" : "need"} your review on the [Sessions](/ui/sessions) page.`);
  if (board?.unsynced > 0) notes.push(`Changes not yet synced: ${plural(board.unsynced, "change")} in \`inbox/\` ${board.unsynced === 1 ? "is" : "are"} waiting on the [Sessions](/ui/sessions) page.`);
  sync.hidden = notes.length === 0;
  morphChildren(sync, notes.length > 0 ? renderPieces(notes.join(" ")).map((node) => (typeof node === "string" ? document.createTextNode(node) : node)) : []);
}

/** Refusals, by the server's stable code, naming the application at fault. */
function startRefusal(error) {
  const name = entryOf(error?.taskId)?.jobName;
  switch (error?.code) {
    case "unreachable":
      return CANT_REACH;
    case "not_ready":
      return name ? withName("Not started: ", name, " isn't Ready any more.") : "Not started: an application isn't Ready any more.";
    case "no_documents":
      return name ? withName("Not started: ", name, " has no documents yet.") : "Not started: an application has no documents yet.";
    case "job_unreadable":
      return name ? withName("Not started: ", name, "'s saved posting can't be read.") : "Not started: a saved posting can't be read.";
    case "url_not_allowed":
      return name ? withName("Not started: ", name, "'s address isn't public https.") : "Not started: an address isn't public https.";
    case "already_waiting":
      return name ? withName("Not started: ", name, " is already waiting to open.") : "Not started: an application is already waiting to open.";
    case "application_not_found":
      return "Not started: an application isn't in the workspace any more.";
    case "too_many":
      return "Not started: a session opens at most 20 applications.";
    case "bad_title":
      return "Not started: give the session a name of at most 80 characters.";
    case "no_tasks":
      return "Not started: choose at least one Ready application.";
    default:
      return "Not started: the runner hit a problem; try again.";
  }
}

async function startSession() {
  const button = $("start-submit");
  if (button.getAttribute("aria-disabled") === "true") {
    if (!starting && chosenEntries().length === 0) lastAction("Not started: choose at least one Ready application.", "refused");
    return;
  }
  const chosen = chosenEntries();
  const title = $("start-name").value.replace(/\s+/g, " ").trim() || "Apply today";
  starting = true;
  button.setAttribute("aria-disabled", "true");
  workingAfterDelay("Starting…");
  let result;
  try {
    result = await postJson("/api/sessions", { taskIds: chosen.map((entry) => entry.taskId), title });
  } catch (error) {
    starting = false;
    lastAction(startRefusal(error), "refused");
    await refresh();
    return;
  }
  starting = false;
  for (const entry of chosen) picked.delete(entry.taskId);
  const count = plural(chosen.length, "application");
  lastAction(result.sent ? withName("Started ", title, `: ${count} waiting for your browser.`) : withName("Started ", title, ": it's in `outbox/` for the extension."), "done");
  await refresh();
}

$("start-form").addEventListener("submit", (event) => {
  event.preventDefault();
  $("start-submit").focus();
  void startSession();
});

// ---------------------------------------------------------------------------
// Moving a card
// ---------------------------------------------------------------------------

async function moveCard(taskId, button) {
  if (!button || button.getAttribute("aria-disabled") === "true") return;
  const entry = entryOf(taskId);
  const select = $(`move-${taskId}`);
  if (!entry || !select) return;
  const stage = select.value;
  if (stage === entry.stage) {
    lastAction(withName("", entry.jobName, ` is already in ${STAGE_WORDS[stage]}.`), "done");
    return;
  }
  button.focus();
  moving.add(taskId);
  button.setAttribute("aria-disabled", "true");
  workingAfterDelay("Moving…");
  let result;
  try {
    result = await postJson(`/api/applications/${taskId}/stage`, { stage, expectedRevision: entry.revision });
  } catch (error) {
    moving.delete(taskId);
    button.setAttribute("aria-disabled", "false");
    if (error?.code === "stale_revision") {
      // The card goes to where it is now, as the line says. A focused card is never moved by a render, so focus
      // first goes to its column's heading, a node no render replaces; then back to the card's Move button.
      const heading = button.closest("[data-stage]")?.querySelector("h3");
      heading?.focus({ preventScroll: true });
      lastAction(withName("Not moved: ", entry.jobName, " changed since; the board shows it as it is now."), "refused");
      await refresh();
      const again = $(`move-submit-${taskId}`);
      if (again && heading && document.activeElement === heading) again.focus();
      return;
    }
    lastAction(error?.code === "unreachable" ? CANT_REACH : withName("Not moved: ", entry.jobName, " couldn't be changed; try again."), "refused");
    await refresh();
    return;
  }
  moving.delete(taskId);
  lastAction(withName("Moved ", entry.jobName, ` to ${STAGE_WORDS[result.stage] ?? "its new stage"}.`), "done");
  // The card goes to its new column. Focus first goes to that column's heading, a node no render replaces, so the
  // old card can go; then to the card's Move button in its new place. It is never dropped to the page.
  $(`stage-title-${result.stage}`)?.focus({ preventScroll: true });
  await refresh();
  const moved = $(`move-submit-${taskId}`);
  if (moved && document.activeElement === $(`stage-title-${result.stage}`)) moved.focus();
}

// ---------------------------------------------------------------------------
// Loading and refreshing
// ---------------------------------------------------------------------------

async function load({ first = false } = {}) {
  let next;
  let nextBudget = null;
  try {
    [next, nextBudget] = await Promise.all([getJson("/api/applications/board"), getJson("/api/runs/budget").catch((error) => (error?.code === "unreachable" ? Promise.reject(error) : null))]);
  } catch (error) {
    if (first) {
      morphChildren($("board"), [el("p", { className: "muted", text: "The board couldn't load." })]);
      $("runs-line").textContent = "";
    }
    if (!unreachableShown && (first || board)) {
      unreachableShown = true;
      lastAction(error?.code === "unreachable" ? CANT_REACH : "Couldn't load the board; reload the page to try again.", "refused");
    }
    return false;
  }
  board = next;
  budget = nextBudget;
  for (const taskId of [...picked]) {
    const entry = entryOf(taskId);
    if (!entry || entry.stage !== "ready" || entry.waiting) picked.delete(taskId);
  }
  renderBudget();
  renderBoard();
  renderStart();
  if (unreachableShown) {
    unreachableShown = false;
    lastAction("Reached the runner again.", "done");
  }
  return true;
}

let refreshTimer = null;
let chain = Promise.resolve();

function schedule() {
  clearTimeout(refreshTimer);
  refreshTimer = null;
  if (document.visibilityState === "hidden") return;
  refreshTimer = setTimeout(() => void refresh(), REFRESH_MS);
}

function refresh(options = {}) {
  const run = async () => {
    clearTimeout(refreshTimer);
    try {
      await load(options);
    } finally {
      schedule();
    }
  };
  chain = chain.then(run, run);
  return chain;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  } else {
    void refresh();
  }
});

trackLastActionHeight();
void refresh({ first: true });
