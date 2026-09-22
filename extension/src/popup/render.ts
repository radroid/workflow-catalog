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
import { enqueueCapture } from "../shared/outbox";
import { setLastJobCapture } from "../shared/storage";

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

/** What `sendToBridge` tells the caller to show: the status sentence, and
 * whether the two secondary actions (manual file export, jump to Settings)
 * should be offered for this outcome. */
interface SendOutcome {
  readonly message: string;
  readonly problem: boolean;
  readonly offerFileSave: boolean;
  readonly offerSettings: boolean;
}

function ok(message: string): SendOutcome {
  return { message, problem: false, offerFileSave: false, offerSettings: false };
}

function queued(message: string, offerSettings: boolean): SendOutcome {
  return { message, problem: true, offerFileSave: true, offerSettings };
}

/**
 * Posts `capture` to the bridge as a `job_capture` event and classifies the
 * result (P07-B revision 1, B3 -- branches on status/code instead of one
 * blanket "isn't reachable right now" for every failure; E1 -- the bridge
 * is tried first and nothing is downloaded here at all, unlike part A's
 * design, which always exported a file before ever trying the bridge):
 *
 * - Reachable and accepted (including a replay the bridge reports
 *   `duplicate: true` for -- gate 1: still just "sent", not an error):
 *   says so, offers neither secondary action -- the runner already has it.
 * - Not paired yet (E2, supersedes part A's "don't queue before ever
 *   pairing" design): queues the capture (paused -- see shared/outbox.ts)
 *   so it's sent the moment pairing succeeds, and offers both a manual
 *   file export and a way to Settings to pair.
 * - 401 (token invalid: expired or revoked) or 403 (origin_not_allowed:
 *   this pairing belongs to a different browser/install): queues the
 *   capture paused -- retrying the exact same request against the exact
 *   same dead token/wrong origin can only repeat the same refusal, so
 *   shared/outbox.ts stops spending alarms on it until a fresh pairing
 *   flushes it again (E2) -- and offers both secondary actions.
 * - Any other 4xx (400 invalid body, 409 event id conflict, 413 too large,
 *   422, ...): never queued (retrying an identical, already-refused
 *   request cannot ever succeed) and shows the bridge's own specific
 *   message, with only the file-export secondary action offered (Settings
 *   cannot fix this class of failure).
 * - network_error (the runner isn't running, or didn't answer in time) or
 *   a 5xx: queues the capture for the worker's alarm-driven retry
 *   (shared/outbox.ts) and says so, so Save never silently loses a capture
 *   just because the runner was unreachable for a moment.
 */
async function sendToBridge(capture: JobCapture): Promise<SendOutcome> {
  const result = await bridgeClient.postEvent(capture);
  if (result.ok) {
    return ok("Sent to the runner.");
  }
  const error: BridgeError = result.error;
  if (error.code === "not_paired") {
    await enqueueCapture(capture, error);
    return queued("Not paired yet — queued. It'll be sent automatically once you pair the extension in Settings.", true);
  }
  if (error.status === 401) {
    await enqueueCapture(capture, error);
    return queued("Your pairing expired or was revoked. Pair again in Settings and it's sent.", true);
  }
  if (error.status === 403) {
    await enqueueCapture(capture, error);
    return queued("This pairing belongs to a different install. Pair again in Settings.", true);
  }
  if (error.code === "network_error" || (error.status !== undefined && error.status >= 500)) {
    await enqueueCapture(capture, error);
    return queued("The runner isn't reachable right now — it'll be sent automatically once it's back.", false);
  }
  // Any other 4xx (the bridge's own message is already specific --
  // runner/server/http.ts's validationErrorResponse names the exact
  // field, body_too_large names the byte cap, ...), or invalid_response
  // (something answered on the port but not with a shape this bridge
  // would ever send -- B4's "any 200 from whatever holds 4310" concern):
  // shown verbatim, never queued. Resending an identical request, or one
  // a wrong process on the port already mangled once, cannot succeed by
  // retrying.
  return { message: error.message, problem: true, offerFileSave: true, offerSettings: false };
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
  // no-focus-loss rule below (B7 carry-forward) already forbids. A plain
  // in-closure guard makes a repeat click an inert no-op without touching
  // focus at all; `aria-disabled` (unlike `disabled`) still tells a screen
  // reader it's inert without removing it from the tab order.
  let saved = false;

  saveButton.addEventListener("click", () => {
    void (async () => {
      if (saved) return;
      saveButton.disabled = true;
      saveButton.textContent = "Saving…";
      try {
        // Storage first, always: whatever sendToBridge below decides,
        // the options page's export view can still recover this exact
        // capture (P07 packet part A: "If a popup closing on focus loss
        // breaks the download, hand off to the options page's export
        // view").
        await setLastJobCapture(capture);
        const outcome = await sendToBridge(capture);
        status.textContent = outcome.message;
        status.className = outcome.problem ? "flash bad" : "flash";
        fileButton.hidden = !outcome.offerFileSave;
        settingsButton.hidden = !outcome.offerSettings;
        saveButton.textContent = "Saved ✓";
        saveButton.setAttribute("aria-disabled", "true");
        saved = true;
      } catch (error) {
        status.textContent = `Couldn't save: ${error instanceof Error ? error.message : String(error)}`;
        status.className = "flash bad";
        saveButton.textContent = "Save this job";
      } finally {
        // Disabling the focused button while "Saving…" moves focus to
        // <body> (a disabled element can't hold it) -- re-enable and
        // reclaim focus on both the success and failure path, so a
        // keyboard/screen-reader user isn't dropped back to the top of
        // the page after a click.
        saveButton.disabled = false;
        saveButton.focus();
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
