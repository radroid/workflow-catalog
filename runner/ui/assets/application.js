/* global document, window, fetch, requestAnimationFrame, ResizeObserver, setTimeout, clearTimeout */
// The Applications page (P05): prepare a saved job's resume (and cover
// letter, if wanted) from confirmed claims; answer the model's gap
// questions; see each version's documents, and every sentence beside the
// claim it cites. Talks to server/routes/applications.ts.
//
// House rules (P03's J4-J6, P04's L12 and T11-T19; runner/ui/assets/jobs.js
// is the reference this page follows):
// - One sticky "Last action" line is the page's only live region. Each
//   outcome is announced once, as one short sentence, consequence first.
//   Reasons and next steps live in the application's detail.
// - A focused node is never replaced (morphChildren/morphNode), a refresh
//   never moves it on screen (keepInPlace), and an open section stays open.
// - A control is aria-disabled while its request is in flight; the busy word
//   appears only after about 300 ms.
// - Nothing on the page shows a field name, a status code or an id. Every
//   refusal is a sentence chosen by the server's stable error `code`; the
//   only claim labels on the page are in "What changed and why", which shows
//   citations on purpose.
// - Amber marks one thing only: an open question that needs the person's
//   decision.
import { el } from "./runner.js";

const $ = (id) => document.getElementById(id);

/** P04's T18: a line that names a job is fitted to 80 characters, so it stays within the two-line clamp at 390 px. */
const NAMED_LINE_MAX = 80;
const FAST_REFRESH_MS = 2_000;
const SLOW_REFRESH_MS = 5_000;
const CANT_REACH = "Can't reach the runner. Is it still running?";

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

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Messages. A message is a hand-written string, or a list of pieces:
// hand-written strings, where `code` spans and [label](/path) links are
// rendered, and data(...) values (a job's name, a requirement, a claim, a
// sentence the model wrote), which are always plain text and never parsed.
// So nothing from a posting or a model can put markup or a link on the page.
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

/** `before“name”after`, with the name shortened so the whole sentence fits the line. */
function withName(before, name, after) {
  const room = Math.max(16, NAMED_LINE_MAX - plainOf(before).length - plainOf(after).length - 2);
  return [before, data(`“${shorten(name, room)}”`), after];
}

/** A value in quotes, for an element's children: el() appends a string as a text node, never as markup. */
function quote(text) {
  return `“${text}”`;
}

// ---------------------------------------------------------------------------
// The sticky "Last action" line: one live region, kept clear of a focused
// control (keepClear) and where it is on screen when the page changes
// around it (keepInPlace).
// ---------------------------------------------------------------------------

const TAGS = { done: "Last action", refused: "Refused", working: "Working" };

/** Runs `change`, then scrolls so the focused control is where it was on screen: nothing shifts under it. */
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
      text.title = plain;
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

/** The busy word appears only once a request has taken about 300 ms, so a quick one never flashes it. */
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
  if (!node || typeof node.getBoundingClientRect !== "function" || !node.isConnected) return;
  const top = $("last-action").getBoundingClientRect().bottom + 8;
  const rect = node.getBoundingClientRect();
  if (rect.top < top || rect.height > window.innerHeight - top) window.scrollBy(0, rect.top - top);
  else if (rect.bottom > window.innerHeight) window.scrollBy(0, rect.bottom - window.innerHeight + 8);
}

/** Brings `node` to just under the line, as it sits once stuck to the top of the viewport. */
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
// Rendering in place: a re-render never replaces a node that holds focus,
// so the control a person is using keeps it.
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

/** Whether the live element with `id` is open right now: a refresh renders it the same way. */
function isOpenNow(id) {
  return $(id)?.open === true;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const STAGE_WORDS = {
  saved: "Saved",
  preparing: "Preparing",
  ready: "Ready to send",
  applied: "Applied",
  interviewing: "Interviewing",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

/** What each validator rule means for the person (runner/validate/validator.ts). */
const RULE_WORDS = {
  uncited: "It doesn't point to any of your confirmed claims.",
  stray_marker: "It has bracketed text that isn't a claim reference.",
  unknown_citation: "It points to a claim that isn't one of your confirmed claims.",
  excluded_claim: "It drew on a claim you excluded.",
  unconfirmed_citation: "It points to a claim you haven't confirmed yet.",
  raw_id: "It contains an internal reference number.",
  number: "It states a number your confirmed claims don't.",
  date: "It states a date your confirmed claims don't.",
  title: "It words a job title differently from your confirmed claims.",
  credential: "It names a degree or certification your confirmed claims don't.",
  posting_wording: "It copies the job posting's wording instead of describing your experience.",
  heading: "It uses a section heading the runner doesn't.",
  empty: "A part of the document was empty.",
  requirements: "Not every requirement of the job was accounted for.",
};

const FORMAT_WORDS = { md: "Markdown", docx: "Word", pdf: "PDF" };
const KIND_WORDS = { resume: "Resume", cover_letter: "Cover letter", diff: "What changed and why" };

function formatDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** A server message chosen for the person, in plain words. Only these codes' messages are shown as they come. */
const PLAIN_SERVER_MESSAGES = new Set(["runner_not_running", "no_model"]);

/** The runner's own sentences name two pages; on this page each is a link (revision 1, V18). Only runner-written text passes through here. */
const PAGE_LINKS = [
  [/\bin Settings\b/g, "in [Settings](/ui/settings)"],
  [/\bthe Runs page\b/g, "the [Runs](/ui/runs) page"],
];

function withPageLinks(message) {
  return PAGE_LINKS.reduce((text, [pattern, link]) => text.replace(pattern, link), message);
}

/** What the PDF can't draw, and which formats keep it (revision 1, V16). `missing` is the person's own text: shown, never parsed. */
function pdfWarning(missing) {
  const shown = missing.slice(0, 6).map(quote);
  const list = shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown[0];
  const more = missing.length > 6 ? ` and ${plural(missing.length - 6, "more character")}` : "";
  const one = missing.length === 1;
  return `The PDF can't draw ${list}${more}, so it prints � in ${one ? "its" : "their"} place. The Markdown and Word files keep ${one ? "it" : "them"}.`;
}

// ---------------------------------------------------------------------------
// The list: readiness, the job picker, the applications
// ---------------------------------------------------------------------------

let listView = null;
let listSeq = 0;
let listShown = 0;
let listKey = "";
let openTaskId;
let detailSeq = 0;
let detailShown = 0;
let detailKey = "";
let openRequestToken = 0;

/** Why the runner can't prepare, in this page's words. The paused budget gets its own, with the pages that act on it (revision 1, V18). */
function runnerLine(runner) {
  if (runner.code === "budget_paused") return "The run budget is paused, so nothing can be prepared. Resume it in [Settings](/ui/settings); the [Runs](/ui/runs) page shows why it paused.";
  return PLAIN_SERVER_MESSAGES.has(runner.code) ? runner.message : "The runner can't prepare anything right now.";
}

function renderReady(view) {
  const items = [];
  const readiness = view.readiness;
  if (readiness.ready) {
    items.push(el("li", { className: "ready-ok", attrs: { id: "ready-profile" } }, `Your career profile, version ${readiness.profileVersion}, is approved.`));
  } else if (readiness.code === "profile_unreadable") {
    // The one case the Profile page is for: the file itself (revision 1, V12, V17).
    items.push(el("li", { className: "ready-blocked", attrs: { id: "ready-profile" } }, ...renderPieces("Your `career-profile.md` has an edit the runner can't read. Fix it on the [Profile](/ui/profile) page first.")));
  } else {
    // The reasons can quote a claim, so they are data, never markup; the way on is Onboarding, where evidence, sources and approval live.
    items.push(
      el("li", { className: "ready-blocked", attrs: { id: "ready-profile" } }, ...renderPieces([data(readiness.message ?? "Preparation is locked until your career profile is ready."), " Finish it on the [Onboarding](/ui/onboarding) page."])),
    );
  }
  if (view.runner.ready) items.push(el("li", { className: "ready-ok", attrs: { id: "ready-runner" } }, "The runner's agent is running."));
  else items.push(el("li", { className: "ready-blocked", attrs: { id: "ready-runner" } }, ...renderPieces(runnerLine(view.runner))));
  const { dailyRunLimit, runsUsedToday } = view.budget;
  if (runsUsedToday >= dailyRunLimit) {
    items.push(el("li", { className: "ready-blocked", attrs: { id: "ready-runs" } }, ...renderPieces(`Today's run limit is reached: ${runsUsedToday} of ${dailyRunLimit} runs. Raise it in [Settings](/ui/settings), or prepare tomorrow.`)));
  } else {
    items.push(el("li", { className: "ready-ok", attrs: { id: "ready-runs" } }, ...renderPieces(`Runs today: ${runsUsedToday} of ${dailyRunLimit}. Each preparation uses one; the daily limit is in [Settings](/ui/settings).`)));
  }
  if (view.details) items.push(el("li", { className: "ready-ok", attrs: { id: "ready-details" } }, "Documents will carry the name ", quote(view.details.name), "."));
  else items.push(el("li", { className: "ready-blocked", attrs: { id: "ready-details" } }, "Add your name below: every document carries it."));
  morphChildren($("ready-list"), items);
}

let detailsTouched = false;

/** The plain warning under the name field when the PDF can't draw part of the saved name or contact line (V16). */
function renderNameNote(details) {
  const node = $("details-name-note");
  const missing = details?.pdfMissing ?? [];
  const text = missing.length > 0 ? pdfWarning(missing) : "";
  if (node.textContent !== text) node.textContent = text;
  node.hidden = missing.length === 0;
}

function fillDetails(view) {
  renderNameNote(view.details);
  if (detailsTouched || !view.details) return;
  const name = $("details-name");
  const contact = $("details-contact");
  if (document.activeElement !== name) name.value = view.details.name;
  if (document.activeElement !== contact) contact.value = view.details.contact;
}

/** Whether the person chose a job in the picker: until then it follows the newest job whose details are extracted (V18). */
let jobPicked = false;

function renderJobPicker(view) {
  const select = $("prepare-job");
  const options = view.jobs.map((job) =>
    el("option", { text: job.extracted ? job.name : `${job.name} (details not extracted yet)`, attrs: { id: `job-option-${job.jobId}`, value: job.jobId } }),
  );
  morphChildren(select, options);
  const extracted = view.jobs.find((job) => job.extracted);
  if (!jobPicked && extracted && select.value !== extracted.jobId && document.activeElement !== select) select.value = extracted.jobId;
  $("prepare-form").hidden = view.jobs.length === 0;
  $("jobs-empty").hidden = view.jobs.length > 0;
}

$("prepare-job").addEventListener("change", () => {
  jobPicked = true;
});

function isRunning(state) {
  return state?.status === "running";
}

/**
 * The row's line. A parked preparation's line comes from its answers ("1 question left", "Ready to continue",
 * "Waiting for the evidence you're adding"), and amber marks it only while a question is open (revision 1, V11).
 */
function rowStatus(entry) {
  const state = entry.state;
  if (state.status === "running") return el("p", { className: "app-status muted small", text: "Preparing now…" });
  if (state.status === "parked" && state.open > 0) return el("p", { className: "app-status small" }, el("span", { className: "badge warn", text: "Needs your answer" }), " ", state.message);
  if (state.status === "parked") return el("p", { className: "app-status small", text: state.message });
  if (state.status === "failed" || state.status === "interrupted") return el("p", { className: "app-status refused small" }, ...renderPieces(withPageLinks(state.message)));
  return null;
}

function renderAppRow(entry) {
  const isOpen = entry.taskId === openTaskId;
  const button = el("button", { className: "app-open", text: entry.jobName, attrs: { type: "button", ...(isOpen ? { "aria-current": "true" } : {}) } });
  button.onclick = () => openApplication(entry.taskId);
  const facts = [STAGE_WORDS[entry.stage] ?? "Saved", entry.latestVersion ? `version ${entry.latestVersion}` : "no documents yet"].join(" · ");
  return el("li", { className: `app-row${isOpen ? " open" : ""}`, attrs: { id: `app-row-${entry.taskId}` } }, button, el("p", { className: "muted small app-meta", text: facts }), rowStatus(entry));
}

function renderUnreadable(view) {
  if (view.unreadable.length === 0) return [];
  const lead = view.unreadable.length === 1 ? "One application's record can't be read, so it isn't listed:" : `${view.unreadable.length} application records can't be read, so they aren't listed:`;
  return [el("li", { className: "app-unreadable small", attrs: { id: "app-unreadable" } }, el("p", { text: lead }), el("ul", {}, ...view.unreadable.map((entry) => el("li", {}, el("code", { text: entry.path })))))];
}

function renderList() {
  const view = listView;
  const key = JSON.stringify([openTaskId ?? null, view]);
  if (key === listKey) return;
  listKey = key;
  keepInPlace(() => {
    renderReady(view);
    fillDetails(view);
    renderJobPicker(view);
    const rows = [...view.applications.map(renderAppRow), ...renderUnreadable(view)];
    $("applications-empty").hidden = rows.length > 0;
    $("applications-list").hidden = rows.length === 0;
    morphChildren($("applications-list"), rows);
  });
}

/** Loads the list. Resolves true when it loaded, false (with the failure announced only on the first load) when it didn't. */
async function loadList({ announceErrors = false, onError } = {}) {
  const seq = (listSeq += 1);
  let view;
  try {
    view = await getJson("/api/applications");
  } catch (error) {
    onError?.(error);
    if (!announceErrors) return false;
    keepInPlace(() => {
      morphChildren($("applications-list"), []);
      morphChildren($("ready-list"), []);
    });
    unreachableShown = true;
    lastAction(error?.code === "unreachable" ? CANT_REACH : "Couldn't load your applications; reload the page to try again.", "refused");
    return false;
  }
  if (seq < listShown) return true;
  listShown = seq;
  listView = view;
  watchRunning(view, seq);
  renderList();
  return true;
}

// ---------------------------------------------------------------------------
// The open application: its state, questions, refusals, and versions
// ---------------------------------------------------------------------------

function answerButton(detail, question, answer, label) {
  const pressed = question.answer === answer;
  const button = el("button", {
    className: "button secondary answer",
    text: label,
    attrs: { type: "button", id: `answer-${detail.taskId}-${question.requirement}-${answer}`, "aria-pressed": String(pressed), "aria-disabled": "false" },
  });
  button.onclick = (event) => answerQuestion(detail.taskId, question.requirement, answer, event.currentTarget);
  return button;
}

function renderQuestions(detail) {
  const preparation = detail.preparation;
  const questions = preparation.questions;
  const items = questions.map((question) =>
    el(
      "li",
      { className: "question", attrs: { id: `question-${detail.taskId}-${question.requirement}` } },
      el("p", { className: "question-requirement small muted" }, `Requirement ${question.requirement}: `, quote(question.requirementText)),
      el("p", { className: "question-text", text: question.question }),
      el(
        "div",
        { className: "answer-buttons", attrs: { role: "group", "aria-label": `Your answer about requirement ${question.requirement}` } },
        answerButton(detail, question, "leave_out", "Leave it out"),
        answerButton(detail, question, "add_evidence", "I'll add evidence to my profile"),
      ),
    ),
  );
  const open = openQuestions(detail);
  // Amber, and the heading that asks, only while a question is open (revision 1, V11).
  const children = [
    el("h3", { attrs: { id: "questions-heading" }, text: open > 0 ? "Needs your answer" : "Your answers" }),
    el("p", { className: "small", text: "No confirmed claim meets these requirements, so the model asked instead of guessing. Nothing was drafted yet." }),
    el("ol", { className: "questions" }, ...items),
  ];
  const remaining = open === 1 ? "the last question" : open === 2 ? "both questions" : `all ${plural(open, "question")}`;
  if (open > 0) children.push(el("p", { className: "small muted", attrs: { id: "questions-next" }, text: `Answer ${remaining} to continue preparing.` }));
  else if (needsEvidence(detail)) children.push(el("p", { className: "small", attrs: { id: "questions-next" } }, ...renderPieces("Add that evidence on the [Onboarding](/ui/onboarding) page and approve it, then prepare this job again.")));
  else children.push(el("p", { className: "small", attrs: { id: "questions-next" }, text: "Every question is answered: continue preparing below." }));
  return el("div", { className: `questions-block notice${open > 0 ? " decision" : " answered"}`, attrs: { id: "detail-questions" } }, ...children);
}

/** The open application's questions, while its preparation waits for answers. */
function parkedQuestions(detail) {
  return detail.state.status === "parked" && detail.preparation?.status === "parked" ? detail.preparation.questions : [];
}

function openQuestions(detail) {
  return parkedQuestions(detail).filter((question) => question.answer === null).length;
}

function needsEvidence(detail) {
  return parkedQuestions(detail).some((question) => question.answer === "add_evidence");
}

function renderProblems(detail) {
  const problems = detail.preparation.problems;
  const items = problems.map((problem, index) =>
    el("li", { attrs: { id: `problem-${detail.taskId}-${index}` } }, el("span", { className: "problem-where", text: `${problem.where}: ` }), problem.sentence ? quote(problem.sentence) : null, problem.sentence ? " " : null, RULE_WORDS[problem.rule] ?? "The runner refused it."),
  );
  return el(
    "div",
    { className: "problems-block", attrs: { id: "detail-problems" } },
    el("h3", { text: `What the runner refused (${plural(problems.length, "problem")})` }),
    el("p", { className: "small", text: "Every sentence must state only what the confirmed claims it cites say. Nothing was saved." }),
    el("ul", { className: "problems" }, ...items),
  );
}

function coverageLine(detail, entry) {
  const claims = new Map((detail.preparation?.claims ?? []).map((claim) => [claim.label, claim.text]));
  // The same words as the questions block: "Requirement N: “…”". A line set aside is never quoted back (a posting can hide an instruction there).
  const head = entry.requirementText === null ? [`Requirement ${entry.requirement}`] : [`Requirement ${entry.requirement}: `, quote(entry.requirementText)];
  switch (entry.status) {
    case "covered": {
      // “A”, “B” and “C” (revision 1, V18).
      const joiner = (index) => (index === 0 ? "" : index === entry.labels.length - 1 ? " and " : ", ");
      return el("li", {}, ...head, el("span", { className: "muted" }, " — met by ", ...entry.labels.flatMap((label, index) => [joiner(index), quote(claims.get(label) ?? "a confirmed claim")]).filter(Boolean)));
    }
    case "left_out":
      return el("li", {}, ...head, el("span", { className: "muted", text: " — left out, as you asked." }));
    case "not_a_requirement":
      return el("li", {}, ...head, el("span", { className: "muted", text: " — set aside: this line isn't something the job asks of you." }));
    default:
      return el("li", {}, ...head, el("span", { className: "muted", text: " — waiting for your answer." }));
  }
}

function renderCoverage(detail) {
  const id = `coverage-${detail.taskId}`;
  return el(
    "details",
    { className: "coverage", attrs: { id, ...(isOpenNow(id) ? { open: "" } : {}) } },
    el("summary", { text: "How each requirement was met" }),
    el("ul", { className: "coverage-list" }, ...detail.preparation.coverage.map((entry) => coverageLine(detail, entry))),
  );
}

function place(change) {
  return change.part === "resume" ? `Resume, ${change.heading ?? "resume"}` : "Cover letter";
}

function changeItem(change) {
  const labels = change.labels.join(", ");
  switch (change.kind) {
    case "added":
      return el("li", {}, `Added, ${place(change)}: `, quote(change.text ?? ""), ` (cites ${labels})`);
    case "reworded":
      return el("li", {}, `Reworded, ${place(change)}: `, quote(change.text ?? ""), ` (same claims: ${labels})`);
    case "removed": {
      const gone = change.noLongerConfirmed ?? [];
      return el("li", {}, `Removed, ${place(change)}: the sentence that cited ${labels}${gone.length > 0 ? `; ${gone.join(", ")} ${gone.length === 1 ? "is" : "are"} no longer confirmed` : ""}.`);
    }
    default:
      return null;
  }
}

function renderChanges(detail, version) {
  const shown = version.changes.filter((change) => change.kind !== "unchanged");
  const unchanged = version.changes.length - shown.length;
  const items = shown.map(changeItem);
  // A re-export (revision 1, V8): the same sentences under a new name or contact line, in diff-v<n>.md's words.
  if (version.sameDraftAs) items.unshift(el("li", { text: `Only the name and contact line at the top changed. Every sentence is the same as in version ${version.sameDraftAs}, and no model ran.` }));
  else if (items.length === 0) items.push(el("li", { text: "Nothing changed in the wording." }));
  if (shown.length > 0 && unchanged > 0) items.push(el("li", { className: "muted", text: `Unchanged: ${plural(unchanged, "sentence")}.` }));
  return [el("h5", { text: `Since version ${version.replaces}` }), el("ul", { className: "changes" }, ...items)];
}

/** "What changed and why": every sentence beside the claim it cites, and how its wording differs. Citations are shown here on purpose. */
function renderStatements(detail, version) {
  const out = [];
  let group = "";
  let list = null;
  for (const statement of version.statements) {
    const heading = statement.part === "resume" ? `Resume, ${statement.heading ?? "resume"}` : `Cover letter, paragraph ${statement.section + 1}`;
    if (heading !== group) {
      group = heading;
      list = el("ol", { className: "statements" });
      out.push(el("h5", { text: heading }), list);
    }
    list.append(
      el(
        "li",
        { className: "statement" },
        el("p", { className: "statement-text" }, quote(statement.text)),
        ...statement.sources.map((source) => el("p", { className: "statement-source small" }, el("span", { className: "citation", text: `Cites ${source.label}` }), ` (${source.kind}): `, quote(source.text))),
        el("p", { className: "statement-change small muted", text: statement.presentation }),
      ),
    );
  }
  return out;
}

function renderVersion(detail, version, latest) {
  const id = `changes-${detail.taskId}-${version.version}`;
  const open = isOpenNow(id);
  const replaces = version.replaces ? ` It replaces version ${version.replaces}.` : "";
  const meta = version.sameDraftAs
    ? `Prepared ${formatDate(version.createdAt)} with your updated name and contact line: the same sentences as version ${version.sameDraftAs}.${replaces}`
    : `Prepared ${formatDate(version.createdAt)} from career profile version ${version.profileVersion} and job revision ${version.jobRevision}.${replaces}`;
  // What to prepare again for belongs to the latest version alone; an older one says which version replaced it (revision 1, V15).
  const notes = [];
  if (latest) {
    if (version.olderProfile) notes.push(el("p", { className: "version-note small", text: "Your career profile has changed since this version. Prepare again to use its current version." }));
    if (version.olderDetails) notes.push(el("p", { className: "version-note small", text: "Your name or contact line has changed since this version. Prepare again to put it on your documents." }));
    if (version.noLongerConfirmed.length > 0) {
      const n = version.noLongerConfirmed.length;
      notes.push(el("p", { className: "version-note small", text: `It cites ${plural(n, "claim")} you have since excluded or changed. Prepare again for a version without ${n === 1 ? "it" : "them"}.` }));
    }
  } else if (version.replacedBy) {
    notes.push(el("p", { className: "version-note small", text: `Version ${version.replacedBy} replaces it.` }));
  }
  // Each link names its version (V18) and downloads under the person's name, the document and the job (V14);
  // a PDF that can't draw every character says so beside it, and which formats keep them (V16).
  const files = el(
    "ul",
    { className: "exports" },
    ...version.files.map((file) =>
      el(
        "li",
        {},
        el("a", { attrs: { href: file.href, download: file.download ?? file.name } }, `${KIND_WORDS[file.kind] ?? "Document"}, version ${version.version} · ${FORMAT_WORDS[file.format] ?? file.format}`),
        " ",
        el("code", { text: file.name }),
        file.missing?.length > 0 ? el("p", { className: "export-note small", text: pdfWarning(file.missing) }) : null,
      ),
    ),
  );
  const details = el(
    "details",
    { className: "changes-detail", attrs: { id, ...(open ? { open: "" } : {}) } },
    el("summary", { text: "What changed and why" }),
    ...(version.replaces ? renderChanges(detail, version) : []),
    ...renderStatements(detail, version),
  );
  return el(
    "article",
    { className: "version", attrs: { id: `version-${detail.taskId}-${version.version}`, "aria-labelledby": `version-title-${detail.taskId}-${version.version}` } },
    el("h4", { attrs: { id: `version-title-${detail.taskId}-${version.version}` }, text: `Version ${version.version}${version.coverLetter ? " · resume and cover letter" : " · resume"}` }),
    el("p", { className: "muted small", text: meta }),
    ...notes,
    files,
    details,
  );
}

function renderStatus(detail) {
  const state = detail.state;
  const lines = [el("p", { className: "detail-stage", attrs: { id: "detail-stage" } }, STAGE_WORDS[detail.stage] ?? "Saved", detail.versions.length > 0 ? ` · ${plural(detail.versions.length, "version")}` : "")];
  if (state.status === "running") lines.push(el("p", { className: "detail-state muted small", attrs: { id: "detail-state" }, text: state.message }));
  else if (state.status === "failed" || state.status === "interrupted") lines.push(el("p", { className: "detail-state refused small", attrs: { id: "detail-state" } }, ...renderPieces(withPageLinks(state.message))));
  return el("div", { className: "detail-status", attrs: { id: "detail-status" } }, ...lines);
}

/**
 * The application's one action button, always present so a refresh never takes it from under focus: "Continue
 * preparing" once every question is answered, "Prepare again" otherwise. It is aria-disabled while a preparation
 * runs, while a request for it is in flight, and while a question is still open.
 */
function renderActions(detail) {
  const state = detail.state.status;
  const questions = parkedQuestions(detail);
  const continuing = questions.length > 0 && !needsEvidence(detail);
  const busy = state === "running" || preparingJobs.has(detail.jobId) || (continuing && openQuestions(detail) > 0);
  const coverLetter = detail.preparation?.coverLetter ?? false;
  const button = el("button", {
    className: continuing ? "button" : "button secondary",
    text: continuing ? "Continue preparing" : "Prepare again",
    attrs: { type: "button", id: "detail-prepare", "aria-disabled": String(busy) },
  });
  button.onclick = (event) => prepareJob(detail.jobId, coverLetter, event.currentTarget);
  const hint = state === "idle" && detail.versions.length > 0 ? el("p", { className: "small muted", text: "With nothing changed, preparing again writes nothing new." }) : null;
  return el("div", { className: "detail-actions", attrs: { id: "detail-actions" } }, button, hint);
}

function renderDetail(detail) {
  if ($("detail-title").textContent !== detail.jobName) $("detail-title").textContent = detail.jobName;
  const children = [renderStatus(detail)];
  const preparation = detail.preparation;
  // The questions and the refusals follow the state, not the attempt file alone: while a preparation is still
  // running, nothing it is about to replace shows as current.
  if (parkedQuestions(detail).length > 0) children.push(renderQuestions(detail));
  if (detail.state.status === "failed" && preparation?.status === "failed" && preparation.problems.length > 0) children.push(renderProblems(detail));
  children.push(renderActions(detail));
  if (preparation?.coverage?.length > 0) children.push(renderCoverage(detail));
  const versions = detail.versions.map((version, index) => renderVersion(detail, version, index === 0));
  children.push(
    el(
      "div",
      { className: "detail-versions", attrs: { id: "detail-versions" } },
      el("h3", { text: "Documents" }),
      ...(versions.length > 0 ? versions : [el("p", { className: "muted small", text: "No documents yet." })]),
    ),
  );
  morphChildren($("detail-body"), children.filter(Boolean));
}

function showDetail(detail) {
  const key = JSON.stringify(detail);
  if (key === detailKey) return;
  detailKey = key;
  keepInPlace(() => renderDetail(detail));
}

async function reloadDetail() {
  const taskId = openTaskId;
  if (!taskId) return;
  const seq = (detailSeq += 1);
  let detail;
  try {
    detail = await getJson(`/api/applications/${taskId}`);
  } catch {
    return;
  }
  if (openTaskId !== taskId || seq < detailShown) return;
  detailShown = seq;
  showDetail(detail);
}

/** Opens `taskId`'s detail. `focus: true` (a click on its row) moves focus to its heading; a preparation this page started opens it without moving focus. */
async function openApplication(taskId, { focus = true, detail: known } = {}) {
  const token = (openRequestToken += 1);
  let detail = known;
  if (!detail) {
    try {
      detail = await getJson(`/api/applications/${taskId}`);
    } catch (error) {
      if (token === openRequestToken) lastAction(error?.code === "unreachable" ? CANT_REACH : "Couldn't open that application; reload the page to try again.", "refused");
      return;
    }
  }
  if (token !== openRequestToken) return;
  openTaskId = taskId;
  detailSeq += 1;
  detailShown = detailSeq;
  showDetail(detail);
  $("detail-section").hidden = false;
  if (listView) renderList();
  if (!focus) return;
  const heading = $("detail-title");
  heading.focus({ preventScroll: true });
  scrollUnderLine(heading);
}

// ---------------------------------------------------------------------------
// Refreshing: every 2 s while a preparation runs, every 5 s otherwise, only
// while the page is visible. Announces, once each, the results of the
// preparations it watches: the ones this page started, and every one the
// list showed running, so a reload or a revisit mid-preparation still hears
// how it ended (revision 1, V13). The results one refresh brings share one
// message, so none is lost behind another (revision 2, X6).
// ---------------------------------------------------------------------------

/** Watched preparations: taskId → the job's name. */
const started = new Map();

/**
 * Applications whose outcome this page announced from its own request's answer (already prepared, re-exported,
 * refused), by the count of list requests made before that answer. A re-export is in flight for a moment too, so
 * a list requested before the answer may still show it running: that list must not watch it again, or its next
 * refresh would announce the same outcome a second time.
 */
const answeredAt = new Map();

function answered(taskId) {
  if (!taskId) return;
  started.delete(taskId);
  answeredAt.set(taskId, listSeq);
}

/** Watches every application the list (requested as number `seq`) shows running, unless the page announced its outcome since. */
function watchRunning(view, seq) {
  for (const entry of view.applications) {
    if (!isRunning(entry.state) || started.has(entry.taskId)) continue;
    if ((answeredAt.get(entry.taskId) ?? 0) >= seq) continue;
    started.set(entry.taskId, entry.jobName);
  }
}

/** Whether the "can't reach the runner" line is up: it is announced once per outage, and cleared by the next good refresh. */
let unreachableShown = false;

function lineText() {
  return $("last-action").querySelector(".text").textContent;
}

/** A watched preparation couldn't be refreshed: say so once, however many refreshes fail after it. */
function showUnreachable(error) {
  if (unreachableShown || started.size === 0) return;
  unreachableShown = true;
  const unreachable = error?.code === "unreachable";
  lastAction(unreachable ? CANT_REACH : "Couldn't refresh your applications: the runner hit a problem.", "refused");
  if (!unreachable) return;
  // "The runner's agent is running." was true at the last refresh, not now; the next good refresh renders it from the runner again.
  const runner = $("ready-runner");
  if (runner) {
    runner.className = "ready-blocked";
    runner.textContent = "The runner can't be reached right now.";
  }
  listKey = "";
}

/** The first good refresh after an outage: the line stops saying the runner can't be reached, and says what is true now. */
function clearUnreachable() {
  if (!unreachableShown) return;
  unreachableShown = false;
  const text = lineText();
  if (text !== CANT_REACH && text !== "Couldn't refresh your applications: the runner hit a problem." && text !== "Couldn't load your applications; reload the page to try again.") return;
  const entries = [...started].map(([taskId, name]) => ({ name, entry: listView?.applications.find((application) => application.taskId === taskId) }));
  const running = entries.find(({ entry }) => entry && isRunning(entry.state));
  const settling = entries.some(({ entry }) => entry && !isRunning(entry.state));
  if (running) lastAction(withName("Still preparing ", running.name, "…"), "working");
  else if (!settling) lastAction("Reached the runner again.", "done");
  // Otherwise announceSettled, next, says how the watched preparation ended.
}

/** How a watched preparation that stopped running ended, or null when there is nothing to announce. */
function outcomeOf(entry) {
  // Parked: only while a question is open. Once every one is answered (in another tab, say), the row says what is next.
  if (entry.state.status === "parked") return entry.state.open > 0 ? "answers" : null;
  return entry.state.status === "idle" && entry.latestVersion ? "prepared" : "failed";
}

/** Names in quotes, as data: “A”, “A” and “B”, “A”, “B” and “C”. */
function namesPhrase(names, joiner) {
  return names.flatMap((name, index) => [...(index === 0 ? [] : [index === names.length - 1 ? ` ${joiner} ` : ", "]), data(`“${name}”`)]);
}

/**
 * Every outcome that settled in one refresh, as one sentence (revision 2, X6), each job named once: what couldn't
 * be prepared first, then what needs answers, then what was prepared. The names are shortened evenly so the line
 * fits NAMED_LINE_MAX (P04's T18); when even the shortest names can't fit, it counts the outcomes instead.
 */
function settledMessage(settled) {
  if (settled.length === 1) {
    const [{ kind, name, version }] = settled;
    if (kind === "answers") return withName("Needs your answers: ", name, ".");
    if (kind === "prepared") return withName("Prepared ", name, `: version ${version} is ready.`);
    return withName("Couldn't prepare ", name, "; its details say why.");
  }
  const namesOf = (kind) => settled.filter((outcome) => outcome.kind === kind).map((outcome) => outcome.name);
  const failed = namesOf("failed");
  const answers = namesOf("answers");
  const prepared = namesOf("prepared");
  const sentence = (room) => {
    const fitted = (names) => names.map((name) => shorten(name, room));
    const clauses = [];
    if (failed.length > 0) clauses.push(["Couldn't prepare ", ...namesPhrase(fitted(failed), "or")]);
    if (answers.length > 0) clauses.push([...namesPhrase(fitted(answers), "and"), answers.length === 1 ? " needs your answers" : " need your answers"]);
    if (prepared.length > 0) clauses.push([clauses.length === 0 ? "Prepared " : "prepared ", ...namesPhrase(fitted(prepared), "and")]);
    return [...clauses.flatMap((clause, index) => (index === 0 ? clause : ["; ", ...clause])), "."];
  };
  for (let room = Math.max(...settled.map((outcome) => outcome.name.length)); room >= 16; room -= 1) {
    const message = sentence(room);
    if (plainOf(message).length <= NAMED_LINE_MAX) return message;
  }
  const counts = [];
  if (failed.length > 0) counts.push(`${failed.length} couldn't be prepared`);
  if (answers.length > 0) counts.push(`${answers.length} ${answers.length === 1 ? "needs" : "need"} your answers`);
  if (prepared.length > 0) counts.push(`${prepared.length} ${prepared.length === 1 ? "is" : "are"} ready`);
  return `${plural(settled.length, "application")}: ${counts.join(", ")}.`;
}

/** Announces how the watched preparations that stopped running since the last refresh ended: all of them, once, in one message (X6). */
function announceSettled() {
  const settled = [];
  for (const [taskId, name] of [...started]) {
    const entry = listView?.applications.find((application) => application.taskId === taskId);
    if (!entry || isRunning(entry.state)) continue;
    started.delete(taskId);
    const kind = outcomeOf(entry);
    if (kind) settled.push({ kind, name, version: entry.latestVersion });
  }
  if (settled.length === 0) return;
  lastAction(settledMessage(settled), settled.some((outcome) => outcome.kind === "failed") ? "refused" : "done");
}

function anyActive() {
  if (started.size > 0) return true;
  return Boolean(listView?.applications.some((entry) => isRunning(entry.state)));
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
    let failure = null;
    const loaded = await loadList({ ...options, onError: (error) => (failure = error) });
    if (!loaded) {
      if (!options.announceErrors) showUnreachable(failure);
      return;
    }
    await reloadDetail();
    clearUnreachable();
    announceSettled();
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
    void refresh().catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Preparing
// ---------------------------------------------------------------------------

/** Refusals before anything runs, by the server's stable code: one short sentence each; the page's sections carry the detail. */
const PREPARE_REFUSALS = {
  details_missing: "Not prepared: add your name for the documents first.",
  not_extracted: "Not prepared: extract this job's details on the [Jobs](/ui/jobs) page first.",
  not_ready: "Not prepared: preparation is locked until your profile is ready.",
  profile_unreadable: "Not prepared: your `career-profile.md` has an edit the runner can't read.",
  application_unreadable: "Not prepared: a damaged application record may be this job's; see Applications below.",
  needs_answers: "Not prepared: answer the open questions first.",
  needs_profile: "Not prepared: add the missing evidence on the [Onboarding](/ui/onboarding) page first.",
  runner_not_running: "Not prepared: the runner's agent isn't running.",
  no_model: "Not prepared: no model is set up.",
  budget_paused: "Not prepared: the run budget is paused; resume it in [Settings](/ui/settings).",
  snapshot_unreadable: "Not prepared: this job's saved posting can't be read.",
  reexport_refused: "Not re-exported: its saved sentences no longer pass the runner's checks.",
  job_not_found: "Not prepared: that job couldn't be found.",
  profile_busy: "Not prepared: your profile is busy; try again in a moment.",
  unreachable: CANT_REACH,
};

/** Moves focus to the name field and brings it clear of the line: where the person acts next. */
function focusNameField() {
  const field = $("details-name");
  field.focus({ preventScroll: true });
  keepClear(field);
}

/** Jobs whose prepare request is in flight: a refresh renders their action button aria-disabled until it answers. */
const preparingJobs = new Set();

async function prepareJob(jobId, coverLetter, button) {
  if (!button || button.getAttribute("aria-disabled") === "true" || !jobId) return;
  button.focus();
  button.setAttribute("aria-disabled", "true");
  preparingJobs.add(jobId);
  workingAfterDelay("Starting…");
  let result;
  try {
    result = await postJson("/api/applications/prepare", { jobId, coverLetter });
  } catch (error) {
    preparingJobs.delete(jobId);
    button.setAttribute("aria-disabled", "false");
    detailKey = ""; // the next refresh renders the open application's button from its data again
    answered(listView?.jobs.find((job) => job.jobId === jobId)?.taskId);
    lastAction(PREPARE_REFUSALS[error?.code] ?? "Not prepared: the runner hit a problem; try again.", "refused");
    // The name is what's missing: the name field is where to go next (revision 1, V18).
    if (error?.code === "details_missing") focusNameField();
    await refresh().catch(() => undefined);
    return;
  }
  preparingJobs.delete(jobId);
  stopWorking();
  button.setAttribute("aria-disabled", "false");
  const detail = result.application;
  if (result.outcome === "already_prepared" || result.outcome === "reexported") answered(detail.taskId);
  if (result.outcome === "already_prepared") {
    lastAction(withName("Already prepared: ", detail.jobName, ` matches version ${result.version}; nothing new.`), "done");
  } else if (result.outcome === "reexported") {
    // The checked draft went out again with no model turn (V8): under a new name or contact line, or, when those
    // are unchanged, as the newest version again after a newer one made from other inputs (X5).
    const how = result.newDetails === false ? `, from version ${result.sameDraftAs}'s sentences.` : ", with your new details.";
    lastAction(withName("Re-exported ", detail.jobName, ` as version ${result.version}${how}`), "done");
  } else if (result.outcome === "already_running") {
    lastAction(withName("Already preparing ", detail.jobName, "…"), "working");
    started.set(detail.taskId, detail.jobName);
  } else {
    lastAction(withName("Preparing ", detail.jobName, "…"), "working");
    started.set(detail.taskId, detail.jobName);
  }
  detailKey = ""; // render the answer's detail even if it matches what is shown: the button's state comes from it
  await openApplication(detail.taskId, { focus: false, detail });
  await refresh().catch(() => undefined);
}

$("prepare-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void prepareJob($("prepare-job").value, $("prepare-cover").checked, $("prepare-submit"));
});

// ---------------------------------------------------------------------------
// Answering a gap question
// ---------------------------------------------------------------------------

async function answerQuestion(taskId, requirement, answer, button) {
  if (!button || button.getAttribute("aria-disabled") === "true") return;
  button.focus();
  button.setAttribute("aria-disabled", "true");
  workingAfterDelay("Saving…");
  let result;
  try {
    result = await postJson(`/api/applications/${taskId}/answers`, { requirement, answer });
  } catch (error) {
    button.setAttribute("aria-disabled", "false");
    const message = error?.code === "unreachable" ? CANT_REACH : error?.code === "no_open_question" ? "Not saved: that question isn't open any more." : "Not saved: the runner hit a problem; try again.";
    lastAction(message, "refused");
    await refresh().catch(() => undefined);
    return;
  }
  stopWorking();
  button.setAttribute("aria-disabled", "false");
  // The person is answering its questions, so they know it parked: a refresh that sees it only now says nothing more.
  started.delete(taskId);
  lastAction(answer === "leave_out" ? `Answered: requirement ${requirement} will be left out.` : `Answered: add evidence for requirement ${requirement} to your profile.`, "done");
  if (openTaskId === taskId) {
    detailSeq += 1;
    detailShown = detailSeq;
    showDetail(result.application);
  }
  await refresh().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// The documents' header
// ---------------------------------------------------------------------------

function setNameError(detail) {
  const field = $("details-name");
  const node = $("details-name-error");
  if (detail) {
    field.setAttribute("aria-invalid", "true");
    node.textContent = detail;
    node.hidden = false;
  } else {
    field.removeAttribute("aria-invalid");
    node.textContent = "";
    node.hidden = true;
  }
}

for (const id of ["details-name", "details-contact"]) {
  $(id).addEventListener("input", () => {
    detailsTouched = true;
    if (id === "details-name") setNameError("");
  });
}

$("details-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("details-submit");
  if (button.getAttribute("aria-disabled") === "true") return;
  const name = $("details-name").value.trim();
  const contact = $("details-contact").value.trim();
  if (!name) {
    const field = $("details-name");
    const stayed = document.activeElement === field;
    setNameError("Enter your name as it should appear on your documents.");
    lastAction(stayed ? "Not saved: your name is empty." : "Not saved.", "refused");
    if (!stayed) focusNameField();
    return;
  }
  button.setAttribute("aria-disabled", "true");
  workingAfterDelay("Saving…");
  let result;
  try {
    result = await postJson("/api/applications/details", { name, contact });
  } catch (error) {
    lastAction(error?.code === "unreachable" ? CANT_REACH : "Not saved: the runner hit a problem; try again.", "refused");
    return;
  } finally {
    stopWorking();
    button.setAttribute("aria-disabled", "false");
  }
  detailsTouched = false;
  setNameError("");
  renderNameNote(result.details);
  // What's true: documents already prepared keep the header they were made with until they're prepared again (V8).
  lastAction(result.outdated > 0 ? "Saved. Prepare again to put it on your documents." : "Saved: your documents will carry this name.", "done");
  await refresh().catch(() => undefined);
});

trackLastActionHeight();
void refresh({ announceErrors: true }).catch(() => undefined);
