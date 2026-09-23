/**
 * Pure popup rendering. Split out of main.ts so these three states can be
 * unit-tested (and, for the P07-A acceptance screenshots, driven directly
 * with real extractor/build-job-capture output) without pulling in
 * main.ts's top-level orchestration side effects (`applyColorScheme()`
 * running immediately, `void run()` calling real `chrome.tabs`/
 * `chrome.scripting` APIs at import time, and the `#app`-must-already-exist
 * assertion).
 */
import type { JobCapture } from "@workflow-catalog/contracts";
import type { ExtractedStructuredHints } from "../capture/extractor";
import { bridgeClient, type BridgeError } from "../shared/bridge-client";
import { el, mount } from "../shared/dom";
import { downloadJson } from "../shared/download";
import { enqueueCapture, failureAction } from "../shared/outbox";
import { getDeviceToken, getPairedBefore, setLastJobCapture } from "../shared/storage";
import { FLASH_CLASS, type Tone } from "../shared/tone";

// P02's local UI serves /ui/<name> (runner/server/local-ui.ts: `<uiDir>/<page>.html`
// mounted at /ui/<page>, no literal ".html" in the URL) -- P07-B syncs this
// path now that P02 has landed (part A guessed at a literal jobs.html file,
// before P02's router existed to check against). P04 adds the page itself.
const RUNNER_JOBS_URL = "http://127.0.0.1:4310/ui/jobs";

export function renderLoading(app: Element): void {
  mount(
    app,
    el("main", { className: "popup stack" }, [
      el("h1", { className: "eyebrow", text: "Job Assistant" }),
      el("p", { className: "small", text: "Reading this page…" }),
    ]),
  );
}

export function renderFallback(app: Element, reason: string): void {
  mount(
    app,
    el("main", { className: "popup stack" }, [
      el("h1", { className: "eyebrow", text: "Job Assistant" }),
      el("div", { className: "flash bad", attrs: { role: "alert" }, text: reason }),
      el("p", { className: "small" }, [
        "Paste the posting in the runner's Jobs page instead: ",
        el("a", { attrs: { href: RUNNER_JOBS_URL, target: "_blank", rel: "noopener" }, text: RUNNER_JOBS_URL }),
      ]),
    ]),
  );
}

export function formatBytes(byteLength: number): string {
  if (byteLength < 1024) return `${byteLength} B`;
  return `${(byteLength / 1024).toFixed(1)} KB`;
}

/** What `sendToBridge` tells the caller to show: whether the capture is
 * now the runner's (`sent`), safely queued in this browser (`queued`), or
 * neither (`not_sent`); the status sentence, its tone (shared/tone.ts),
 * and for a refusal the reason on a line of its own; and whether the two
 * secondary actions (manual file export, jump to Settings) should be
 * offered for this outcome. */
interface SendOutcome {
  readonly kind: "sent" | "queued" | "not_sent";
  readonly message: string;
  readonly detail?: string;
  readonly tone: Tone;
  readonly offerFileSave: boolean;
  readonly offerSettings: boolean;
}

/** P07-B revision 3, H2: every refusal leads with what happened to the
 * capture and what the person can do next. Revision 2 showed the bridge's
 * own message alone ("This eventId was already used for a different
 * event. Use a new eventId for a new event."): a field name, and an
 * instruction nobody can carry out from the popup. */
export const REFUSED_MESSAGE =
  "The runner refused this capture, so it wasn't saved. Save it as a file, or reopen the popup to capture it again.";

/** Plain reasons for the bridge's own refusals of `POST /events`
 * (runner/server/http.ts, events.ts, app.ts). Any other code comes from a
 * route handler's `EventRejectedError` (runner/server/route-modules.ts),
 * whose message is written for people and is shown as it is. */
const REFUSAL_REASONS: Readonly<Record<string, string>> = {
  event_id_conflict: "It clashes with a different capture the runner already has.",
  body_too_large: "It's larger than the runner accepts.",
  invalid_body: "The runner couldn't read it.",
  invalid_json: "The runner couldn't read it.",
  unsupported_media_type: "The runner couldn't read it.",
  not_found: "This version of the runner doesn't take captures.",
};

function refusalReason(error: BridgeError): string {
  return REFUSAL_REASONS[error.code] ?? error.message;
}

/** P07-B revision 3, nit 4: the browser couldn't store the capture (e.g.
 * storage.session's quota), so it isn't queued either; the file export is
 * the one way left to keep it, and is offered. */
export const NOT_STORED_MESSAGE = "Couldn't save this capture: the browser wouldn't store it. Save it as a file instead.";

/** Why a capture was queued paused -- only a person can fix these (see
 * shared/outbox.ts's `failureAction`). Revision 3 polish: "Not paired yet"
 * only for a browser that has never paired. */
function pausedMessage(error: BridgeError, pairedBefore: boolean): string {
  if (error.status === 401) return "Your pairing expired or was revoked. Pair again in Settings and it's sent.";
  if (error.status === 403) return "This pairing belongs to a different install. Pair again in Settings.";
  if (pairedBefore) return "Not paired — queued. It'll be sent automatically once you pair the extension again in Settings.";
  return "Not paired yet — queued. It'll be sent automatically once you pair the extension in Settings.";
}

/** Why a capture was queued for the worker's automatic retry. */
function retryMessage(error: BridgeError): string {
  if (error.code === "invalid_response" || error.code === "unknown_error") {
    return "Something other than the runner is answering on its port — queued. It'll be sent once the runner answers.";
  }
  if (error.code === "token_replaced") return "Queued — this browser was just paired again. It'll be sent shortly.";
  // Revision 3 polish: a real 5xx is the runner answering, not "isn't
  // reachable".
  if (error.status !== undefined && error.status >= 500) return "The runner had a problem; trying again.";
  return "The runner isn't reachable right now — it'll be sent automatically once it's back.";
}

/**
 * Posts `capture` to the bridge as a `job_capture` event and classifies the
 * result with the same `failureAction` the worker's retry flush uses
 * (P07-B revision 2: one classification, so Save and the retry can never
 * disagree about the same failure). E1 (revision 1): the bridge is tried
 * first and nothing is downloaded here at all.
 *
 * - Accepted (including a replay the bridge reports `duplicate: true` for
 *   -- gate 1: still just "sent", not an error): says so, offers neither
 *   secondary action -- the runner already has it.
 * - `pause` (not paired yet -- E2; or the bridge refused this browser's
 *   token, 401, or origin, 403): queues the capture paused, so it's sent
 *   the moment a pairing succeeds, and offers both a manual file export and
 *   a way to Settings to pair.
 * - `retry` (the runner isn't running or didn't answer in time, a 5xx,
 *   something other than the runner answered on its port, or a pairing
 *   replaced the token mid-request): queues the capture for the worker's
 *   alarm-driven retry and says so -- Save never loses a capture just
 *   because the runner wasn't there for a moment.
 * - `drop` (the bridge itself refused this exact request: 400, 409, 413,
 *   ...): not queued -- resending it can never succeed -- and not "saved"
 *   either (revision 2, C3): says so in plain words, with the reason on its
 *   own line (revision 3, H2), and offers the file export.
 *
 * Tones (revision 3, H1): sent is `ok`; a retry the worker makes on its own
 * is `info`; a pause, which waits on the person pairing (again), is `act`;
 * a refusal is `bad`.
 */
async function sendToBridge(capture: JobCapture): Promise<SendOutcome> {
  // The pairing this attempt is made under, read before it: a pause is
  // stamped with it (shared/outbox.ts's `pausedFor`, revision 3).
  const pairing = await getDeviceToken();
  const result = await bridgeClient.postEvent(capture);
  if (result.ok) {
    return { kind: "sent", message: "Sent to the runner.", tone: "ok", offerFileSave: false, offerSettings: false };
  }
  const error: BridgeError = result.error;
  const action = failureAction(error);
  if (action === "drop") {
    return { kind: "not_sent", message: REFUSED_MESSAGE, detail: refusalReason(error), tone: "bad", offerFileSave: true, offerSettings: false };
  }
  await enqueueCapture(capture, error, pairing?.deviceId ?? null);
  if (action === "pause") {
    return { kind: "queued", message: pausedMessage(error, await getPairedBefore()), tone: "act", offerFileSave: true, offerSettings: true };
  }
  return { kind: "queued", message: retryMessage(error), tone: "info", offerFileSave: true, offerSettings: false };
}

export function renderPreview(
  app: Element,
  capture: JobCapture,
  structured: ExtractedStructuredHints,
): void {
  const sizeBytes = new TextEncoder().encode(capture.text).length;

  const kvRows: Array<Node | string> = [el("dt", { text: "URL" }), el("dd", { text: capture.url })];
  if (structured.title) {
    kvRows.push(el("dt", { text: "Title" }), el("dd", { text: structured.title }));
  }
  if (structured.company) {
    kvRows.push(el("dt", { text: "Company" }), el("dd", { text: structured.company }));
  }
  if (structured.location) {
    kvRows.push(el("dt", { text: "Location" }), el("dd", { text: structured.location }));
  }
  kvRows.push(el("dt", { text: "Size" }), el("dd", { text: formatBytes(sizeBytes) }));

  const saveButton = el("button", { className: "primary", text: "Save this job" });
  // P07-B revision 1, E1: "Save as a file" is now an explicit secondary
  // action, offered (shown) only once a Save attempt reveals the bridge
  // isn't going to have this capture -- not, as in part A, an automatic
  // download on every Save. Hidden by default; sendToBridge's outcome
  // decides whether to reveal it.
  const fileButton = el("button", { className: "ghost", text: "Save as a file" });
  fileButton.hidden = true;
  // B11: the not-paired/expired/wrong-install states all point here.
  // chrome.runtime.openOptionsPage() is the one-name-throughout "Settings"
  // this popup and the options page's own copy both now use.
  const settingsButton = el("button", { className: "ghost", text: "Open settings" });
  settingsButton.hidden = true;
  const status = el("p", { className: "flash", attrs: { role: "status", "aria-live": "polite" } });

  fileButton.addEventListener("click", () => {
    downloadJson("job-capture.json", capture);
  });
  settingsButton.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  // Polish: pressing "Saved ✓" used to re-run the whole save (and, under
  // part A's design, re-download the file) every time -- guarded here
  // instead of via the native `disabled` attribute, because disabling a
  // currently-focused button forces focus to <body>, which the existing
  // no-focus-loss rule (B7 carry-forward) already forbids. A plain
  // in-closure guard makes a repeat click an inert no-op without touching
  // focus at all; `aria-disabled` (unlike `disabled`) still tells a screen
  // reader it's inert without removing it from the tab order, and
  // base.css makes it look inert. Only once the capture really is the
  // runner's or queued: a `not_sent` outcome leaves the button live
  // (revision 2, C3). P07-B revision 3 polish: "Saving…" works the same
  // way -- revision 2 set `disabled` for it, which dropped focus to <body>
  // for as long as the runner took to answer (up to the 5 s timeout).
  let saved = false;
  let saving = false;

  function showOutcome(message: string, tone: Tone, detail?: string): void {
    status.replaceChildren(message, ...(detail === undefined ? [] : [el("span", { className: "detail", text: detail })]));
    status.className = FLASH_CLASS[tone];
  }

  saveButton.addEventListener("click", () => {
    void (async () => {
      if (saved || saving) return;
      saving = true;
      saveButton.setAttribute("aria-disabled", "true");
      saveButton.textContent = "Saving…";
      try {
        // Storage first, always: whatever sendToBridge below decides,
        // the options page's export view can still recover this exact
        // capture (P07 packet part A: "If a popup closing on focus loss
        // breaks the download, hand off to the options page's export
        // view").
        await setLastJobCapture(capture);
        const outcome = await sendToBridge(capture);
        showOutcome(outcome.message, outcome.tone, outcome.detail);
        fileButton.hidden = !outcome.offerFileSave;
        settingsButton.hidden = !outcome.offerSettings;
        if (outcome.kind === "not_sent") {
          saveButton.textContent = "Save this job";
          saveButton.removeAttribute("aria-disabled");
        } else {
          saveButton.textContent = "Saved ✓";
          saved = true;
        }
      } catch {
        // Storage refused it (revision 3, nit 4): not queued, not the
        // runner's -- the file export is what's left.
        showOutcome(NOT_STORED_MESSAGE, "bad");
        fileButton.hidden = false;
        settingsButton.hidden = true;
        saveButton.textContent = "Save this job";
        saveButton.removeAttribute("aria-disabled");
      } finally {
        saving = false;
        // Focus never left the button (aria-disabled, not disabled); only
        // put it back if it was dropped, never take it from wherever the
        // person moved it meanwhile.
        if (document.activeElement === null || document.activeElement === document.body) saveButton.focus();
      }
    })();
  });

  mount(
    app,
    el("main", { className: "popup stack" }, [
      el("h1", { className: "eyebrow", text: "Job Assistant" }),
      el("dl", { className: "kv" }, kvRows),
      el(
        "div",
        {
          className: "card pad excerpt",
          attrs: {
            tabindex: "0",
            role: "region",
            "aria-label": "Full captured text (scrollable)",
          },
        },
        // capture.text has already been through shared/text.ts's
        // normalizeWhitespace (build-job-capture.ts, before this ever
        // renders), which caps runs of 3+ blank lines down to one --
        // review issue 8's "collapse blank lines" without a second,
        // redundant collapsing pass here on what's already collapsed.
        [capture.text],
      ),
      el("p", {
        className: "small",
        text: "This page's text is saved as data. It can't trigger actions, no matter what it says.",
      }),
      el("div", { className: "row" }, [saveButton, fileButton, settingsButton]),
      status,
    ]),
  );
}
