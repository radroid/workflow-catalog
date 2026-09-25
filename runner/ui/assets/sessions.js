/* global document, window, fetch, requestAnimationFrame, ResizeObserver, setTimeout, clearTimeout, AbortController */
// The Sessions page (P06, mvp-spec F9): each session's manifest items, its command's state, what the browser
// reported per tab, the person's choices, the results flagged for review, and the file bridge's manual
// reconciliation view (outbox/ and inbox/, with "Changes not yet synced"). Talks to server/routes/sessions.ts.
//
// House rules (runner/ui/assets/board.js, application.js and jobs.js, copied rather than shared): one live
// region, each outcome announced once and whole; a focused node is never replaced; aria-disabled while a
// request is in flight; no field name, status code or id in visible text; amber for nothing here, since
// nothing on this page waits on a decision only the person's answer can make.
import { el } from "./runner.js";

const $ = (id) => document.getElementById(id);

const NAMED_LINE_MAX = 80;
const REFRESH_MS = 5_000;
/** A runner that hangs rather than stops is noticed: a request unanswered this long counts as "can't reach". */
export const REQUEST_TIMEOUT_MS = 15_000;
const CANT_REACH = "Can't reach the runner. Is it still running?";

const STAGE_WORDS = {
  saved: "Saved",
  preparing: "Preparing",
  ready: "Ready",
  applied: "Applied",
  interviewing: "Interviewing",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};
const TAB_WORDS = { opened: "tab opened", failed: "didn't open", skipped: "skipped", closed: "tab closed" };
const CHOICE_WORDS = { applied: "you chose Applied", deferred: "you chose Defer" };

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor({ code, status } = {}) {
    super(code ?? "request_failed");
    this.code = code;
    this.status = status;
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
  if (!response.ok) throw new ApiError({ code: data?.error?.code, status: response.status });
  return data;
}

const getJson = (path) => api("GET", path);
const postJson = (path, body) => api("POST", path, body ?? {});

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Messages
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

function shorten(text, max) {
  const line = String(text).replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  const base = space >= Math.floor(max / 2) ? cut.slice(0, space) : cut;
  return `${base.replace(/[\s·,;:–—-]+$/u, "")}…`;
}

function withName(before, name, after) {
  const room = Math.max(16, NAMED_LINE_MAX - plainOf(before).length - plainOf(after).length - 2);
  return [before, data(`“${shorten(name, room)}”`), after];
}

/** A name in quotes, whole, for the page's own lines (not the clamped live line). */
function named(name) {
  return data(`“${name}”`);
}

function namesList(names) {
  const quoted = names.map(named);
  return quoted.flatMap((piece, index) => [...(index === 0 ? [] : [index === quoted.length - 1 ? " and " : ", "]), piece]);
}

function formatWhen(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// ---------------------------------------------------------------------------
// The "Last action" line and rendering in place (as board.js)
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

/** Announces one outcome, once, whole: the same text twice is cleared first, tag and text together. */
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

const HANDLERS = ["onclick"];

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

function textNodes(nodes) {
  return nodes.map((node) => (typeof node === "string" ? document.createTextNode(node) : node));
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

function flagMessage(flag) {
  const name = flag.jobName;
  switch (flag.kind) {
    case "failed":
      return "Your browser couldn't open this session.";
    case "partial":
      return "Your browser opened only part of this session.";
    case "item_failed":
      return [named(name ?? "An application"), " didn't open in your browser."];
    case "item_skipped":
      return ["Your browser skipped ", named(name ?? "an application"), "."];
    case "closed":
      return [named(name ?? "An application"), "'s tab was closed without Applied or Defer. Nothing changed; if you applied, move it on the [Board](/ui/board)."];
    case "missing":
      return ["Your browser didn't say what happened to ", named(name ?? "an application"), "."];
    case "unknown_task":
      return "Your browser reported an application that isn't in this session. Nothing was recorded for it.";
    case "conflict":
      return ["Your browser gave two different answers for ", named(name ?? "an application"), "'s tab, so neither was recorded."];
    default:
      return "Your browser reported something the runner doesn't know, so nothing was recorded.";
  }
}

function deliveryMessage(session) {
  switch (session.delivery) {
    case "file":
      return session.outboxAt
        ? `No browser was paired, so it went to \`outbox/application-session.json\` (${formatWhen(session.outboxAt)}) for the extension to import.`
        : "No browser was paired: write it to the outbox for the extension to import.";
    case "missing":
      return "It never reached the queue for your browser. Write it to the outbox to import it by hand.";
    case "waiting":
      return `Waiting for your browser to pick it up. It expires ${formatWhen(session.expiresAt)}.`;
    case "delivered":
      return "Your browser has it; waiting for its report.";
    case "reported":
      return "Your browser reported on it.";
    case "expired":
      return "It expired before your browser picked it up. Start a new session on the [Board](/ui/board).";
    case "expired_taken":
      return session.reported
        ? "Your browser reported on it."
        : "Your browser took it but never said what it opened. Check its tabs, then choose Applied or Defer in the side panel, or move them on the [Board](/ui/board).";
    default:
      return "";
  }
}

function itemLine(item) {
  const facts = [STAGE_WORDS[item.stage] ?? "not in the workspace", item.tab ? TAB_WORDS[item.tab] : "no report yet", ...(item.choice ? [CHOICE_WORDS[item.choice]] : [])];
  return el("li", { attrs: { id: `item-${item.taskId}` } }, ...renderPieces([named(item.jobName), ` · ${facts.join(" · ")}`]));
}

const PLAN_WORDS = {
  apply: "will be imported",
  already: "already in the workspace",
  not_here: "a captured job: this page imports session results only",
};

const REFUSED_WORDS = {
  stale_revision: "not imported: the application changed since that choice",
  stage_moved_on: "not imported: it has moved past Applied",
  task_not_in_session: "not imported: it isn't in any session",
  application_not_found: "not imported: no such application",
  unknown_command: "not imported: the runner never sent that session",
  unknown_session: "not imported: the runner has no such session",
  command_expired: "not imported: that session had expired",
  command_not_for_device: "not imported: that session went to another browser",
};

function eventLine(event, index, fileIndex) {
  const plan = event.plan === "refused" ? (REFUSED_WORDS[event.code] ?? "not imported") : PLAN_WORDS[event.plan];
  let what;
  if (event.type === "application_status_changed") what = [event.status === "applied" ? "Applied: " : "Defer: ", ...namesList(event.jobNames)];
  else if (event.type === "browser_command_result") what = ["Tab report for ", ...namesList(event.jobNames)];
  else what = ["A captured job"];
  return el("li", { className: `event ${event.plan}`, attrs: { id: `event-${fileIndex}-${index}` } }, ...renderPieces([...what, ` — ${plan}.`]));
}

function fileLead(file) {
  switch (file.kind) {
    case "session":
      return file.session?.known ? ["A session manifest the runner wrote (", named(file.session.title), "): nothing to import."] : "A session manifest from another workspace: nothing to import.";
    case "too_large":
      return "Too large to read (over 256 KB), so it wasn't opened.";
    case "unreadable":
      return "Not readable as JSON.";
    case "unknown":
      return "Not a file this page imports.";
    default: {
      const waiting = file.events.filter((event) => event.plan === "apply").length;
      const done = file.importedAt ? ` Imported ${formatWhen(file.importedAt)}.` : "";
      return `${plural(file.events.length, "event")}; ${waiting === 0 ? "nothing left to import" : `${waiting} to import`}.${done}${file.skipped > 0 ? ` ${plural(file.skipped, "entry", "entries")} aren't events this page reads.` : ""}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let view = null;
let viewKey = "";
const busy = new Set();
let unreachableShown = false;

function button(id, text, onclick, { secondary = true } = {}) {
  const node = el("button", { className: secondary ? "button secondary" : "button", text, attrs: { type: "button", id, "aria-disabled": String(busy.has(id)) } });
  node.onclick = (event) => void onclick(event.currentTarget);
  return node;
}

function renderReview() {
  const items = [];
  for (const session of view.sessions) {
    for (const flag of session.flags) {
      if (flag.reviewed) continue;
      items.push(
        el(
          "li",
          { className: "review-item", attrs: { id: `flag-${flag.flagId}` } },
          el("p", { className: "review-text" }, ...renderPieces(flagMessage(flag))),
          el("p", { className: "muted small" }, ...renderPieces(["In ", named(session.title), `, reported ${formatWhen(flag.at)}.`])),
          button(`review-${flag.flagId}`, "Mark as reviewed", (node) => reviewFlag(session, flag, node)),
        ),
      );
    }
  }
  if (items.length === 0) items.push(el("li", { className: "muted", attrs: { id: "review-none" }, text: "Nothing needs your review." }));
  morphChildren($("review-list"), items);
}

function renderSessions() {
  if (view.sessions.length === 0) {
    morphChildren($("sessions-list"), [el("p", { className: "muted", attrs: { id: "sessions-none" } }, ...textNodes(renderPieces("No sessions yet. Choose Ready applications on the [Board](/ui/board) and start one.")))]);
    return;
  }
  const articles = view.sessions.map((session) =>
    el(
      "article",
      { className: "session", attrs: { id: `session-${session.sessionId}`, "aria-labelledby": `session-title-${session.sessionId}` } },
      el("h3", { attrs: { id: `session-title-${session.sessionId}` } }, named(session.title).data),
      el("p", { className: "muted small" }, `Started ${formatWhen(session.createdAt)} · ${plural(session.items.length, "application")} · `, el("span", { attrs: { title: `Session ${session.sessionId}` }, text: `session ${session.shortId}` })),
      el("p", { className: `delivery small ${session.delivery}` }, ...renderPieces(deliveryMessage(session))),
      el("ul", { className: "items" }, ...session.items.map(itemLine)),
      el("div", { className: "session-actions" }, button(`outbox-${session.sessionId}`, "Write to outbox", (node) => writeOutbox(session, node))),
    ),
  );
  const unreadable = view.unreadable.length > 0 ? [el("p", { className: "unreadable small", attrs: { id: "sessions-unreadable" } }, "These session records can't be read, so they aren't listed: ", ...view.unreadable.flatMap((entry, index) => [...(index > 0 ? [", "] : []), el("code", { text: entry.path })]), ".")] : [];
  morphChildren($("sessions-list"), [...articles, ...unreadable]);
}

function renderFiles() {
  const sync =
    view.unsynced > 0
      ? `Changes not yet synced: ${plural(view.unsynced, "change")} in \`inbox/\` ${view.unsynced === 1 ? "hasn't" : "haven't"} been imported.`
      : "Everything in `inbox/` is imported: nothing waits to be synced.";
  morphNode($("sync-line"), el("p", { className: `sync-line${view.unsynced > 0 ? " waiting" : ""}`, attrs: { id: "sync-line" } }, ...renderPieces(sync)));

  const outbox = view.outbox;
  let outboxLine;
  if (!outbox.present) outboxLine = "`outbox/application-session.json` is empty. A session goes there when no browser is paired, or when you write it there.";
  else if (!outbox.readable) outboxLine = "`outbox/application-session.json` can't be read as a session.";
  else outboxLine = ["`outbox/application-session.json` holds ", named(outbox.session.title), ` (${plural(outbox.session.items, "application")}, started ${formatWhen(outbox.session.createdAt)})${outbox.session.known ? "" : ", a session this workspace doesn't have"}.`];
  morphNode($("outbox-line"), el("p", { className: "small", attrs: { id: "outbox-line" } }, ...renderPieces(outboxLine)));

  const files = view.inbox.files.map((file, fileIndex) => {
    const importable = file.kind === "events" && file.events.some((event) => event.plan === "apply");
    return el(
      "li",
      { className: "inbox-file", attrs: { id: `inbox-${fileIndex}` } },
      el("p", {}, el("code", { text: `inbox/${file.name}` })),
      el("p", { className: "small muted" }, ...renderPieces(fileLead(file))),
      file.events.length > 0 ? el("ul", { className: "events small" }, ...file.events.map((event, index) => eventLine(event, index, fileIndex))) : null,
      importable ? button(`import-${fileIndex}`, "Import", (node) => importFile(file, node), { secondary: false }) : null,
    );
  });
  if (files.length === 0) files.push(el("li", { className: "muted small", attrs: { id: "inbox-none" } }, ...textNodes(renderPieces("`inbox/` is empty. Put a results file the extension exported there, then import it here."))));
  if (view.inbox.more > 0) files.push(el("li", { className: "muted small", attrs: { id: "inbox-more" }, text: `${plural(view.inbox.more, "more file")} not shown.` }));
  morphChildren($("inbox-list"), files);
}

function render() {
  const key = JSON.stringify([view, [...busy]]);
  if (key === viewKey) return;
  viewKey = key;
  keepInPlace(() => {
    renderReview();
    renderSessions();
    renderFiles();
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function act(id, node, work) {
  if (!node || node.getAttribute("aria-disabled") === "true") return;
  node.focus();
  busy.add(id);
  node.setAttribute("aria-disabled", "true");
  workingAfterDelay("Saving…");
  try {
    await work();
  } finally {
    busy.delete(id);
    if (node.isConnected) node.setAttribute("aria-disabled", "false");
    viewKey = "";
  }
}

async function reviewFlag(session, flag, node) {
  // The item leaves the list once reviewed: focus goes first to the section's heading, a node no render replaces.
  await act(`review-${flag.flagId}`, node, async () => {
    try {
      const result = await postJson(`/api/sessions/${session.sessionId}/flags/${flag.flagId}/review`);
      $("review-title").focus({ preventScroll: true });
      view = result.view;
      lastAction(flag.jobName ? withName("Reviewed ", flag.jobName, "'s result.") : withName("Reviewed a result in ", session.title, "."), "done");
    } catch (error) {
      lastAction(error?.code === "unreachable" ? CANT_REACH : "Not saved: the runner hit a problem; try again.", "refused");
    }
  });
  render();
}

async function writeOutbox(session, node) {
  await act(`outbox-${session.sessionId}`, node, async () => {
    try {
      const result = await postJson(`/api/sessions/${session.sessionId}/outbox`);
      view = result.view;
      lastAction(withName("Wrote ", session.title, " to `outbox/application-session.json`."), "done");
    } catch (error) {
      lastAction(error?.code === "unreachable" ? CANT_REACH : "Not written: the runner hit a problem; try again.", "refused");
    }
  });
  render();
}

async function importFile(file, node) {
  await act(node?.id ?? "import", node, async () => {
    try {
      const result = await postJson("/api/sessions/inbox/import", { name: file.name });
      $("files-title").focus({ preventScroll: true });
      view = result.view;
      const parts = [`${result.applied} imported`, ...(result.already > 0 ? [`${result.already} already here`] : []), ...(result.refused > 0 ? [`${result.refused} not imported`] : [])];
      lastAction(withName("Imported ", file.name, `: ${parts.join(", ")}.`), result.refused > 0 && result.applied === 0 ? "refused" : "done");
    } catch (error) {
      lastAction(error?.code === "unreachable" ? CANT_REACH : error?.code === "not_found" ? withName("Not imported: ", file.name, " isn't in inbox/ any more.") : "Not imported: the runner hit a problem; try again.", "refused");
    }
  });
  render();
}

// ---------------------------------------------------------------------------
// Loading and refreshing
// ---------------------------------------------------------------------------

async function load({ first = false } = {}) {
  let next;
  try {
    next = await getJson("/api/sessions");
  } catch (error) {
    if (first) {
      morphChildren($("sessions-list"), [el("p", { className: "muted", text: "The sessions couldn't load." })]);
      morphChildren($("review-list"), []);
      $("sync-line").textContent = "";
    }
    if (!unreachableShown && (first || view)) {
      unreachableShown = true;
      lastAction(error?.code === "unreachable" ? CANT_REACH : "Couldn't load the sessions; reload the page to try again.", "refused");
    }
    return;
  }
  view = next;
  render();
  if (unreachableShown) {
    unreachableShown = false;
    lastAction("Reached the runner again.", "done");
  }
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

// The section headings take focus when the item a person acted on leaves the page.
for (const id of ["review-title", "files-title"]) $(id).setAttribute("tabindex", "-1");

trackLastActionHeight();
void refresh({ first: true });
