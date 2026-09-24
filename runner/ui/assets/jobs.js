/* global document, window, fetch, requestAnimationFrame, URL, ResizeObserver, setTimeout, clearTimeout, TextEncoder */
// The Jobs page (P04): capture a posting from the extension, a paste, or an
// https:// fetch; see every job and its revision history; re-run extraction
// on a revision that has no structured fields yet. Talks to
// server/routes/captures.ts.
//
// Round-1 review L12 (following P03's J4-J6, logs/handoff/P03-round-3-review.md):
// one sticky "Last action" line (never off-screen); a delayed "Saving…"/
// "Fetching…"/"Extracting…" busy state; an unextracted job is named from its
// own text or URL, never a bare hostname; extraction states are plain
// sentences with a reason and a next step, never "structured fields"; the
// detail panel re-renders in place (morphChildren/morphNode) so a pressed
// button, or any other focused control, is never destroyed; paste checks its
// own size before sending, and every refusal names its field; the diff is
// readable to a screen reader.
//
// Only `el` comes from runner.js. Its `getJson`/`postJson` throw an Error
// built from the server's raw `error.message`, and server/http.ts's
// validationErrorResponse names the offending field in that message
// ("Invalid request body at url: ..."). This page never shows a field name,
// a status code or a UUID, so every error code below gets its own
// hand-written, reviewed sentence instead of the server's own wording — see
// `FRIENDLY_ERRORS` and `api()`.
import { el } from "./runner.js";

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const FRIENDLY_ERRORS = {
  invalid_body: "That didn't look right. Check the address and the posting text, then try again.",
  invalid_url: "That doesn't look like a web address.",
  https_required: "The runner only fetches https:// links. Paste the posting text instead for an http:// page.",
  fetch_invalid_url: "That doesn't look like a web address.",
  fetch_scheme_not_https: "The runner only fetches https:// links.",
  fetch_blocked_address: "That address can't be fetched — it's a private or local network address, not a public one.",
  fetch_unsupported_content_type: "That page isn't readable text or HTML.",
  fetch_too_large: "That page is too large to fetch.",
  fetch_timeout: "The page took too long to answer.",
  fetch_dns_failed: "That address couldn't be found.",
  fetch_too_many_redirects: "That link redirected too many times.",
  fetch_redirect_missing_location: "That link's redirect didn't say where to go.",
  fetch_http_status: "The page couldn't be fetched.",
  fetch_request_failed: "The page couldn't be fetched.",
  no_text_extracted: "Couldn't find readable text on that page. Try pasting the posting instead.",
  text_too_large: "This posting is over 200 KB. Paste a shorter excerpt instead.",
  url_too_large: "That page's final address is too long to save. Paste the posting instead.",
  not_found: "That job couldn't be found.",
};
const DEFAULT_ERROR = "That didn't work. Try again.";

function friendlyMessage(code) {
  return (code && FRIENDLY_ERRORS[code]) ?? DEFAULT_ERROR;
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
    throw new Error("Can't reach the runner. Is it still running?");
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // not JSON
  }
  if (response.status === 401) {
    window.location.reload();
    throw new Error("Signed out.");
  }
  if (!response.ok) throw new Error(friendlyMessage(data?.error?.code));
  return data;
}

const getJson = (path) => api("GET", path);
const postJson = (path, body) => api("POST", path, body ?? {});

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Round-1 review L12 item 3 (polish): "npm run runner" and any bare "http(s)://" mention in a message are shown as code, the same way onboarding.js/profile.js already treat a command a person types. */
const CODE_PATTERNS = /npm run runner|https?:\/\//g;

function lineParts(message) {
  const parts = [];
  let from = 0;
  for (const match of message.matchAll(CODE_PATTERNS)) {
    parts.push(message.slice(from, match.index), el("code", { text: match[0] }));
    from = match.index + match[0].length;
  }
  parts.push(message.slice(from));
  return parts.filter((part) => part !== "");
}

// ---------------------------------------------------------------------------
// The sticky "Last action" line (round-1 review L12 item 1, P03's J4-J5):
// one live region, kept clear of a focused control (keepClear) and where it
// is on screen when the page changes around it (keepInPlace).
// ---------------------------------------------------------------------------

const TAGS = { done: "Last action", refused: "Refused", working: "Working" };

/** Runs `change`, then scrolls so the focused control is where it was on screen: nothing shifts under it. */
function keepInPlace(change) {
  const node = document.activeElement;
  const top = node && node !== document.body ? node.getBoundingClientRect().top : null;
  change();
  if (top === null || document.activeElement !== node) return;
  const moved = node.getBoundingClientRect().top - top;
  if (Math.abs(moved) >= 1) window.scrollBy(0, moved);
}

let working = null; // the timer that shows "Saving…"/"Fetching…"/"Extracting…" (L12 item 2)

function stopWorking() {
  if (working) clearTimeout(working);
  working = null;
}

/** Announces one outcome, once. The same text twice in a row is cleared first so it is announced again. */
function lastAction(message, tone = "done") {
  if (tone !== "working") stopWorking();
  const node = $("last-action");
  const tag = node.querySelector(".tag");
  const text = node.querySelector(".text");
  const apply = () =>
    keepInPlace(() => {
      node.className = `last-action ${tone}`;
      tag.textContent = TAGS[tone];
      text.replaceChildren(...lineParts(message));
      text.title = message; // the whole sentence for a pointer, where the line is clamped at 640px
    });
  if (text.textContent === message && tag.textContent === TAGS[tone]) {
    keepInPlace(() => {
      text.textContent = "";
    });
    requestAnimationFrame(apply);
  } else {
    apply();
  }
}

/** L12 item 2: the busy word appears only once a request has taken about 300 ms, so a quick one never flashes it; a new request always clears whatever the line said before. */
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
  // Duck-typed, not `instanceof HTMLElement`: happy-dom's test window (runner/test/jobs-page.test.ts) does not
  // put HTMLElement on globalThis, only on its own `window`, and this module has no import path to that instance.
  if (!node || typeof node.getBoundingClientRect !== "function" || !node.isConnected) return;
  const top = $("last-action").getBoundingClientRect().bottom + 8;
  const rect = node.getBoundingClientRect();
  if (rect.top < top || rect.height > window.innerHeight - top) window.scrollBy(0, rect.top - top);
  else if (rect.bottom > window.innerHeight) window.scrollBy(0, rect.bottom - window.innerHeight + 8);
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
// Rendering in place (round-1 review L12 item 5, P03's J4): a re-render never
// replaces a node that holds focus, so the button that was pressed keeps it.
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
    if (used.has(old) || holdsFocus(old)) continue; // a focused node that is no longer wanted is left in place rather than torn out from under the person
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
// Formatting
// ---------------------------------------------------------------------------

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** The URL's own path, for a job with no title and no readable first line — never the bare hostname (L12 item 3). */
function urlPathName(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
    return path || parsed.hostname;
  } catch {
    return undefined;
  }
}

function truncate(text, max) {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

function firstNonEmptyLine(text) {
  return (text ?? "").split("\n").find((line) => line.trim() !== "")?.trim();
}

/** L12 item 3: title+company when extracted; else the posting's own first non-empty line (capped ~80 chars); else the URL's path; never the bare hostname alone. */
function jobDisplayName(snapshot) {
  const structured = snapshot.structured ?? {};
  if (structured.title && structured.company) return `${structured.title} · ${structured.company}`;
  if (structured.title) return structured.title;
  const line = firstNonEmptyLine(snapshot.text);
  if (line) return truncate(line, 80);
  return urlPathName(snapshot.url) ?? "Untitled posting";
}

/** Timestamps without seconds (L12 polish). */
function formatJobTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** `deadline` is a calendar date (YYYY-MM-DD): formatted in UTC to match how it was parsed, so no timezone can shift it to the previous or next day (L12 polish: "format the deadline"). */
function formatDeadline(dateOnly) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return dateOnly;
  const date = new Date(`${dateOnly}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return dateOnly;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeZone: "UTC" }).format(date);
}

function quote(text, max = 60) {
  const line = text.replace(/\s+/g, " ").trim();
  return `“${line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line}”`;
}

/** A link that opens in a new tab always says so, for anyone not looking at the tab bar (L12 polish). */
function newTabSuffix() {
  return el("span", { className: "visually-hidden", text: " (opens in a new tab)" });
}

// ---------------------------------------------------------------------------
// Line diff — the "posting changed" view between two revisions of the same
// job. A plain line-based LCS: postings are plain text and this is a diff to
// look at, not a merge tool, so no dependency is pulled in for it. Capped so
// a very long posting never hangs the tab; the DP table is O(n*m) cells.
// ---------------------------------------------------------------------------

const DIFF_CELL_CAP = 4_000_000;
const DIFF_CONTEXT = 2;

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

/**
 * Round-1 review L12 item 9: a visually-hidden "Added:"/"Removed:" prefix
 * carries the change to a screen reader; the "+"/"−" glyph is a real,
 * aria-hidden span (CSS ::before generated content is invisible to
 * assistive tech either way, so a real span costs nothing and can be styled
 * independently), and the strikethrough on a removed line applies only to
 * `.diff-text`, never to the marker — `"\u2212\u00a0"` (a minus sign
 * followed by a non-breaking space) so the marker's own trailing space is
 * never collapsed away. Written as an escape, not the raw character: eslint's
 * no-irregular-whitespace rule rightly flags a literal non-breaking space in source.
 */
function renderDiff(oldText, newText) {
  if (oldText === newText) return el("p", { className: "muted small", text: "The text did not change." });
  const rows = diffLines(oldText, newText);
  if (!rows) return el("p", { className: "muted small", text: "This posting is too long to show a line-by-line diff." });
  const container = el("div", { className: "diff" });
  for (const row of collapseUnchanged(rows)) {
    if (row.kind === "skip") {
      container.append(el("div", { className: "diff-skip", text: `⋯ ${plural(row.count, "unchanged line")} ⋯` }));
      continue;
    }
    if (row.kind === "same") {
      container.append(el("div", { className: "diff-line same", text: row.text }));
      continue;
    }
    const isAdded = row.kind === "added";
    container.append(
      el(
        "div",
        { className: `diff-line ${row.kind}` },
        el("span", { className: "visually-hidden", text: isAdded ? "Added: " : "Removed: " }),
        el("span", { className: "diff-marker", attrs: { "aria-hidden": "true" }, text: isAdded ? "+ " : "\u2212\u00a0" }),
        el("span", { className: "diff-text", text: row.text }),
      ),
    );
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

/** Round-1 review L12 item 4: a stable reason code (store/jobs.ts's ExtractionState) mapped to a plain sentence naming the real next step — never a raw server string, never "structured fields". */
const EXTRACTION_REASON_MESSAGES = {
  runner_not_running: "The runner isn't running, so this can't be extracted yet. Start it with npm run runner, then try again.",
  no_model: "No model is set up yet. Set one up in Settings, then try again.",
  budget_paused: "Extraction is paused right now. Try again later.",
  timed_out: "Extraction took too long and was stopped. Try again.",
  turn_failed: "Extraction didn't finish. Try again.",
  no_fields_found: "The runner didn't find any fields on this posting. Try again, or paste the text directly.",
  interrupted: "Extraction was interrupted before it finished. Try again.",
};

function extractionFailed(extraction) {
  return extraction?.status === "not_run" || extraction?.status === "failed";
}

/** "" when there is nothing worth adding beside the fields themselves (never attempted, or already done). L12 item 4's second bullet: a failed Re-extract says the existing fields were kept. */
function extractionStateMessage(extraction, structured) {
  if (!extraction || extraction.status === "done") return "";
  if (extraction.status === "waiting" || extraction.status === "running") return "Extraction is running in the background.";
  const reason = EXTRACTION_REASON_MESSAGES[extraction.reason] ?? "Extraction didn't run.";
  return hasStructuredFields(structured) ? `${reason} The fields already saved were kept.` : reason;
}

// ---------------------------------------------------------------------------
// Jobs list
// ---------------------------------------------------------------------------

let openJobId;

function renderJobRow(job) {
  const button = el("button", { className: "job-open", text: jobDisplayName(job.latest), attrs: { type: "button" } });
  if (job.jobId === openJobId) button.setAttribute("aria-current", "true");
  button.onclick = () => openJob(job.jobId);
  const meta = el(
    "p",
    { className: "muted small" },
    el("code", { text: hostnameOf(job.latest.url) ?? job.latest.url }),
    el("span", { text: ` · ${plural(job.revisionCount, "revision")} · saved ${formatJobTime(job.latest.capturedAt)}` }),
  );
  return el("li", { className: `job-row${job.jobId === openJobId ? " open" : ""}`, attrs: { id: `job-row-${job.jobId}` } }, button, meta);
}

/** L12 polish: marks the open row so it is visible which one a detail panel belongs to, without waiting for the next full list reload. */
function markOpenRow(jobId) {
  for (const row of document.querySelectorAll(".job-row")) {
    const isOpen = row.id === `job-row-${jobId}`;
    row.classList.toggle("open", isOpen);
    const button = row.querySelector(".job-open");
    if (isOpen) button?.setAttribute("aria-current", "true");
    else button?.removeAttribute("aria-current");
  }
}

async function loadJobs() {
  const list = $("jobs-list");
  const empty = $("jobs-empty");
  try {
    const { jobs } = await getJson("/api/captures");
    if (jobs.length === 0) {
      morphChildren(list, []);
      empty.hidden = false;
      list.hidden = true;
      return; // No live-region echo for an empty list: ordinary page content, not an interruption.
    }
    empty.hidden = true;
    list.hidden = false;
    morphChildren(list, jobs.map(renderJobRow));
  } catch (error) {
    morphChildren(list, []);
    list.hidden = true;
    empty.hidden = true;
    lastAction(messageOf(error), "refused");
  }
}

// ---------------------------------------------------------------------------
// Job detail: revisions, structured fields, the "posting changed" diff
// ---------------------------------------------------------------------------

function renderRevision(revision, previous) {
  const card = el(
    "li",
    { className: "revision-card", attrs: { id: `revision-${revision.revision}` } },
    el(
      "p",
      { className: "revision-head" },
      el("span", { className: "revision-number", text: `Revision ${revision.revision}` }),
      el("span", { className: "muted small", text: ` · saved ${formatJobTime(revision.capturedAt)}` }),
    ),
  );
  if (previous) {
    // L12 polish: the toggle names the two revisions it compares, not the same generic sentence for every pair.
    const summary = el("summary", { text: `What changed from revision ${previous.revision} to revision ${revision.revision}` });
    const details = el("details", { className: "revision-diff" }, summary);
    details.addEventListener("toggle", () => {
      if (details.open && details.childElementCount === 1) details.append(renderDiff(previous.text, revision.text));
    });
    card.append(details);
  }
  return card;
}

async function retryExtraction(jobId, revision, button) {
  if (button.getAttribute("aria-disabled") === "true") return;
  // Explicit, not left to the browser's own click-focuses-button behavior (inconsistent across browsers and
  // platforms, e.g. macOS Safari's default "Full Keyboard Access" off): L12 item 5's guarantee is this page's
  // own, not borrowed. morphChildren then keeps this same #detail-retry node across the re-render that follows.
  button.focus();
  button.setAttribute("aria-disabled", "true");
  workingAfterDelay("Extracting…");
  try {
    const result = await postJson(`/api/captures/${jobId}/${revision}/extract`);
    await reloadDetail(jobId);
    await loadJobs(); // extraction can fill in the title/company the list row shows
    if (result.extraction?.status === "waiting") {
      watchExtraction(jobId, revision);
    } else {
      lastAction(extractionStateMessage(result.extraction, result.job.structured) || `Extraction finished for ${quote(jobDisplayName(result.job), 60)}.`, extractionFailed(result.extraction) ? "refused" : "done");
    }
  } catch (error) {
    lastAction(messageOf(error), "refused");
  } finally {
    stopWorking();
  }
}

function renderStructuredSection(jobId, latest, extraction) {
  const hasFields = hasStructuredFields(latest.structured);
  const busy = extraction?.status === "waiting" || extraction?.status === "running";
  const retryButton = el("button", {
    className: "button secondary",
    text: hasFields ? "Re-extract" : "Try extracting again",
    attrs: { type: "button", id: "detail-retry", "aria-disabled": String(busy) },
  });
  retryButton.onclick = () => retryExtraction(jobId, latest.revision, retryButton);
  const children = [el("h3", { text: "What the runner found" }), renderStructured(latest.structured)];
  const stateMessage = extractionStateMessage(extraction, latest.structured);
  if (stateMessage) {
    children.push(el("p", { className: `extraction-state small ${extractionFailed(extraction) ? "refused" : "muted"}`, attrs: { id: "detail-extraction-message" } }, ...lineParts(stateMessage)));
  }
  children.push(retryButton);
  return el("div", { className: "detail-structured", attrs: { id: "detail-structured" } }, ...children);
}

function renderRevisionsSection(revisions) {
  const list = el("ul", { className: "revisions-list" });
  for (let index = revisions.length - 1; index >= 0; index -= 1) list.append(renderRevision(revisions[index], revisions[index - 1]));
  return el("div", { className: "detail-revisions", attrs: { id: "detail-revisions" } }, el("h3", { text: "Revisions" }), list);
}

/** Renders the open job's detail in place (round-1 review L12 item 5): every top-level section carries a stable id, so morphChildren reuses each one — including the retry button the person may have just pressed — instead of tearing the panel down and rebuilding it. */
function renderDetail(jobId, revisions, extraction = []) {
  const latest = revisions.at(-1);
  const latestExtraction = extraction[extraction.length - 1];
  $("detail-title").textContent = jobDisplayName(latest);
  morphChildren($("detail-body"), [
    el(
      "p",
      { className: "muted small detail-address", attrs: { id: "detail-address" } },
      el("span", { text: "Address " }),
      el("a", { attrs: { href: latest.url, target: "_blank", rel: "noopener noreferrer" } }, el("code", { text: latest.url }), newTabSuffix()),
    ),
    renderStructuredSection(jobId, latest, latestExtraction),
    renderRevisionsSection(revisions),
    el("details", { className: "detail-raw", attrs: { id: "detail-raw" } }, el("summary", { text: "Full posting text (latest revision)" }), el("pre", { className: "posting-text", text: latest.text })),
  ]);
}

/** Re-fetches and re-renders the open job's detail, only while it is still the one open (a later click on a different job, or a closed panel, wins). Never moves focus itself — morphChildren already keeps whatever was focused (L12 item 5: "keep focus on the button that was pressed"). */
async function reloadDetail(jobId) {
  if (openJobId !== jobId) return;
  try {
    const { revisions, extraction } = await getJson(`/api/captures/${jobId}`);
    if (openJobId !== jobId) return;
    renderDetail(jobId, revisions, extraction);
  } catch {
    // A passive refresh failing (the job disappeared, say) is not this action's own outcome to announce.
  }
}

let openRequestToken = 0;

async function openJob(jobId) {
  const token = (openRequestToken += 1);
  try {
    const { revisions, extraction } = await getJson(`/api/captures/${jobId}`);
    if (token !== openRequestToken) return; // a newer open request has since started
    openJobId = jobId;
    renderDetail(jobId, revisions, extraction);
    $("detail-section").hidden = false;
    markOpenRow(jobId);
    $("detail-title").focus();
    keepClear($("detail-title")); // L12 polish: scroll an opened job's heading into view, clear of the sticky line
  } catch (error) {
    if (token !== openRequestToken) return;
    lastAction(messageOf(error), "refused");
  }
}

// ---------------------------------------------------------------------------
// Watching a background extraction (L12 item 4's last bullet): "While a
// job's extraction runs, the page refreshes that job in place. It announces,
// exactly once, the result of an extraction started on the page."
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 400;
const watching = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function watchExtraction(jobId, revision) {
  const key = `${jobId}:${revision}`;
  if (watching.has(key)) return; // already being watched by an earlier call — that one will announce the result
  watching.add(key);
  try {
    for (;;) {
      await sleep(POLL_INTERVAL_MS);
      let detail;
      try {
        detail = await getJson(`/api/captures/${jobId}`);
      } catch {
        return; // stop quietly; a manual refresh (or reopening the job) will show the true state
      }
      const index = detail.revisions.findIndex((entry) => entry.revision === revision);
      const extraction = index === -1 ? undefined : detail.extraction[index];
      if (extraction?.status === "waiting" || extraction?.status === "running") continue;
      if (openJobId === jobId) renderDetail(jobId, detail.revisions, detail.extraction);
      await loadJobs();
      const snapshot = index === -1 ? undefined : detail.revisions[index];
      const message = snapshot ? extractionStateMessage(extraction, snapshot.structured) || `Extraction finished for ${quote(jobDisplayName(snapshot), 60)}.` : "Extraction finished.";
      lastAction(message, extractionFailed(extraction) ? "refused" : "done");
      return;
    }
  } finally {
    watching.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Field errors (round-1 review L12 item 6): sit beside their control, with
// aria-invalid and aria-describedby (already wired in jobs.html); the line
// says only the short outcome.
// ---------------------------------------------------------------------------

function setFieldError(fieldId, message) {
  const field = $(fieldId);
  const errorNode = $(`${fieldId}-error`);
  if (message) {
    field.setAttribute("aria-invalid", "true");
    errorNode.replaceChildren(...lineParts(message));
    errorNode.hidden = false;
  } else {
    field.removeAttribute("aria-invalid");
    errorNode.replaceChildren();
    errorNode.hidden = true;
  }
}

function refuseField(fieldId, message) {
  setFieldError(fieldId, message);
  lastAction("Not saved.", "refused");
  const field = $(fieldId);
  field.focus();
  // Not left to the global focusin listener: its pointerAt suppression assumes a just-clicked control already
  // scrolled itself into view, which holds for the control that was actually clicked (the submit button) but not
  // for this field — a *different* control this refusal is moving focus to, whose new error text can otherwise
  // land right under the sticky line, invisible until the person scrolls (caught visually taking L13's screenshots).
  keepClear(field);
}

for (const id of ["paste-url", "paste-text", "url-input"]) {
  $(id).addEventListener("input", () => setFieldError(id, ""));
}

/** L12 polish: names the job in a save's own success message, the same way a background extraction's own outcome does. */
function saveOutcomeMessage(result) {
  const name = jobDisplayName(result.job);
  if (result.contentChanged === false) return `Already saved: this posting hasn't changed since revision ${result.job.revision}, so nothing was duplicated.`;
  return result.job.revision === 1 ? `Saved ${quote(name, 60)}.` : `Saved ${quote(name, 60)} as revision ${result.job.revision}.`;
}

function extractionNoticeForSave(extraction) {
  if (!extraction) return "";
  if (extraction.status === "waiting") return "Extraction is running in the background.";
  if (extraction.status === "not_run") return EXTRACTION_REASON_MESSAGES[extraction.reason] ?? "Extraction didn't run.";
  return "";
}

// ---------------------------------------------------------------------------
// Paste and URL-fetch forms
// ---------------------------------------------------------------------------

const MAX_PASTE_TEXT_BYTES = 200_000; // mirrors @workflow-catalog/contracts's MAX_JOB_CAPTURE_TEXT_BYTES; server/routes/captures.ts enforces the same cap, but the browser can't import that package to share the constant.

$("paste-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("paste-submit");
  if (button.getAttribute("aria-disabled") === "true") return;
  const url = $("paste-url").value.trim();
  const text = $("paste-text").value;
  setFieldError("paste-url", "");
  setFieldError("paste-text", "");
  // L12 item 6: the paste form checks its own size (and emptiness) before ever sending, so every refusal names
  // its own field instead of falling back to the server's generic "Invalid request body" translation.
  if (!url) return refuseField("paste-url", "Enter the posting's address.");
  if (!text.trim()) return refuseField("paste-text", "Paste the posting's text.");
  if (new TextEncoder().encode(text).length > MAX_PASTE_TEXT_BYTES) return refuseField("paste-text", "This posting is over 200 KB. Paste a shorter excerpt instead.");
  button.setAttribute("aria-disabled", "true");
  workingAfterDelay("Saving…");
  try {
    const result = await postJson("/api/captures/paste", { url, text });
    $("paste-url").value = "";
    $("paste-text").value = "";
    await loadJobs();
    await reloadDetail(result.job.jobId);
    const notice = extractionNoticeForSave(result.extraction);
    lastAction(notice ? `${saveOutcomeMessage(result)} ${notice}` : saveOutcomeMessage(result), "done");
    if (result.extraction?.status === "waiting") watchExtraction(result.job.jobId, result.job.revision);
  } catch (error) {
    refuseField("paste-url", messageOf(error)); // the remaining server-side refusals (an address the schema itself rejects) are all about the address, since size and emptiness are already caught above
  } finally {
    stopWorking();
    button.setAttribute("aria-disabled", "false");
  }
});

/** L12 polish: the javascript:/file: refusal no longer borrows the http:-specific "paste instead" sentence; a real http: link is the only case forwarded to the server, whose own message is written for exactly that case. Returns undefined for an address the runner will actually try to fetch. */
function schemeProblem(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "That doesn't look like a web address.";
  }
  if (parsed.protocol === "https:" || parsed.protocol === "http:") return undefined;
  return "The runner only fetches https:// links.";
}

$("url-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("url-submit");
  if (button.getAttribute("aria-disabled") === "true") return;
  const url = $("url-input").value.trim();
  setFieldError("url-input", "");
  if (!url) return refuseField("url-input", "Enter the page's address.");
  const problem = schemeProblem(url);
  if (problem) return refuseField("url-input", problem);
  button.setAttribute("aria-disabled", "true");
  workingAfterDelay("Fetching…");
  try {
    const result = await postJson("/api/captures/url", { url });
    $("url-input").value = "";
    await loadJobs();
    await reloadDetail(result.job.jobId);
    const notice = extractionNoticeForSave(result.extraction);
    lastAction(notice ? `${saveOutcomeMessage(result)} ${notice}` : saveOutcomeMessage(result), "done");
    if (result.extraction?.status === "waiting") watchExtraction(result.job.jobId, result.job.revision);
  } catch (error) {
    refuseField("url-input", messageOf(error));
  } finally {
    stopWorking();
    button.setAttribute("aria-disabled", "false");
  }
});

trackLastActionHeight();
loadJobs();
