/* global document, window, fetch, requestAnimationFrame, URL */
// The Jobs page (P04): capture a posting from the extension, a paste, or an
// https:// fetch; see every job and its revision history; re-run extraction
// on a revision that has no structured fields yet. Talks to
// server/routes/captures.ts.
//
// Only `el` and `formatTime` come from runner.js. Its `getJson`/`postJson`
// throw an Error built from the server's raw `error.message`, and
// server/http.ts's `validationErrorResponse` names the offending field in
// that message ("Invalid request body at url: ..."). This page never shows a
// field name, a status code or a UUID, so every error code below gets its
// own hand-written, reviewed sentence instead of the server's own wording —
// see `FRIENDLY_ERRORS` and `api()`.
import { el, formatTime } from "./runner.js";

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
  fetch_blocked_address: "That address can't be fetched — it isn't a public web address.",
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

// Round-1 review L5/L12: extraction now runs in the background, so a capture
// or retry response carries only the *current* extraction state
// (`{status, reason?}`, server/routes/captures.ts's `ExtractionState`), never
// a finished outcome sentence. This maps that state to a plain sentence the
// same way FRIENDLY_ERRORS maps a server error code — never a raw server
// string. Interim wording: L12 finalizes this with next-step guidance
// (`npm run runner` in `<code>`, "set up a model in Settings", "try again").
const EXTRACTION_REASON_MESSAGES = {
  runner_not_running: "The runner isn't running, so this can't be extracted right now.",
  no_model: "No model is set up yet, so this can't be extracted.",
  budget_paused: "Extraction is paused right now.",
  timed_out: "Extraction timed out.",
  turn_failed: "Extraction didn't finish.",
  no_fields_found: "The runner didn't find any structured fields.",
  interrupted: "Extraction was interrupted.",
};

/** "" (never a sentence) when `extraction` is undefined — an unchanged duplicate capture, or a revision from before this queue existed, says nothing extra rather than a misleading "not extracted yet" about a job that may already carry fields from an earlier revision. */
function extractionMessage(extraction) {
  if (!extraction) return "";
  if (extraction.status === "waiting" || extraction.status === "running") return "Extraction is running in the background.";
  if (extraction.status === "done") return "Extraction finished.";
  return EXTRACTION_REASON_MESSAGES[extraction.reason] ?? "Extraction didn't run.";
}

function extractionFailed(extraction) {
  return extraction?.status === "not_run" || extraction?.status === "failed";
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

// ---------------------------------------------------------------------------
// The one persistent live region (role="status"), same pattern as runs.js:
// clears then re-sets the text on the next frame, so a repeated message is
// still re-announced.
// ---------------------------------------------------------------------------

function announce(message, tone) {
  const node = $("status-message");
  node.textContent = "";
  node.className = `status-message${tone ? ` ${tone}` : ""}`;
  requestAnimationFrame(() => {
    node.textContent = message;
  });
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

function renderDiff(oldText, newText) {
  if (oldText === newText) return el("p", { className: "muted small", text: "The text did not change." });
  const rows = diffLines(oldText, newText);
  if (!rows) return el("p", { className: "muted small", text: "This posting is too long to show a line-by-line diff." });
  const container = el("div", { className: "diff" });
  for (const row of collapseUnchanged(rows)) {
    if (row.kind === "skip") {
      container.append(el("div", { className: "diff-skip", text: `⋯ ${plural(row.count, "unchanged line")} ⋯` }));
    } else {
      container.append(el("div", { className: `diff-line ${row.kind}`, text: row.text }));
    }
  }
  return container;
}

// ---------------------------------------------------------------------------
// Structured fields
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
      dd.append(el("a", { attrs: { href: value, target: "_blank", rel: "noopener noreferrer" } }, el("code", { text: value })));
    } else {
      // `deadline` is a calendar date (YYYY-MM-DD), never parsed as a Date here: a date-only string parses as UTC
      // midnight, and formatting it back in a timezone behind UTC would show the previous day.
      dd.append(el("span", { text: value }));
    }
    dl.append(el("dt", { text: label }), dd);
  }
  return dl;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function jobTitle(snapshot) {
  const structured = snapshot.structured ?? {};
  if (structured.title && structured.company) return `${structured.title} · ${structured.company}`;
  if (structured.title) return structured.title;
  return hostnameOf(snapshot.url) ?? "Untitled posting";
}

// ---------------------------------------------------------------------------
// Jobs list
// ---------------------------------------------------------------------------

let openJobId;

function renderJobRow(job) {
  const button = el("button", { className: "job-open", text: jobTitle(job.latest), attrs: { type: "button" } });
  button.addEventListener("click", () => openJob(job.jobId));
  const meta = el(
    "p",
    { className: "muted small" },
    el("code", { text: hostnameOf(job.latest.url) ?? job.latest.url }),
    el("span", { text: ` · ${plural(job.revisionCount, "revision")} · saved ${formatTime(job.latest.capturedAt)}` }),
  );
  return el("li", { className: "job-row" }, button, meta);
}

async function loadJobs() {
  const list = $("jobs-list");
  const empty = $("jobs-empty");
  try {
    const { jobs } = await getJson("/api/captures");
    list.replaceChildren();
    if (jobs.length === 0) {
      empty.hidden = false;
      list.hidden = true;
      return; // No live-region echo for an empty list: ordinary page content, not an interruption.
    }
    empty.hidden = true;
    list.hidden = false;
    for (const job of jobs) list.append(renderJobRow(job));
  } catch (error) {
    list.replaceChildren();
    list.hidden = true;
    empty.hidden = true;
    announce(messageOf(error), "error");
  }
}

// ---------------------------------------------------------------------------
// Job detail: revisions, structured fields, the "posting changed" diff
// ---------------------------------------------------------------------------

function renderRevision(jobId, revision, previous) {
  const card = el(
    "li",
    { className: "revision-card" },
    el(
      "p",
      { className: "revision-head" },
      el("span", { className: "revision-number", text: `Revision ${revision.revision}` }),
      el("span", { className: "muted small", text: ` · saved ${formatTime(revision.capturedAt)}` }),
    ),
  );
  if (previous) {
    const summary = el("summary", { text: "What changed from the previous revision" });
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
  button.setAttribute("aria-disabled", "true");
  try {
    const result = await postJson(`/api/captures/${jobId}/${revision}/extract`);
    await reloadDetail(jobId, { moveFocus: true });
    await loadJobs(); // extraction can fill in the title/company the list row shows
    announce(extractionMessage(result.extraction), extractionFailed(result.extraction) ? "error" : "success");
  } catch (error) {
    button.setAttribute("aria-disabled", "false");
    announce(messageOf(error), "error");
  }
}

function renderDetail(jobId, revisions) {
  const latest = revisions.at(-1);
  $("detail-title").textContent = jobTitle(latest);
  const body = $("detail-body");
  body.replaceChildren();

  body.append(
    el(
      "p",
      { className: "muted small" },
      el("span", { text: "Address " }),
      el("a", { attrs: { href: latest.url, target: "_blank", rel: "noopener noreferrer" } }, el("code", { text: latest.url })),
    ),
  );

  const structuredHeading = el("h3", { text: "What the runner found" });
  const retryButton = el("button", {
    className: "button secondary",
    text: hasStructuredFields(latest.structured) ? "Re-extract" : "Try extracting again",
    attrs: { type: "button" },
  });
  retryButton.addEventListener("click", () => retryExtraction(jobId, latest.revision, retryButton));
  body.append(el("div", { className: "detail-structured" }, structuredHeading, renderStructured(latest.structured), retryButton));

  const revisionsList = el("ul", { className: "revisions-list" });
  for (let index = revisions.length - 1; index >= 0; index -= 1) {
    revisionsList.append(renderRevision(jobId, revisions[index], revisions[index - 1]));
  }
  body.append(el("div", { className: "detail-revisions" }, el("h3", { text: "Revisions" }), revisionsList));

  body.append(
    el(
      "details",
      { className: "detail-raw" },
      el("summary", { text: "Full posting text (latest revision)" }),
      el("pre", { className: "posting-text", text: latest.text }),
    ),
  );
}

/** Re-fetches and re-renders the open job's detail, only while it is still the one open (a later click on a different job, or a closed panel, wins). `moveFocus` is true only when the action that caused this came from a control inside the panel being rebuilt (e.g. "Re-extract") — never for a passive refresh after an unrelated form elsewhere on the page succeeds, which must not steal focus from that form's own button. */
async function reloadDetail(jobId, { moveFocus = false } = {}) {
  if (openJobId !== jobId) return;
  try {
    const { revisions } = await getJson(`/api/captures/${jobId}`);
    if (openJobId !== jobId) return;
    renderDetail(jobId, revisions);
    if (moveFocus) $("detail-title").focus();
  } catch (error) {
    if (moveFocus) announce(messageOf(error), "error");
  }
}

let openRequestToken = 0;

async function openJob(jobId) {
  const token = (openRequestToken += 1);
  try {
    const { revisions } = await getJson(`/api/captures/${jobId}`);
    if (token !== openRequestToken) return; // a newer open request has since started
    openJobId = jobId;
    renderDetail(jobId, revisions);
    $("detail-section").hidden = false;
    $("detail-title").focus();
  } catch (error) {
    if (token !== openRequestToken) return;
    announce(messageOf(error), "error");
  }
}

// ---------------------------------------------------------------------------
// Paste and URL-fetch forms
// ---------------------------------------------------------------------------

$("paste-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("paste-submit");
  if (button.getAttribute("aria-disabled") === "true") return;
  const url = $("paste-url").value.trim();
  const text = $("paste-text").value;
  button.setAttribute("aria-disabled", "true");
  try {
    const result = await postJson("/api/captures/paste", { url, text });
    $("paste-url").value = "";
    $("paste-text").value = "";
    await loadJobs();
    await reloadDetail(result.job.jobId);
    const extra = extractionMessage(result.extraction);
    announce(extra ? `${result.message} ${extra}` : result.message, "success");
  } catch (error) {
    announce(messageOf(error), "error");
  } finally {
    button.setAttribute("aria-disabled", "false");
  }
});

$("url-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("url-submit");
  if (button.getAttribute("aria-disabled") === "true") return;
  const url = $("url-input").value.trim();
  button.setAttribute("aria-disabled", "true");
  try {
    const result = await postJson("/api/captures/url", { url });
    $("url-input").value = "";
    await loadJobs();
    await reloadDetail(result.job.jobId);
    const extra = extractionMessage(result.extraction);
    announce(extra ? `${result.message} ${extra}` : result.message, "success");
  } catch (error) {
    announce(messageOf(error), "error");
  } finally {
    button.setAttribute("aria-disabled", "false");
  }
});

loadJobs();
