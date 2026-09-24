/* global document, window, fetch, requestAnimationFrame, URL, ResizeObserver, setTimeout, clearTimeout, TextEncoder */
// The Jobs page (P04): capture a posting from the extension, a paste, or an
// https:// fetch; see every job and its revision history; run extraction
// again on a revision. Talks to server/routes/captures.ts.
//
// House rules (P03's J4-J6 in logs/handoff/P03-round-3-review.md; P04's L12
// and T11-T19 in logs/handoff/P04-round-1-review.md and -round-2-review.md):
// - One sticky "Last action" line is the page's only live region. Each
//   outcome is announced once, as one sentence of about 90 characters or
//   fewer, consequence first. Reasons and next steps live in the job's detail.
// - A focused node is never replaced (morphChildren/morphNode), a refresh
//   never moves it on screen (keepInPlace), and an open diff or posting text
//   stays open.
// - "Saving…", "Fetching…" and "Extracting…" appear only after about 300 ms.
// - A refusal about what was typed sits on its field (aria-invalid and
//   aria-describedby). Anything else (the runner unreachable, a server error,
//   a page that couldn't be fetched) goes in the line only.
// - The page refreshes itself while it is visible: every 2 s while an
//   extraction is waiting or running, every 5 s otherwise. It announces only
//   the results of extractions it started.
//
// Only `el` comes from runner.js: its getJson/postJson throw the server's own
// message, which names fields for API consumers. This page never shows a
// field name, a status code or an id, so every refusal below is a
// hand-written sentence chosen by the server's stable error `code`.
import { el } from "./runner.js";

const $ = (id) => document.getElementById(id);

/**
 * T18: a line that names a job is fitted to 80 characters, so it stays within the two-line clamp at 390 px. Measured
 * in Chromium with Geist at 390 px, realistic job names fit at 80 and 85; at 90, 9 of 24 did not. The fixed sentences
 * are 88 characters at most, and every one of them fits.
 */
const NAMED_LINE_MAX = 80;
/** @workflow-catalog/contracts' MAX_JOB_CAPTURE_TEXT_BYTES; the browser can't import that package. */
const MAX_CAPTURE_TEXT_BYTES = 200_000;
const FAST_REFRESH_MS = 2_000;
const SLOW_REFRESH_MS = 5_000;
const CANT_REACH = "Can't reach the runner. Is it still running?";
const SETTINGS_LINK = "[Settings](/ui/settings#budget-section)";

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
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError({ code: "unreachable" });
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // not JSON
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

/** The contract's own measure (utf8BoundedTextSchema): UTF-8 bytes of the JSON-encoded text, quotes included (T13). */
function captureTextBytes(text) {
  return new TextEncoder().encode(JSON.stringify(text)).length;
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Messages. A message is a hand-written string, or a list of pieces:
// hand-written strings, where `code` spans and [label](/path) links are
// rendered, and data(...) values, such as a job's name taken from its own
// posting, which are always plain text and never parsed. So no posting can
// put markup or a link on the page.
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
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** `before“name”after`, with the name shortened so the whole sentence fits the line (T18). */
function withName(before, name, after) {
  const room = Math.max(16, NAMED_LINE_MAX - plainOf(before).length - plainOf(after).length - 2);
  return [before, data(`“${shorten(name, room)}”`), after];
}

// ---------------------------------------------------------------------------
// The sticky "Last action" line (P03's J4-J5): one live region, kept clear of
// a focused control (keepClear) and where it is on screen when the page
// changes around it (keepInPlace).
// ---------------------------------------------------------------------------

const TAGS = { done: "Last action", refused: "Refused", working: "Working" };

/** Runs `change`, then scrolls so the focused control is where it was on screen: nothing shifts under it (J6.6, T16). */
function keepInPlace(change) {
  const node = document.activeElement;
  const top = node && node !== document.body ? node.getBoundingClientRect().top : null;
  change();
  if (top === null || document.activeElement !== node || !node.isConnected) return;
  const moved = node.getBoundingClientRect().top - top;
  if (Math.abs(moved) >= 1) window.scrollBy(0, moved);
}

let working = null; // the timer that shows "Saving…"/"Fetching…"/"Extracting…" (J6.1)

function stopWorking() {
  if (working) clearTimeout(working);
  working = null;
}

/** Announces one outcome, once. The same text twice in a row is cleared first, so it is announced again. */
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
      text.title = plain; // the whole sentence for a pointer, where the line is clamped at 640 px
    });
  if (text.textContent === plain && tag.textContent === TAGS[tone]) {
    keepInPlace(() => {
      text.textContent = "";
    });
    requestAnimationFrame(apply);
  } else {
    apply();
  }
}

/** J6.1: the busy word appears only once a request has taken about 300 ms, so a quick one never flashes it. */
function workingAfterDelay(message) {
  stopWorking();
  working = setTimeout(() => {
    working = null;
    lastAction(message, "working");
  }, 300);
}

/** Keeps --last-action-offset at the line's real height, for scroll-padding-top. */
function trackLastActionHeight() {
  const node = $("last-action");
  const update = () => document.documentElement.style.setProperty("--last-action-offset", `${Math.ceil(node.getBoundingClientRect().height) + 16}px`);
  if (typeof ResizeObserver === "function") new ResizeObserver(update).observe(node);
  update();
}

/** Scrolls `node` fully clear of the sticky line: its top below the line, and its bottom in view when it fits. */
function keepClear(node) {
  // Duck-typed, not `instanceof HTMLElement`: happy-dom's test window (runner/test/jobs-page.test.ts) does not put
  // HTMLElement on globalThis.
  if (!node || typeof node.getBoundingClientRect !== "function" || !node.isConnected) return;
  const top = $("last-action").getBoundingClientRect().bottom + 8;
  const rect = node.getBoundingClientRect();
  if (rect.top < top || rect.height > window.innerHeight - top) window.scrollBy(0, rect.top - top);
  else if (rect.bottom > window.innerHeight) window.scrollBy(0, rect.bottom - window.innerHeight + 8);
}

/** T19: brings `node` to just under the line, as it sits once stuck to the top of the viewport. */
function scrollUnderLine(node) {
  if (!node?.isConnected) return;
  const target = $("last-action").getBoundingClientRect().height + 12;
  const delta = node.getBoundingClientRect().top - target;
  if (Math.abs(delta) >= 1) window.scrollBy(0, delta);
}

let pointerAt = -Infinity;
document.addEventListener("pointerdown", () => (pointerAt = Date.now()), true);
document.addEventListener("focusin", (event) => {
  if (Date.now() - pointerAt < 500) return;
  const node = event.target;
  requestAnimationFrame(() => {
    if (document.activeElement === node) keepClear(node);
  });
});

// ---------------------------------------------------------------------------
// Rendering in place (J4): a re-render never replaces a node that holds
// focus, so the control a person is using keeps it.
// ---------------------------------------------------------------------------

const HANDLERS = ["onclick", "oninput", "onchange", "ontoggle"];

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
    if (used.has(old) || holdsFocus(old)) continue; // a focused node no longer wanted is left in place, never torn out from under the person
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

/** Whether the live element with `id` is open right now: a refresh renders it the same way (T16). */
function isOpenNow(id) {
  return $(id)?.open === true;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** The URL's own path, for a job with no title and no readable first line: never the bare hostname. */
function urlPathName(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
    return path || parsed.hostname;
  } catch {
    return undefined;
  }
}

function firstNonEmptyLine(text) {
  return (text ?? "").split("\n").find((line) => line.trim() !== "")?.trim();
}

/** Title and company when extracted; else the posting's own first non-empty line (about 80 characters); else the URL's path. */
function jobDisplayName(snapshot) {
  const structured = snapshot.structured ?? {};
  if (structured.title && structured.company) return `${structured.title} · ${structured.company}`;
  if (structured.title) return structured.title;
  const line = firstNonEmptyLine(snapshot.text);
  if (line) return shorten(line, 80);
  return urlPathName(snapshot.url) ?? "Untitled posting";
}

const UNREADABLE_JOB_NAME = "A saved job that can't be read";

/** A list entry's name. T6: a job whose latest revision can't be read is named by the address a readable revision records. */
function entryName(entry) {
  if (entry.latest) return jobDisplayName(entry.latest);
  if (entry.url) return urlPathName(entry.url) ?? entry.url;
  return UNREADABLE_JOB_NAME;
}

function formatJobTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** `deadline` is a calendar date (YYYY-MM-DD), formatted in UTC so no timezone shifts it a day. */
function formatDeadline(dateOnly) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return dateOnly;
  const date = new Date(`${dateOnly}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return dateOnly;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeZone: "UTC" }).format(date);
}

/** A link that opens in a new tab says so, for anyone not looking at the tab bar. */
function newTabSuffix() {
  return el("span", { className: "visually-hidden", text: " (opens in a new tab)" });
}

// ---------------------------------------------------------------------------
// Line diff: the "posting changed" view between two revisions of one job. A
// plain line-based LCS (postings are plain text, and this is a diff to look
// at, not a merge tool), capped so a very long posting never hangs the tab.
// Revisions never change, so each pair's rows are computed once (T16).
// ---------------------------------------------------------------------------

const DIFF_CELL_CAP = 4_000_000;
const DIFF_CONTEXT = 2;
const DIFFS = new Map();

function diffLines(oldText, newText) {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  if (n * m > DIFF_CELL_CAP) return undefined;
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i += 1) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: "same", text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ kind: "removed", text: a[i] });
      i += 1;
    } else {
      rows.push({ kind: "added", text: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    rows.push({ kind: "removed", text: a[i] });
    i += 1;
  }
  while (j < m) {
    rows.push({ kind: "added", text: b[j] });
    j += 1;
  }
  return rows;
}

/** Collapses a long run of unchanged lines to a short marker, keeping a little context around each change. */
function collapseUnchanged(rows) {
  const out = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== "same") {
      out.push(rows[i]);
      i += 1;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].kind === "same") j += 1;
    const length = j - i;
    if (length <= DIFF_CONTEXT * 2 + 1) {
      for (let k = i; k < j; k += 1) out.push(rows[k]);
    } else {
      for (let k = i; k < i + DIFF_CONTEXT; k += 1) out.push(rows[k]);
      out.push({ kind: "skip", count: length - DIFF_CONTEXT * 2 });
      for (let k = j - DIFF_CONTEXT; k < j; k += 1) out.push(rows[k]);
    }
    i = j;
  }
  return out;
}

function diffRowsFor(jobId, previous, revision) {
  const key = `${jobId}:${previous.revision}:${revision.revision}`;
  if (!DIFFS.has(key)) DIFFS.set(key, previous.text === revision.text ? "same" : (diffLines(previous.text, revision.text) ?? "too-long"));
  return DIFFS.get(key);
}

/**
 * One diff line (L12 item 9, T19): a grid of a two-character marker column
 * and the text, on every line, unchanged ones included, so wrapped and
 * unchanged lines line up with the changed text. A visually hidden
 * "Added:"/"Removed:" prefix carries the change to a screen reader; the
 * "+"/"−" marker is aria-hidden, and a removed line's strikethrough applies
 * only to its text.
 */
function diffLine(kind, text) {
  const prefix = kind === "added" ? "Added: " : kind === "removed" ? "Removed: " : "";
  const marker = kind === "added" ? "+" : kind === "removed" ? "−" : "";
  return el(
    "div",
    { className: `diff-line ${kind}` },
    prefix ? el("span", { className: "visually-hidden", text: prefix }) : null,
    el("span", { className: "diff-marker", attrs: { "aria-hidden": "true" }, text: marker }),
    el("span", { className: "diff-text", text }),
  );
}

function renderDiff(jobId, previous, revision) {
  const rows = diffRowsFor(jobId, previous, revision);
  if (rows === "same") return el("p", { className: "muted small diff-note", text: "The text did not change." });
  if (rows === "too-long") return el("p", { className: "muted small diff-note", text: "This posting is too long to show a line-by-line diff." });
  const container = el("div", { className: "diff" });
  for (const row of collapseUnchanged(rows)) {
    container.append(row.kind === "skip" ? el("div", { className: "diff-skip", text: `⋯ ${plural(row.count, "unchanged line")} ⋯` }) : diffLine(row.kind, row.text));
  }
  return container;
}

// ---------------------------------------------------------------------------
// Structured fields and extraction state
// ---------------------------------------------------------------------------

const STRUCTURED_LABELS = [
  ["title", "Title"],
  ["company", "Company"],
  ["location", "Location"],
  ["requirements", "Requirements"],
  ["niceToHave", "Nice to have"],
  ["deadline", "Deadline"],
  ["applyUrl", "Apply link"],
];

function hasStructuredFields(structured) {
  return Boolean(structured) && Object.keys(structured).length > 0;
}

function renderStructured(structured) {
  if (!hasStructuredFields(structured)) return el("p", { className: "muted small", text: "Not extracted yet." });
  const dl = el("dl", { className: "structured-fields" });
  for (const [key, label] of STRUCTURED_LABELS) {
    const value = structured[key];
    if (value === undefined) continue;
    const dd = el("dd", {});
    if (Array.isArray(value)) {
      const ul = el("ul", { className: "structured-list" });
      for (const item of value) ul.append(el("li", { text: item }));
      dd.append(ul);
    } else if (key === "applyUrl") {
      dd.append(el("a", { attrs: { href: value, target: "_blank", rel: "noopener noreferrer" } }, el("code", { text: value }), newTabSuffix()));
    } else if (key === "deadline") {
      dd.append(el("span", { text: formatDeadline(value) }));
    } else {
      dd.append(el("span", { text: value }));
    }
    dl.append(el("dt", { text: label }), dd);
  }
  return dl;
}

function isBusy(extraction) {
  return extraction?.status === "waiting" || extraction?.status === "running";
}

function isSettledFailure(extraction) {
  return extraction?.status === "not_run" || extraction?.status === "failed";
}

function isPasted(snapshot) {
  return /^paste@/.test(snapshot?.extractorVersion ?? "");
}

/** A stable reason code (store/jobs.ts) as a plain sentence with the real next step (L12 item 4, T12). */
function extractionReason(extraction, snapshot) {
  switch (extraction.reason) {
    case "runner_not_running":
      return "The runner isn't running, so this can't be extracted yet. Start it with `npm run runner`, then try again.";
    case "no_model":
      return "No model is configured. Run `npm run setup` in `runner/`, then try again.";
    case "budget_paused":
      return `The budget is paused, so nothing was extracted. Resume it in ${SETTINGS_LINK}, then try again.`;
    case "provider_limit":
      return `The model provider's rate limit stopped this, and the budget is now paused. Resume it in ${SETTINGS_LINK}, then try again.`;
    case "timed_out":
      return "Extraction took too long and was stopped. Try again.";
    case "no_fields_found":
      return isPasted(snapshot) ? "The runner didn't find any fields in this posting. Try again." : "The runner didn't find any fields in this posting. Try again, or paste the text directly.";
    case "unreadable":
      return "This revision's saved file couldn't be read, so nothing was extracted.";
    case "interrupted":
      return "Extraction was interrupted before it finished. Try again.";
    default:
      return "Extraction didn't finish. Try again.";
  }
}

/** What the detail says about a revision's extraction, beside its fields; undefined when there is nothing to add. */
function extractionDetail(extraction, snapshot) {
  if (!extraction || extraction.status === "done") return undefined;
  if (extraction.status === "waiting") return { tone: "muted", message: "Waiting to extract…" };
  if (extraction.status === "running") return { tone: "muted", message: "Extracting in the background…" };
  const reason = extractionReason(extraction, snapshot);
  return { tone: "refused", message: hasStructuredFields(snapshot.structured) ? `${reason} The fields already saved were kept.` : reason };
}

// ---------------------------------------------------------------------------
// Jobs list
// ---------------------------------------------------------------------------

let jobsById = new Map();
let openJobId;
let listSeq = 0;
let listShown = 0;
let listKey = "";

/** A row's own status lines: a damaged file (T6), and an extraction still going or not done (T11). */
function rowStatus(entry) {
  const lines = [];
  if (entry.unreadable.length > 0) {
    const [newest] = entry.unreadable;
    const more = entry.unreadable.length - 1;
    lines.push(el("p", { className: "job-status refused small" }, `Revision ${newest.revision} can't be read: `, el("code", { text: newest.path }), more > 0 ? ` (and ${plural(more, "earlier revision")})` : ""));
  }
  const extraction = entry.extraction;
  if (isBusy(extraction)) {
    lines.push(el("p", { className: "job-status muted small", text: extraction.status === "running" ? "Extracting…" : "Waiting to extract…" }));
  } else if (isSettledFailure(extraction) && entry.latest) {
    const text = hasStructuredFields(entry.latest.structured) ? "The last extraction didn't finish. Open it to see why." : "Not extracted yet. Open it to see why.";
    lines.push(el("p", { className: "job-status muted small", text }));
  }
  return lines;
}

function renderJobRow(entry) {
  const isOpen = entry.jobId === openJobId;
  const button = el("button", { className: "job-open", text: entryName(entry), attrs: { type: "button", ...(isOpen ? { "aria-current": "true" } : {}) } });
  button.onclick = () => openJob(entry.jobId);
  const url = entry.latest?.url ?? entry.url;
  const savedAt = entry.latest?.capturedAt ?? entry.savedAt;
  const facts = [plural(entry.revisionCount, "revision"), ...(savedAt ? [`saved ${formatJobTime(savedAt)}`] : [])].join(" · ");
  const meta = el("p", { className: "muted small job-meta" }, url ? el("code", { text: hostnameOf(url) ?? url }) : null, url ? ` · ${facts}` : facts);
  return el("li", { className: `job-row${isOpen ? " open" : ""}`, attrs: { id: `job-row-${entry.jobId}` } }, button, meta, ...rowStatus(entry));
}

/** Renders the list in place, and only when something in it changed (T16). */
function renderList() {
  const jobs = [...jobsById.values()];
  const key = JSON.stringify([openJobId ?? null, jobs]);
  if (key === listKey) return;
  listKey = key;
  const list = $("jobs-list");
  keepInPlace(() => {
    $("jobs-empty").hidden = jobs.length > 0;
    list.hidden = jobs.length === 0;
    morphChildren(list, jobs.map(renderJobRow));
  });
}

async function loadJobs({ announceErrors = false } = {}) {
  const seq = (listSeq += 1);
  let jobs;
  try {
    ({ jobs } = await getJson("/api/captures"));
  } catch (error) {
    if (!announceErrors) return; // a background refresh failing is nobody's action to announce; the next one tries again
    keepInPlace(() => {
      morphChildren($("jobs-list"), []);
      $("jobs-list").hidden = true;
      $("jobs-empty").hidden = true;
    });
    lastAction(error?.code === "unreachable" ? CANT_REACH : "Couldn't load the saved jobs; reload the page to try again.", "refused");
    return;
  }
  if (seq < listShown) return; // an older answer than the one already on screen
  listShown = seq;
  jobsById = new Map(jobs.map((entry) => [entry.jobId, entry]));
  renderList();
}

// ---------------------------------------------------------------------------
// Job detail: revisions, structured fields, the "posting changed" diff
// ---------------------------------------------------------------------------

let openDetail;
let openRequestToken = 0;
let detailSeq = 0;
let detailShown = 0;
let detailKey = "";

function renderRevision(jobId, revision, previous) {
  const card = el(
    "li",
    { className: "revision-card", attrs: { id: `revision-${jobId}-${revision.revision}` } },
    el(
      "p",
      { className: "revision-head" },
      el("span", { className: "revision-number", text: `Revision ${revision.revision}` }),
      el("span", { className: "muted small", text: ` · saved ${formatJobTime(revision.capturedAt)}` }),
    ),
  );
  if (previous) {
    const id = `diff-${jobId}-${revision.revision}`;
    const open = isOpenNow(id);
    const details = el(
      "details",
      { className: "revision-diff", attrs: { id, ...(open ? { open: "" } : {}) } },
      el("summary", { text: `What changed from revision ${previous.revision} to revision ${revision.revision}` }),
      open ? renderDiff(jobId, previous, revision) : null,
    );
    // The live node gets this handler through morphNode, so it reads the node it fired on, never `details`.
    details.ontoggle = (event) => {
      const node = event.currentTarget;
      if (node.open && !node.querySelector(".diff, .diff-note")) node.append(renderDiff(jobId, previous, revision));
    };
    card.append(details);
  }
  return card;
}

function renderRevisionsSection(jobId, revisions) {
  const list = el("ul", { className: "revisions-list" });
  for (let index = revisions.length - 1; index >= 0; index -= 1) list.append(renderRevision(jobId, revisions[index], revisions[index - 1]));
  return el("div", { className: "detail-revisions", attrs: { id: "detail-revisions" } }, el("h3", { text: "Revisions" }), list);
}

function renderStructuredSection(jobId, latest, extraction) {
  const hasFields = hasStructuredFields(latest.structured);
  const retry = el("button", {
    className: "button secondary",
    text: hasFields ? "Re-extract" : "Try extracting again",
    attrs: { type: "button", id: "detail-retry", "aria-disabled": String(isBusy(extraction)) },
  });
  // The live button gets this handler through morphNode, so it acts on the node that was pressed.
  retry.onclick = (event) => retryExtraction(jobId, latest.revision, event.currentTarget);
  const children = [el("h3", { text: "What the runner found" }), renderStructured(latest.structured)];
  const state = extractionDetail(extraction, latest);
  if (state) children.push(el("p", { className: `extraction-state small ${state.tone}`, attrs: { id: "detail-extraction-message" } }, ...renderPieces(state.message)));
  children.push(retry);
  return el("div", { className: "detail-structured", attrs: { id: "detail-structured" } }, ...children);
}

/** T6: damaged revisions are named by their files, in `<code>`, never skipped silently. */
function renderUnreadable(unreadable, latest) {
  const lead = !latest
    ? "None of this job's revisions can be read. Its files are:"
    : unreadable.length === 1
      ? `This revision can't be read, so it isn't shown; the newest one that can be is revision ${latest.revision}.`
      : `These revisions can't be read, so they aren't shown; the newest one that can be is revision ${latest.revision}.`;
  const items = unreadable.map((file) => el("li", { attrs: { id: `unreadable-${file.revision}` } }, `Revision ${file.revision}: `, el("code", { text: file.path })));
  return el("div", { className: "detail-unreadable small", attrs: { id: "detail-unreadable" } }, el("p", { text: lead }), el("ul", { className: "unreadable-list" }, ...items));
}

/** T17: the posting text is a focusable, labelled region, so a keyboard can scroll it. */
function renderRaw(jobId, latest) {
  const id = `detail-raw-${jobId}`;
  return el(
    "details",
    { className: "detail-raw", attrs: { id, ...(isOpenNow(id) ? { open: "" } : {}) } },
    el("summary", { text: "Full posting text (latest revision)" }),
    el("div", { className: "posting-text", text: latest.text, attrs: { tabindex: "0", role: "region", "aria-label": `Full posting text, revision ${latest.revision}` } }),
  );
}

/** Renders the open job in place: every top-level section has a stable id, so morphChildren reuses each one, including a control the person is using. */
function renderDetail(detail) {
  const { jobId, revisions, unreadable } = detail;
  const extraction = detail.extraction ?? [];
  const latest = revisions.at(-1);
  const title = latest ? jobDisplayName(latest) : UNREADABLE_JOB_NAME;
  if ($("detail-title").textContent !== title) $("detail-title").textContent = title;
  const children = [];
  if (latest) {
    children.push(
      el(
        "p",
        { className: "muted small detail-address", attrs: { id: "detail-address" } },
        el("span", { text: "Address " }),
        el("a", { attrs: { href: latest.url, target: "_blank", rel: "noopener noreferrer" } }, el("code", { text: latest.url }), newTabSuffix()),
      ),
    );
  }
  if (unreadable.length > 0) children.push(renderUnreadable(unreadable, latest));
  if (latest) children.push(renderStructuredSection(jobId, latest, extraction.at(-1)));
  if (revisions.length > 0) children.push(renderRevisionsSection(jobId, revisions));
  if (latest) children.push(renderRaw(jobId, latest));
  morphChildren($("detail-body"), children);
}

/** Shows `detail` in place, and only when it changed (T16): a focused control keeps its place, and open sections stay open. */
function showDetail(detail) {
  openDetail = detail;
  syncOpenRow(detail);
  const key = JSON.stringify(detail);
  if (key === detailKey) return;
  detailKey = key;
  keepInPlace(() => renderDetail(detail));
}

/**
 * The open job's row shows what its detail shows. A refresh reads the list first and the detail second, so the
 * detail is the newer of the two; without this, the row could say "Waiting to extract…" while the detail says
 * "Extracting in the background…" until the next refresh.
 */
function syncOpenRow(detail) {
  const entry = jobsById.get(detail.jobId);
  const latest = detail.revisions.at(-1);
  if (!entry || !latest || entry.latestRevision !== latest.revision) return;
  const extraction = detail.extraction.at(-1) ?? null;
  if (JSON.stringify([entry.latest, entry.extraction]) === JSON.stringify([latest, extraction])) return;
  jobsById.set(detail.jobId, { ...entry, latest, extraction });
  renderList();
}

/** Re-reads the open job, only while it is still the one open. Never moves focus. */
async function reloadDetail() {
  const jobId = openJobId;
  if (!jobId) return;
  const seq = (detailSeq += 1);
  let detail;
  try {
    detail = await getJson(`/api/captures/${jobId}`);
  } catch {
    return; // a passive refresh failing (the job removed, say) is not an action's outcome to announce
  }
  if (openJobId !== jobId || seq < detailShown) return;
  detailShown = seq;
  showDetail(detail);
}

async function openJob(jobId) {
  const token = (openRequestToken += 1);
  let detail;
  try {
    detail = await getJson(`/api/captures/${jobId}`);
  } catch (error) {
    if (token === openRequestToken) lastAction(error?.code === "unreachable" ? CANT_REACH : "Couldn't open that job; it may have been removed.", "refused");
    return;
  }
  if (token !== openRequestToken) return;
  openJobId = jobId;
  detailSeq += 1;
  detailShown = detailSeq; // any older passive refresh still in flight now loses to this answer
  showDetail(detail);
  $("detail-section").hidden = false;
  renderList(); // marks the open row
  const heading = $("detail-title");
  heading.focus({ preventScroll: true });
  scrollUnderLine(heading); // T19: just under the line
}

// ---------------------------------------------------------------------------
// Refreshing (T11): one loop, every 2 s while an extraction is waiting or
// running and every 5 s otherwise, only while the page is visible. It updates
// the list and the open job in place, and announces, once each, the results
// of the extractions this page started. New extension captures join the list
// without an announcement.
// ---------------------------------------------------------------------------

/** Extractions this page started (a save that queued one, or an accepted retry), by jobId and revision. */
const started = new Map();

function trackStarted(jobId, revision) {
  started.set(`${jobId}:${revision}`, { jobId, revision });
}

/** A started extraction's current state and snapshot: from the list when it is the job's latest revision, else from its detail. */
async function stateOf({ jobId, revision }) {
  const entry = jobsById.get(jobId);
  if (entry?.latest && entry.latestRevision === revision) return { extraction: entry.extraction, snapshot: entry.latest };
  let detail = openDetail?.jobId === jobId ? openDetail : undefined;
  if (!detail) {
    try {
      detail = await getJson(`/api/captures/${jobId}`);
    } catch {
      return undefined;
    }
  }
  const index = detail.revisions.findIndex((snapshot) => snapshot.revision === revision);
  return index === -1 ? undefined : { extraction: detail.extraction[index], snapshot: detail.revisions[index] };
}

function announceResult({ extraction, snapshot }) {
  const name = jobDisplayName(snapshot);
  if (extraction?.status === "done") return lastAction(withName("Extracted ", name, "."), "done");
  if (hasStructuredFields(snapshot.structured)) return lastAction(withName("Couldn't re-extract ", name, "; the fields already saved were kept."), "refused");
  return lastAction(withName("Couldn't extract ", name, "; its details say why."), "refused");
}

async function announceSettled() {
  for (const [key, target] of [...started]) {
    const state = await stateOf(target);
    if (!started.has(key)) continue;
    if (!state) {
      started.delete(key); // the job or revision is gone: nothing to announce
      continue;
    }
    if (isBusy(state.extraction)) continue;
    started.delete(key);
    announceResult(state);
  }
}

function anyActive() {
  if (started.size > 0) return true;
  for (const entry of jobsById.values()) if (isBusy(entry.extraction)) return true;
  return Boolean(openDetail?.extraction?.some(isBusy));
}

let refreshTimer = null;
let refreshChain = Promise.resolve();

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = null;
  if (document.visibilityState === "hidden") return;
  refreshTimer = setTimeout(() => void refresh().catch(() => undefined), anyActive() ? FAST_REFRESH_MS : SLOW_REFRESH_MS);
}

async function refreshOnce(options) {
  clearTimeout(refreshTimer);
  refreshTimer = null;
  try {
    await loadJobs(options);
    await reloadDetail();
    await announceSettled();
  } finally {
    scheduleRefresh();
  }
}

/** One refresh at a time, in order; the returned promise settles when this one has run. */
function refresh(options = {}) {
  const run = () => refreshOnce(options);
  refreshChain = refreshChain.then(run, run);
  return refreshChain;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  } else {
    void refresh().catch(() => undefined); // back in view: catch up at once
  }
});

// ---------------------------------------------------------------------------
// Re-extract
// ---------------------------------------------------------------------------

function retryRefusal(error) {
  switch (error?.code) {
    case "unreachable":
      return CANT_REACH;
    case "snapshot_unreadable":
      return "Couldn't extract: this revision's saved file can't be read.";
    case "not_found":
      return "Couldn't extract: that job couldn't be found.";
    default:
      return "Couldn't extract: the runner hit a problem; try again.";
  }
}

async function retryExtraction(jobId, revision, button) {
  if (!button || button.getAttribute("aria-disabled") === "true") return;
  // Explicit, not left to the browser's own click-focuses-button behavior (inconsistent across browsers): the
  // pressed button keeps focus, and morphChildren keeps this same node across the re-render that follows.
  button.focus();
  button.setAttribute("aria-disabled", "true");
  clearFieldErrors(); // J6.3: no error outlives a later, unrelated action
  workingAfterDelay("Extracting…");
  let result;
  try {
    result = await postJson(`/api/captures/${jobId}/${revision}/extract`);
  } catch (error) {
    button.setAttribute("aria-disabled", "false");
    lastAction(retryRefusal(error), "refused");
    return;
  }
  stopWorking();
  button.setAttribute("aria-disabled", String(isBusy(result.extraction)));
  if (isBusy(result.extraction)) {
    trackStarted(jobId, revision);
    lastAction(withName("Extracting ", jobDisplayName(result.job), "…"), "working"); // T11: at once, and the job shows as running
  } else {
    announceResult({ extraction: result.extraction, snapshot: result.job });
  }
  await refresh().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Field errors (J4, J6.3, T14): a refusal about what was typed sits beside
// its field, with aria-invalid and aria-describedby (wired in jobs.html).
// When focus moves to the field, its description carries the detail and the
// line says only "Not saved."; when focus is already there (Enter in the
// field), nothing re-reads the description, so the line carries the short
// reason. Every other refusal goes in the line only. Errors clear when their
// field changes, and at the start of any later action.
// ---------------------------------------------------------------------------

const FIELDS = ["paste-url", "paste-text", "url-input"];

function setFieldError(fieldId, detail) {
  const field = $(fieldId);
  const errorNode = $(`${fieldId}-error`);
  if (detail) {
    field.setAttribute("aria-invalid", "true");
    errorNode.replaceChildren(...renderPieces(detail));
    errorNode.hidden = false;
  } else {
    field.removeAttribute("aria-invalid");
    errorNode.replaceChildren();
    errorNode.hidden = true;
  }
}

function clearFieldErrors() {
  for (const id of FIELDS) setFieldError(id, "");
}

function refuseField(fieldId, refusal) {
  const field = $(fieldId);
  const stayed = document.activeElement === field;
  setFieldError(fieldId, refusal.detail);
  if (stayed) {
    lastAction(`Not saved: ${refusal.short}.`, "refused");
    return;
  }
  lastAction("Not saved.", "refused");
  field.focus({ preventScroll: true });
  // Not left to the focusin listener: it skips a control focused within 500 ms of a pointer press, which suits the
  // clicked button but not this different field, whose new error could otherwise sit under the sticky line.
  keepClear(field);
}

for (const id of FIELDS) {
  $(id).addEventListener("input", () => setFieldError(id, ""));
}

const EMPTY_ADDRESS = (detail) => ({ detail, short: "the address is empty" });
const NOT_AN_ADDRESS = { detail: "That doesn't look like a web address.", short: "that isn't a web address" };
const PASTE_SCHEME = { detail: "Use the posting's web address, starting with `https://` or `http://`.", short: "the address must start with `https://` or `http://`" };
const HTTPS_ONLY = { detail: "The runner only fetches `https://` links.", short: "the runner only fetches `https://` links" };
const EMPTY_TEXT = { detail: "Paste the posting's text.", short: "the posting text is empty" };
const TOO_LARGE = { detail: "This posting is over 200 KB. Paste a shorter excerpt instead.", short: "the posting is over 200 KB" };

/** The paste form's address (T19): the same checks as the fetch form, with the paste path's own rule: `http://` is fine here, since nothing fetches it. */
function pasteAddressProblem(url) {
  if (!url) return EMPTY_ADDRESS("Enter the posting's address.");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return NOT_AN_ADDRESS;
  }
  return parsed.protocol === "https:" || parsed.protocol === "http:" ? undefined : PASTE_SCHEME;
}

/** The fetch form's address. An `http://` link goes to the runner, whose refusal has the sentence written for exactly that case. */
function fetchAddressProblem(url) {
  if (!url) return EMPTY_ADDRESS("Enter the page's address.");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return NOT_AN_ADDRESS;
  }
  return parsed.protocol === "https:" || parsed.protocol === "http:" ? undefined : HTTPS_ONLY;
}

/** Server refusals about what was typed, by code: [field, refusal]. T13: every too-large refusal on the paste path lands on the text. */
const PASTE_FIELD_REFUSALS = {
  invalid_url: ["paste-url", PASTE_SCHEME],
  empty_text: ["paste-text", EMPTY_TEXT],
  text_too_large: ["paste-text", TOO_LARGE],
  body_too_large: ["paste-text", TOO_LARGE],
};

const URL_FIELD_REFUSALS = {
  invalid_url: ["url-input", NOT_AN_ADDRESS],
  fetch_invalid_url: ["url-input", NOT_AN_ADDRESS],
  https_required: ["url-input", { detail: "The runner only fetches `https://` links. Paste the posting text instead for an `http://` page.", short: "the runner only fetches `https://` links" }],
  fetch_scheme_not_https: ["url-input", HTTPS_ONLY],
  fetch_blocked_address: ["url-input", { detail: "That address can't be fetched — it's a private or local network address, not a public one.", short: "that's a private or local network address" }],
  fetch_dns_failed: ["url-input", { detail: "That address couldn't be found.", short: "that address couldn't be found" }],
};

/** Refusals about the page at the address, not the address itself: line only (T14). */
const URL_LINE_REFUSALS = {
  fetch_unsupported_content_type: "Not saved: that page isn't readable text or HTML.",
  fetch_too_large: "Not saved: that page is too large to fetch.",
  fetch_timeout: "Not saved: the page took too long to answer.",
  fetch_too_many_redirects: "Not saved: that link redirected too many times.",
  fetch_redirect_missing_location: "Not saved: that link's redirect didn't say where to go.",
  fetch_http_status: "Not saved: the page couldn't be fetched.",
  fetch_request_failed: "Not saved: the page couldn't be fetched.",
  no_text_extracted: "Not saved: that page has no readable text; try pasting the posting instead.",
  text_too_large: "Not saved: that page's text is over 200 KB; paste an excerpt instead.",
  url_too_large: "Not saved: that page's final address is too long to save.",
};

function refuseSave(error, fieldRefusals, lineRefusals = {}) {
  const mapped = error instanceof ApiError ? fieldRefusals[error.code] : undefined;
  if (mapped) return refuseField(mapped[0], mapped[1]);
  if (error?.code === "unreachable") return lastAction(CANT_REACH, "refused");
  return lastAction(lineRefusals[error?.code] ?? "Not saved: the runner hit a problem; try again.", "refused");
}

/** A save's own outcome, consequence first, in one sentence that fits the line (T18); the extraction's reason is in the job's detail. */
function saveOutcome(result) {
  const { job, extraction } = result;
  if (result.contentChanged === false) return `Already saved: this posting hasn't changed since revision ${job.revision}, so nothing was duplicated.`;
  const as = job.revision === 1 ? "" : ` as revision ${job.revision}`;
  const name = jobDisplayName(job);
  if (isBusy(extraction)) return withName("Saved ", name, `${as}; extracting it in the background.`);
  if (isSettledFailure(extraction)) return withName("Saved ", name, `${as}; not extracted yet.`);
  return withName("Saved ", name, `${as}.`);
}

async function afterSave(result) {
  if (result.contentChanged !== false && isBusy(result.extraction)) trackStarted(result.job.jobId, result.job.revision);
  lastAction(saveOutcome(result), "done");
  await refresh().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Paste and URL-fetch forms
// ---------------------------------------------------------------------------

$("paste-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("paste-submit");
  if (button.getAttribute("aria-disabled") === "true") return;
  clearFieldErrors();
  const url = $("paste-url").value.trim();
  const text = $("paste-text").value;
  // The form checks what it can before sending, so each refusal names its own field.
  const addressProblem = pasteAddressProblem(url);
  if (addressProblem) return refuseField("paste-url", addressProblem);
  if (!text.trim()) return refuseField("paste-text", EMPTY_TEXT);
  if (captureTextBytes(text) > MAX_CAPTURE_TEXT_BYTES) return refuseField("paste-text", TOO_LARGE);
  button.setAttribute("aria-disabled", "true");
  workingAfterDelay("Saving…");
  let result;
  try {
    result = await postJson("/api/captures/paste", { url, text });
  } catch (error) {
    refuseSave(error, PASTE_FIELD_REFUSALS);
    return;
  } finally {
    stopWorking();
    button.setAttribute("aria-disabled", "false");
  }
  $("paste-url").value = "";
  $("paste-text").value = "";
  await afterSave(result);
});

$("url-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("url-submit");
  if (button.getAttribute("aria-disabled") === "true") return;
  clearFieldErrors();
  const url = $("url-input").value.trim();
  const problem = fetchAddressProblem(url);
  if (problem) return refuseField("url-input", problem);
  button.setAttribute("aria-disabled", "true");
  workingAfterDelay("Fetching…");
  let result;
  try {
    result = await postJson("/api/captures/url", { url });
  } catch (error) {
    refuseSave(error, URL_FIELD_REFUSALS, URL_LINE_REFUSALS);
    return;
  } finally {
    stopWorking();
    button.setAttribute("aria-disabled", "false");
  }
  $("url-input").value = "";
  await afterSave(result);
});

trackLastActionHeight();
void refresh({ announceErrors: true }).catch(() => undefined);
