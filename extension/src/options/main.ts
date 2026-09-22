import "../shared/zod-jitless";
import { jobCaptureSchema, pairRequestSchema, type SessionManifest } from "@workflow-catalog/contracts";
import { bridgeClient, type BridgeError } from "../shared/bridge-client";
import { el, mount } from "../shared/dom";
import { downloadJson } from "../shared/download";
import { abbreviateUuid, formatTimestamp } from "../shared/format";
import { listQueuedCaptures, resumeAfterPairing } from "../shared/outbox";
import {
  forgetPairing,
  getDeviceToken,
  getLastJobCapture,
  getPairingOriginMismatch,
  recordPairing,
  type StoredDeviceToken,
} from "../shared/storage";
import { applyColorScheme } from "../shared/theme-init";
import { checkImportFileSize, parseSessionManifestFile } from "../file-bridge/session-import";
import "./style.css";

applyColorScheme();

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("options/index.html is missing #app");
}

// Revocation lives on the runner's own status page (P07-B deliverable 1):
// un-pairing here only forgets the token this browser holds, it does not
// remove the device record the runner keeps -- that's a separate, explicit
// action a person takes there.
const RUNNER_STATUS_URL = "http://127.0.0.1:4310/ui/status";

let fieldId = 0;
function nextId(prefix: string): string {
  fieldId += 1;
  return `${prefix}-${fieldId}`;
}

function statusPageLink(): HTMLElement {
  return el("p", { className: "small" }, [
    "Manage paired devices on the runner's ",
    el("a", { attrs: { href: RUNNER_STATUS_URL, target: "_blank", rel: "noopener" }, text: "status page" }),
    ".",
  ]);
}

/**
 * Splits `text` on backtick pairs into plain-text and `<code>` segments.
 * Several of the bridge's own error messages (runner/server/*.ts) write a
 * command as literal backtick-delimited text, e.g. "Start it with `npm run
 * runner`." -- shown via `.textContent` (this codebase's strict
 * hostile-content-is-data rule, see shared/dom.ts) that would render as
 * literal backtick characters, not styled code, which is what E3/B12 (P07-B
 * revision 1) ask for instead. Every segment here still only ever goes
 * through `el()`'s `text` option or a plain text node, never `innerHTML` --
 * this is markup structure, not content trust. An odd number of backticks
 * (should never happen; every source message pairs them) just leaves a
 * trailing segment as plain text instead of losing it.
 */
function withInlineCode(text: string): Array<string | HTMLElement> {
  return text.split("`").map((part, index) => (index % 2 === 1 ? el("code", { text: part }) : part)).filter((part) => part !== "");
}

/** `retryAfterSeconds` (from the bridge's own `Retry-After` header, see
 * bridge-client.ts) rounded up to whole minutes for a person-readable
 * countdown (P07-B revision 1, B8): "Too many tries. Try again in about N
 * minutes." instead of a vague "wait". */
function tooManyTriesMessage(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds === undefined) return "Too many tries. Wait, then try again.";
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many tries. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

// P07-B revision 1, B7: one persistent live region for the Pairing
// section's own status line, created once and never rebuilt. Screen
// readers only announce a mutation to a live region that was already
// present (not one that was just (re)inserted) -- rebuilding the whole
// Pairing section on every pair/un-pair used to recreate this element
// each time, which silently dropped the "Paired."/"Un-paired."
// announcement. Every rebuild below re-appends this SAME node instance
// into its fresh wrapper instead of creating a new one.
const pairingStatusId = nextId("pairing-status");
const pairingStatus = el("p", { className: "flash", attrs: { id: pairingStatusId, role: "status", "aria-live": "polite" } });

function setPairingStatus(text: string, problem: boolean): void {
  pairingStatus.replaceChildren(...withInlineCode(text));
  pairingStatus.className = problem ? "flash bad" : "flash";
}

/**
 * `everPaired` (P07-B revision 1, E3/B12): the code field's own label
 * names the command that actually printed the code on screen -- `npm run
 * setup` runs once and prints the very first code; every code after that
 * (re-pairing while still paired, or right after an Un-pair) comes from
 * `npm run pair` instead. `buildPairingSection` passes `current !== null`
 * (a token is stored right now); the Un-pair handler below passes a
 * hardcoded `true` instead of recomputing it, since it has just forgotten
 * the token itself and `current` would otherwise read `null` a moment too
 * early. Nothing here distinguishes "never paired" from "was paired, then
 * silently lost the token some other way" (e.g. bridge-client.ts's
 * onTokenInvalid hook clearing a dead one after a 401) -- that path's next
 * Pairing re-render goes back through `buildPairingSection`, sees no
 * current token, and shows "npm run setup" again, same as a fresh install.
 *
 * Polish: the code-entry form collapses to a single "Pair again" button
 * while already paired (`current !== null`), instead of always showing a
 * code field next to an active pairing -- expanding it is `formVisible`,
 * a plain closure flag local to one render of this section (not persisted:
 * every fresh render, e.g. after Un-pair, starts from its own natural
 * default -- expanded when there's nothing paired, collapsed when there
 * is).
 */
function pairingSection(current: StoredDeviceToken | null, everPaired: boolean): HTMLElement {
  const codeFieldId = nextId("pairing-code");
  const paired = current !== null;

  const codeInput = el("input", {
    attrs: { type: "text", id: codeFieldId, placeholder: "e.g. 7KQ2M-X9RTB", "aria-describedby": pairingStatusId },
  }) as HTMLInputElement;
  const codeLabel = el("label", { className: "small", attrs: { for: codeFieldId } }, [
    "Code from ",
    el("code", { text: everPaired ? "npm run pair" : "npm run setup" }),
  ]);
  const pairButton = el("button", { className: "primary", attrs: { type: "submit" }, text: "Pair" });
  const form = el("form", { className: "field" }, [codeInput, pairButton]);
  const formWrap = el("div", { className: "stack" }, [codeLabel, form]);
  formWrap.hidden = paired;

  const pairAgainButton = el("button", { className: "ghost", text: "Pair again" });
  pairAgainButton.hidden = !paired;
  pairAgainButton.addEventListener("click", () => {
    formWrap.hidden = false;
    pairAgainButton.hidden = true;
    codeInput.focus();
  });

  const currentState = paired
    ? el("dl", { className: "kv" }, [
        el("dt", { text: "Device" }),
        el("dd", { text: abbreviateUuid(current.deviceId), attrs: { title: current.deviceId } }),
        el("dt", { text: "Paired" }),
        el("dd", { text: formatTimestamp(current.pairedAt) }),
      ])
    : el("p", { className: "small", text: "Not paired yet." });

  const unpairButton = el("button", { text: "Un-pair", attrs: { "data-action": "unpair" } });
  unpairButton.toggleAttribute("disabled", !paired);
  unpairButton.addEventListener("click", () => {
    void (async () => {
      await forgetPairing();
      setPairingStatus("Un-paired. You can pair again below.", false);
      const fresh = pairingSection(null, true);
      replaceSection("pairing", fresh);
      // Un-pairing tears down and rebuilds the whole section -- the old,
      // focused Un-pair button no longer exists to keep focus on, so it
      // was silently dropping to <body>. Land on the field the next
      // action (pairing again) actually needs, instead (B7).
      fresh.querySelector<HTMLInputElement>('input[type="text"]')?.focus();
      await refreshStatusSection();
    })();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const code = codeInput.value.trim();
      if (code.length === 0) {
        codeInput.setAttribute("aria-invalid", "true");
        setPairingStatus(`Enter the code shown by ${everPaired ? "npm run pair" : "npm run setup"}.`, true);
        codeInput.focus();
        return;
      }
      // Client-side shape check before ever reaching the network (mirrors
      // pairRequestSchema.max(64) from @workflow-catalog/contracts): a
      // pasted blob of the wrong shape is refused locally with the same
      // message as an empty field, instead of spending a real /pair
      // request (and a slot in its wrong-code budget) on something that
      // could never be a real pairing code.
      const parsed = pairRequestSchema.safeParse({ code });
      if (!parsed.success) {
        codeInput.setAttribute("aria-invalid", "true");
        setPairingStatus(`Enter the code shown by ${everPaired ? "npm run pair" : "npm run setup"}.`, true);
        codeInput.focus();
        return;
      }
      codeInput.removeAttribute("aria-invalid");
      pairButton.disabled = true;
      setPairingStatus("Pairing…", false);
      const result = await bridgeClient.pair(parsed.data);
      pairButton.disabled = false;
      if (!result.ok) {
        // P07-B revision 1, B8: only a code-shaped refusal marks the
        // field invalid -- a runner-down or 429 response is not the code
        // being wrong, so the field itself must not look wrong either.
        if (result.error.code === "pairing_code_invalid" || result.error.code === "pairing_code_expired") {
          codeInput.setAttribute("aria-invalid", "true");
        }
        setPairingStatus(
          result.error.status === 429 ? tooManyTriesMessage(result.error.retryAfterSeconds) : result.error.message,
          true,
        );
        codeInput.focus();
        return;
      }
      const token: StoredDeviceToken = { deviceId: result.value.deviceId, token: result.value.token, pairedAt: new Date().toISOString() };
      // Stores the token and clears whatever the old pairing's failures
      // flagged (an origin mismatch, an expired token): a fresh pairing can
      // only ever make those stale.
      await recordPairing(token);
      setPairingStatus("Paired.", false);
      const fresh = pairingSection(token, true);
      replaceSection("pairing", fresh);
      // B7: focus the thing paired state actually offers next, not
      // whichever <button> happens to come first in document order (the
      // Pair button, which the old querySelector("button") picked, even
      // though it's no longer the relevant action once paired).
      fresh.querySelector<HTMLButtonElement>('[data-action="unpair"]')?.focus();
      // E2 + B3's "after a new pairing, flush" (revision 1), made durable
      // by B2 (revision 2): lift every pause in storage, arm the retry
      // alarm, then flush -- if this page closes mid-flush, the worker's
      // alarm delivers the rest.
      await resumeAfterPairing(bridgeClient);
      await refreshStatusSection();
    })();
  });

  return el("section", {}, [
    el("h2", { text: "Pairing" }),
    el("div", { className: "card pad stack" }, [
      currentState,
      el("div", { className: "row" }, [unpairButton, pairAgainButton]),
      // Polish: the outcome message belongs next to the button that
      // caused it, not stranded below the (possibly now-hidden) code
      // field.
      pairingStatus,
      formWrap,
      statusPageLink(),
    ]),
  ]);
}

async function buildPairingSection(): Promise<HTMLElement> {
  const current = await getDeviceToken();
  const section = pairingSection(current, current !== null);
  section.dataset.section = "pairing";
  return section;
}

/**
 * `GET /status` (P07-B deliverable 2): connected/version/workspace when it
 * succeeds, and one of several clear, recoverable, announced states per the
 * bridge's own classification of the failure -- never a stuck spinner or a
 * raw error dump. "Pair this browser" (not "a device"): this page can only
 * ever act on the one browser it's running in (polish, P07-B revision 1).
 */
function statusFailureMessage(error: BridgeError): string {
  if (error.code === "not_paired") return "Pair this browser above to see the runner's status.";
  if (error.code === "network_error") return error.message;
  if (error.status === 401) return "Your pairing has expired or was revoked. Pair again above.";
  if (error.status === 403) return "This pairing belongs to a different install. Pair again above.";
  if (error.status === 429) return tooManyTriesMessage(error.retryAfterSeconds);
  return error.message;
}

function renderConnectedStatus(status: { version: string; workspaceId: string }): HTMLElement {
  return el("div", { className: "card pad" }, [
    el("dl", { className: "kv" }, [
      el("dt", { text: "Connected" }),
      el("dd", { text: "Yes" }),
      el("dt", { text: "Version" }),
      el("dd", { text: status.version }),
      el("dt", { text: "Workspace" }),
      // Polish: the full workspace UUID crowded this row; abbreviated to
      // its first 8 characters, with the full value still reachable via
      // the standard title-attribute affordance (same treatment Device's
      // id already gets above).
      el("dd", { text: abbreviateUuid(status.workspaceId), attrs: { title: status.workspaceId } }),
    ]),
  ]);
}

/** P07-B revision 1, B10: "1 saved job waiting to send" / "All saved jobs
 * sent" -- the outbox's own current size, refreshed every time Status is
 * (gate 4's queued-then-delivered capture is invisible from this page
 * otherwise; nothing else here ever surfaces it). */
async function outboxSummaryLine(): Promise<HTMLElement> {
  const queued = await listQueuedCaptures();
  const text = queued.length === 0 ? "All saved jobs sent." : `${queued.length} saved job${queued.length === 1 ? "" : "s"} waiting to send.`;
  return el("p", { className: "small", text });
}

/** P07-B revision 1, B10: a manual way to re-check without reloading the
 * whole page. Paired with a `window` focus listener (see `render` below)
 * for the common case (someone starts the runner, then alt-tabs back)
 * without needing to find this button at all. */
function checkAgainButton(): HTMLButtonElement {
  const button = el("button", { className: "ghost", text: "Check again" }) as HTMLButtonElement;
  button.addEventListener("click", () => {
    void refreshStatusSection();
  });
  return button;
}

async function buildStatusSection(): Promise<HTMLElement> {
  const statusId = nextId("bridge-status");
  // P07-B revision 1, B3: GET /status never carries an Origin header
  // (Chrome doesn't send one on a GET) and so can never itself observe a
  // wrong-origin token the way job_capture's POST /events can -- this
  // flag (set by bridge-client.ts's onOriginMismatch hook, cleared on the
  // next successful pairing or explicit Un-pair) is the only way this
  // page can ever reflect that.
  const mismatch = await getPairingOriginMismatch();
  let body: HTMLElement;
  if (mismatch) {
    body = el(
      "div",
      { className: "flash bad", attrs: { role: "alert", id: statusId } },
      withInlineCode("This pairing belongs to a different install. Pair again above."),
    );
  } else {
    const result = await bridgeClient.getStatus();
    if (result.ok) {
      body = renderConnectedStatus(result.value);
      body.setAttribute("role", "status");
      body.id = statusId;
    } else if (result.error.code === "not_paired") {
      body = el("p", { className: "small", attrs: { role: "status", id: statusId } }, withInlineCode(statusFailureMessage(result.error)));
    } else {
      body = el("div", { className: "flash bad", attrs: { role: "alert", id: statusId } }, withInlineCode(statusFailureMessage(result.error)));
      if (result.error.status === 401) {
        // bridge-client.ts's onTokenInvalid already cleared the dead
        // token from storage (B3) -- refresh Pairing too, so it doesn't
        // keep claiming paired with Un-pair enabled for a token that's
        // gone, and Status and Pairing never disagree for long.
        replaceSection("pairing", await buildPairingSection());
      }
    }
  }
  const section = el("section", {}, [el("h2", { text: "Status" }), body, await outboxSummaryLine(), checkAgainButton()]);
  section.dataset.section = "status";
  return section;
}

async function refreshStatusSection(): Promise<void> {
  replaceSection("status", await buildStatusSection());
}

/** Shown the instant the page renders, before the real (network-bound)
 * Status section has resolved -- see `render` below (P07-B revision 1,
 * B4). */
function buildStatusPlaceholder(): HTMLElement {
  const section = el("section", {}, [
    el("h2", { text: "Status" }),
    el("p", { className: "small", attrs: { role: "status", "aria-live": "polite" }, text: "Checking the runner…" }),
  ]);
  section.dataset.section = "status";
  return section;
}

function renderSessionSummary(manifest: SessionManifest): HTMLElement {
  const itemRows = manifest.items.map((item) =>
    el("div", { className: "item-row" }, [
      el("div", {}, [
        el("div", { text: `Task ${item.taskId}` }),
        el("div", { className: "url", text: item.url }),
      ]),
      el("div", { className: "small", text: `rev ${item.jobRevision}` }),
    ]),
  );

  return el("div", { className: "card pad stack" }, [
    el("dl", { className: "kv" }, [
      el("dt", { text: "Session" }),
      el("dd", { text: abbreviateUuid(manifest.sessionId), attrs: { title: manifest.sessionId } }),
      el("dt", { text: "Title" }),
      el("dd", { text: manifest.title }),
      el("dt", { text: "Created" }),
      el("dd", { text: formatTimestamp(manifest.createdAt) }),
      el("dt", { text: "Items" }),
      el("dd", { text: String(manifest.items.length) }),
    ]),
    el("div", { className: "item-list" }, itemRows),
    el("p", { className: "small", text: "Read-only preview. Opening tabs arrives in a later version." }),
  ]);
}

/** A short, plain-sentence summary always shown directly; the full
 * per-issue zod breakdown (when there is one) goes inside a collapsed
 * `<details>` instead of being dumped inline (review fold-in i). */
function renderImportError(summary: string, detail: string | undefined): HTMLElement {
  const children: Array<Node | HTMLElement> = [
    el("div", { className: "flash bad", attrs: { role: "alert" }, text: summary }),
  ];
  if (detail) {
    const pre = el("pre", { className: "small", text: detail });
    pre.style.whiteSpace = "pre-wrap";
    children.push(el("details", {}, [el("summary", { className: "small", text: "Details" }), pre]));
  }
  return el("div", { className: "stack" }, children);
}

function updateExportButtonState(button: HTMLButtonElement, hasCapture: boolean): void {
  button.textContent = hasCapture ? "Export last capture" : "No capture saved yet";
  button.toggleAttribute("disabled", !hasCapture);
}

function fileBridgeSection(hasLastCapture: boolean): HTMLElement {
  const exportButton = el("button", { className: "primary" }) as HTMLButtonElement;
  updateExportButtonState(exportButton, hasLastCapture);
  const exportStatusId = nextId("export-status");
  const exportStatus = el("p", { className: "small", attrs: { id: exportStatusId, role: "status", "aria-live": "polite" } });

  exportButton.addEventListener("click", () => {
    void (async () => {
      const capture = await getLastJobCapture();
      if (!capture) {
        exportStatus.textContent = "No capture saved yet — save one from the popup first.";
        return;
      }
      // Re-validate before export (review fold-in d): storage.ts's
      // getLastJobCapture casts without checking, so a capture written by
      // a future/older format, or edited by hand in devtools, would
      // otherwise be exported as-is.
      const revalidated = jobCaptureSchema.safeParse(capture);
      if (!revalidated.success) {
        exportStatus.textContent = "The saved capture no longer matches the expected shape — save a new one from the popup.";
        return;
      }
      downloadJson("job-capture.json", revalidated.data);
      exportStatus.textContent = "Exported job-capture.json.";
    })();
  });

  // Review fold-in d: if the popup saves a capture while this page is
  // already open, the export button should reflect that without needing a
  // reload.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "session" || !("lastJobCapture" in changes)) return;
    updateExportButtonState(exportButton, changes.lastJobCapture.newValue != null);
  });

  const fileInputId = nextId("import-file");
  const fileInput = el("input", {
    attrs: { type: "file", id: fileInputId, accept: "application/json,.json" },
  }) as HTMLInputElement;
  const fileLabel = el("label", { className: "small", attrs: { for: fileInputId }, text: "Import application-session.json" });
  const importResult = el("div", { className: "stack" });

  fileInput.addEventListener("change", () => {
    void (async () => {
      mount(importResult);
      const file = fileInput.files?.[0];
      if (!file) return;

      const sizeCheck = checkImportFileSize(file.size);
      if (!sizeCheck.ok) {
        mount(importResult, renderImportError(sizeCheck.reason, undefined));
        return;
      }

      let text: string;
      try {
        text = await file.text();
      } catch (error) {
        mount(
          importResult,
          renderImportError(`Couldn't read that file: ${error instanceof Error ? error.message : String(error)}`, undefined),
        );
        return;
      }

      const parsed = parseSessionManifestFile(text);
      if (!parsed.ok) {
        mount(importResult, renderImportError(parsed.summary, parsed.detail));
        return;
      }
      mount(importResult, renderSessionSummary(parsed.manifest));
    })();
  });

  const section = el("section", {}, [
    el("h2", { text: "File bridge" }),
    el("div", { className: "card pad stack" }, [
      el("div", { className: "stack" }, [exportButton, exportStatus]),
      el("div", { className: "stack" }, [fileLabel, fileInput, importResult]),
    ]),
  ]);
  section.dataset.section = "fileBridge";
  return section;
}

function replaceSection(id: string, replacement: HTMLElement): void {
  const existing = app!.querySelector(`[data-section="${id}"]`);
  replacement.dataset.section = id;
  if (existing) {
    existing.replaceWith(replacement);
  }
}

/**
 * P07-B revision 1, B4: Pairing and File bridge render immediately, from
 * fast local storage reads alone -- Status (the one section that makes a
 * real network call, now bounded at 5s by bridge-client.ts's own timeout,
 * but still the only slow part of this page) fills in afterwards, behind
 * its own "Checking the runner…" placeholder. A runner that accepts the
 * TCP connection but never answers used to leave the whole page blank
 * (`render()` awaited `buildStatusSection()` before mounting anything at
 * all): #app now always has real, interactive content on the very first
 * paint.
 */
async function render(): Promise<void> {
  const pairing = await buildPairingSection();
  const lastCapture = await getLastJobCapture();
  const fileBridge = fileBridgeSection(lastCapture !== null);

  mount(
    app!,
    el("main", { className: "wrap" }, [
      el("h1", { text: "Job Assistant" }),
      el("span", { className: "small", text: "Pairing, runner status, and the file-bridge fallback." }),
      pairing,
      buildStatusPlaceholder(),
      fileBridge,
      // E4 (mvp-spec §7.5): storage.session's lifetime is tied to this
      // browser staying open -- quitting Chrome forgets the pairing, by
      // design, not a bug to file.
      el("p", { className: "small", text: "Pairing lives only in this browser session — quitting Chrome un-pairs it." }),
    ]),
  );

  await refreshStatusSection();

  // B10: re-check on refocus (e.g. the runner was started, then this tab
  // was switched back to), in addition to the explicit "Check again"
  // button inside the Status section itself.
  window.addEventListener("focus", () => {
    void refreshStatusSection();
  });
}

void render();
