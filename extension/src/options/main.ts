import "../shared/zod-jitless";
import { jobCaptureSchema, pairRequestSchema, type SessionManifest } from "@workflow-catalog/contracts";
import { bridgeClient, FOREIGN_SERVER_MESSAGE, type BridgeError } from "../shared/bridge-client";
import { el, mount } from "../shared/dom";
import { downloadJson } from "../shared/download";
import { abbreviateUuid, formatTimestamp } from "../shared/format";
import {
  isOutboxStorageKey,
  listQueuedCaptures,
  outboxUsedThisSession,
  pauseInEffect,
  resumeAfterPairing,
  type OutboxEntry,
} from "../shared/outbox";
import {
  forgetPairing,
  getDeviceToken,
  getLastJobCapture,
  getPairedBefore,
  getPairingExpired,
  getPairingOriginMismatch,
  recordPairing,
  type StoredDeviceToken,
} from "../shared/storage";
import { applyColorScheme } from "../shared/theme-init";
import { FLASH_CLASS, type Tone } from "../shared/tone";
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

/** Sets the Pairing section's persistent line (its tones: shared/tone.ts --
 * "Pairing…" is `info`, "Paired."/"Un-paired." `ok`, anything the person
 * has to fix `act`). */
function setPairingStatus(text: string, tone: Tone): void {
  pairingStatus.replaceChildren(...withInlineCode(text));
  pairingStatus.className = FLASH_CLASS[tone];
}

/** P07-B revision 3, UI issue 1: the line reports what happened on this
 * page, so when the section is rebuilt for a pairing that changed
 * somewhere else, the old outcome must go -- revision 2 kept "Paired."
 * next to "Not paired yet." after a revoke (and as the code field's
 * description), and "Un-paired." next to a device paired from another
 * tab. Emptied, the line takes no room (base.css). */
function clearPairingStatus(): void {
  pairingStatus.replaceChildren();
  pairingStatus.className = FLASH_CLASS.act;
}

/** The persistent line's text once a pairing has expired or been revoked
 * (the bridge refused its token). */
const PAIRING_EXPIRED_LINE = "Your pairing expired or was revoked.";

function pairCommand(everPaired: boolean): string {
  return everPaired ? "npm run pair" : "npm run setup";
}

/** True if this browser has paired before in this browser session -- see
 * `pairingSection`'s `everPaired`. */
async function hasPairedBefore(current: StoredDeviceToken | null): Promise<boolean> {
  return current !== null || (await getPairedBefore()) || (await getPairingExpired());
}

/** The deviceId the Pairing section on screen was built for (`null`:
 * unpaired) -- lets `syncPairingSection` rebuild it only when storage has
 * actually moved on. */
let pairingShownFor: string | null = null;

/**
 * `everPaired` (P07-B revision 1, E3/B12): the code field's own label
 * names the command that actually printed the code on screen -- `npm run
 * setup` runs once and prints the very first code; every code after that
 * (re-pairing while still paired, or right after an Un-pair) comes from
 * `npm run pair` instead. P07-B revision 2 polish: `hasPairedBefore` also
 * remembers a pairing this browser session made and then lost -- an
 * Un-pair, or bridge-client.ts's onTokenInvalid hook forgetting a dead
 * token after a 401 (storage.ts's pairedBefore/pairingExpired flags) -- so
 * the label no longer reverts to `npm run setup` then, as if this were a
 * fresh install.
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
    el("code", { text: pairCommand(everPaired) }),
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

  // P07-B revision 3 polish: "yet" only for a browser that has never
  // paired -- not after an Un-pair or an expired pairing.
  const currentState = paired
    ? el("dl", { className: "kv" }, [
        el("dt", { text: "Device" }),
        el("dd", { text: abbreviateUuid(current.deviceId), attrs: { title: current.deviceId } }),
        el("dt", { text: "Paired" }),
        el("dd", { text: formatTimestamp(current.pairedAt) }),
      ])
    : el("p", { className: "small", text: everPaired ? "Not paired." : "Not paired yet." });

  const unpairButton = el("button", { text: "Un-pair", attrs: { "data-action": "unpair" } });
  unpairButton.toggleAttribute("disabled", !paired);
  // P07-B revision 2 polish: with nothing paired there is nothing to
  // un-pair, so the row is hidden and the code field is the first control
  // -- not a disabled Un-pair.
  const actions = el("div", { className: "row" }, [unpairButton, pairAgainButton]);
  actions.hidden = !paired;
  unpairButton.addEventListener("click", () => {
    void (async () => {
      await forgetPairing();
      setPairingStatus("Un-paired. You can pair again below.", "ok");
      const fresh = showPairing(null, true);
      // Un-pairing tears down and rebuilds the whole section -- the old,
      // focused Un-pair button no longer exists to keep focus on, so it
      // was silently dropping to <body>. Land on the field the next
      // action (pairing again) actually needs, instead (B7).
      fresh.querySelector<HTMLInputElement>('input[type="text"]')?.focus();
      await refreshStatusSection();
    })();
  });

  // P07-B revision 3 polish: while "Pairing…", Pair is aria-disabled and
  // this guard ignores another submit (Enter or a click). Revision 2 set
  // `disabled`, which dropped focus to <body> until the runner answered.
  let pairingInFlight = false;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (pairingInFlight) return;
    void (async () => {
      const code = codeInput.value.trim();
      // P07-B revision 3, UI issue 4: the command in backticks, so
      // withInlineCode renders it as <code> like every other command.
      const enterTheCode = `Enter the code shown by \`${pairCommand(everPaired)}\`.`;
      if (code.length === 0) {
        codeInput.setAttribute("aria-invalid", "true");
        setPairingStatus(enterTheCode, "act");
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
        setPairingStatus(enterTheCode, "act");
        codeInput.focus();
        return;
      }
      codeInput.removeAttribute("aria-invalid");
      pairingInFlight = true;
      pairButton.setAttribute("aria-disabled", "true");
      setPairingStatus("Pairing…", "info");
      const result = await bridgeClient.pair(parsed.data);
      pairingInFlight = false;
      pairButton.removeAttribute("aria-disabled");
      if (!result.ok) {
        // P07-B revision 1, B8: only a code-shaped refusal marks the
        // field invalid -- a runner-down or 429 response is not the code
        // being wrong, so the field itself must not look wrong either.
        if (result.error.code === "pairing_code_invalid" || result.error.code === "pairing_code_expired") {
          codeInput.setAttribute("aria-invalid", "true");
        }
        setPairingStatus(
          result.error.status === 429 ? tooManyTriesMessage(result.error.retryAfterSeconds) : result.error.message,
          "act",
        );
        codeInput.focus();
        return;
      }
      const token: StoredDeviceToken = { deviceId: result.value.deviceId, token: result.value.token, pairedAt: new Date().toISOString() };
      // Stores the token and clears whatever the old pairing's failures
      // flagged (an origin mismatch, an expired token): a fresh pairing can
      // only ever make those stale.
      await recordPairing(token);
      setPairingStatus("Paired.", "ok");
      const fresh = showPairing(token, true);
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

  const section = el("section", {}, [
    el("h2", { text: "Pairing" }),
    el("div", { className: "card pad stack" }, [
      currentState,
      actions,
      // Polish: the outcome message belongs next to the button that
      // caused it, not stranded below the (possibly now-hidden) code
      // field.
      pairingStatus,
      formWrap,
      statusPageLink(),
    ]),
  ]);
  section.dataset.section = "pairing";
  return section;
}

/** Puts a Pairing section built for `current` on the page (replacing the
 * one there, if any) and records what it shows. */
function showPairing(current: StoredDeviceToken | null, everPaired: boolean): HTMLElement {
  const fresh = pairingSection(current, everPaired);
  replaceSection("pairing", fresh);
  pairingShownFor = current?.deviceId ?? null;
  return fresh;
}

/**
 * Brings the Pairing section in line with storage after a status check
 * -- e.g. that check's 401 just made bridge-client.ts forget a dead token
 * -- and only when what it shows is actually out of date, so a routine
 * re-check never rebuilds it (P07-B revision 2). If focus was inside it,
 * focus moves to the rebuilt section's next action instead of dropping to
 * <body>.
 *
 * P07-B revision 3, UI issue 1: the persistent line is reset to what is
 * now true -- "Your pairing expired or was revoked." when the bridge
 * refused the token this page showed, and nothing otherwise (e.g. a
 * pairing made or dropped in another tab) -- instead of keeping this
 * page's last outcome.
 */
async function syncPairingSection(): Promise<void> {
  const current = await getDeviceToken();
  if ((current?.deviceId ?? null) === pairingShownFor) return;
  const hadFocus = app!.querySelector('[data-section="pairing"]')?.contains(document.activeElement) ?? false;
  if (current === null && (await getPairingExpired())) setPairingStatus(PAIRING_EXPIRED_LINE, "act");
  else clearPairingStatus();
  const fresh = showPairing(current, await hasPairedBefore(current));
  if (hadFocus) {
    const next = current ? '[data-action="unpair"]' : 'input[type="text"]';
    fresh.querySelector<HTMLElement>(next)?.focus();
  }
}

/**
 * `GET /status` (P07-B deliverable 2): connected/version/workspace when it
 * succeeds, and one of several clear, recoverable, announced states per the
 * bridge's own classification of the failure -- never a stuck spinner or a
 * raw error dump. "Pair this browser" (not "a device"): this page can only
 * ever act on the one browser it's running in (polish, P07-B revision 1).
 *
 * P07-B revision 3, H2: no field names or status codes. Another program
 * answering on the port gets one sentence with a next step, the same one
 * the outbox line agrees with (revision 2 said the runner's response
 * "didn't match the expected shape", or "unexpected error (HTTP 404)");
 * a real 5xx says the runner had a problem.
 */
function statusFailureMessage(error: BridgeError): string {
  if (error.code === "not_paired") return "Pair this browser above to see the runner's status.";
  if (error.code === "network_error") return error.message;
  if (error.code === "invalid_response" || error.code === "unknown_error") return FOREIGN_SERVER_MESSAGE;
  if (error.status === 401) return "Your pairing has expired or was revoked. Pair again above.";
  if (error.status === 403) return "This pairing belongs to a different install. Pair again above.";
  if (error.status === 429) return tooManyTriesMessage(error.retryAfterSeconds);
  if (error.status !== undefined && error.status >= 500) {
    return "The runner had a problem. Check again in a moment, or restart it with `npm run runner`.";
  }
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

/** What the Status section shows. Two states with the same `statusKey`
 * look and read the same, so moving between them changes nothing on the
 * page. */
type StatusState =
  | { readonly kind: "checking" }
  | { readonly kind: "connected"; readonly version: string; readonly workspaceId: string }
  | { readonly kind: "info"; readonly message: string }
  | { readonly kind: "problem"; readonly message: string };

function statusKey(state: StatusState): string {
  if (state.kind === "checking") return "checking";
  if (state.kind === "connected") return `connected|${state.version}|${state.workspaceId}`;
  return `${state.kind}|${state.message}`;
}

/**
 * The runner's status for this browser, from the three places it can
 * come from:
 * - P07-B revision 1, B3: GET /status never carries an Origin header
 *   (Chrome doesn't send one on a GET) and so can never itself observe a
 *   wrong-origin token the way job_capture's POST /events can -- the
 *   stored flag (set by bridge-client.ts's onOriginMismatch hook, cleared
 *   on the next successful pairing or explicit Un-pair) is the only way
 *   this page can ever reflect that;
 * - GET /status itself;
 * - P07-B revision 2 polish: with no token stored, the pairingExpired flag
 *   tells a pairing the bridge refused (bridge-client.ts's onTokenInvalid
 *   forgot the token) apart from one that never happened. Without it, the
 *   next re-check replaced "expired or was revoked" with "Pair this
 *   browser above…".
 */
async function readStatusState(): Promise<StatusState> {
  if (await getPairingOriginMismatch()) {
    return { kind: "problem", message: "This pairing belongs to a different install. Pair again above." };
  }
  const result = await bridgeClient.getStatus();
  if (result.ok) return { kind: "connected", version: result.value.version, workspaceId: result.value.workspaceId };
  if (result.error.code === "not_paired") {
    if (await getPairingExpired()) return { kind: "problem", message: "Your pairing has expired or was revoked. Pair again above." };
    return { kind: "info", message: statusFailureMessage(result.error) };
  }
  return { kind: "problem", message: statusFailureMessage(result.error) };
}

interface StatusView {
  readonly section: HTMLElement;
  /** Shows `state`. Unchanged, it touches nothing -- unless `restate`, for
   * a check the person started, which says the result again. */
  show(state: StatusState, options?: { restate?: boolean }): void;
  setChecking(checking: boolean): void;
  setOutboxLine(text: string): void;
}

/**
 * P07-B revision 2, C2: the Status section is built once and updated in
 * place. Revision 1 rebuilt it on every check: "Check again" was destroyed
 * while focused (focus dropped to <body>), and every re-check on window
 * focus re-inserted -- and re-announced -- the same alert.
 *
 * Normal states (checking, not paired, connected) live in one polite live
 * region that is never replaced, so a change in it is announced. A
 * problem is an alert inserted after it, which is announced on insertion
 * -- so it is inserted only when the problem itself changes. `show` with
 * the same `statusKey` as what is on screen touches nothing, so a re-check
 * that finds nothing new says nothing.
 *
 * P07-B revision 3: every problem here waits on the person (start the
 * runner, pair again, close the program on its port), so it is amber
 * (shared/tone.ts `act`), not red. And "Check again" answers: a check the
 * person started restates its result even when nothing changed -- the
 * polite region is refilled, or the alert re-inserted -- so pressing it
 * is never met with silence. A re-check on window focus still says
 * nothing unless something changed.
 */
function buildStatusView(): StatusView {
  const info = el("div", { attrs: { id: nextId("bridge-status"), role: "status", "aria-live": "polite" } });
  let problem: HTMLElement | null = null;
  // P07-B revision 1, B10: the outbox's own state -- gate 4's
  // queued-then-delivered capture is invisible from this page otherwise.
  const outboxLine = el("p", { className: "small" });
  outboxLine.hidden = true;
  // P07-B revision 1, B10: a manual way to re-check without reloading the
  // whole page. Paired with a `window` focus listener (see `render` below)
  // for the common case (someone starts the runner, then alt-tabs back)
  // without needing to find this button at all.
  const checkAgain = el("button", { className: "ghost", text: "Check again" }) as HTMLButtonElement;
  checkAgain.addEventListener("click", () => {
    void refreshStatusSection({ fromButton: true });
  });
  const section = el("section", {}, [
    el("h2", { text: "Status" }),
    el("div", { className: "stack" }, [info, outboxLine, el("div", { className: "row" }, [checkAgain])]),
  ]);
  section.dataset.section = "status";
  let shownKey: string | undefined;

  return {
    section,
    show(state, options = {}) {
      const key = statusKey(state);
      if (key === shownKey && options.restate !== true) return;
      shownKey = key;
      if (state.kind === "problem") {
        info.replaceChildren();
        const alert = el("div", { className: FLASH_CLASS.act, attrs: { role: "alert" } }, withInlineCode(state.message));
        if (problem) problem.replaceWith(alert);
        else info.after(alert);
        problem = alert;
        return;
      }
      problem?.remove();
      problem = null;
      if (state.kind === "connected") {
        info.replaceChildren(renderConnectedStatus(state));
      } else {
        const text = state.kind === "checking" ? "Checking the runner…" : state.message;
        info.replaceChildren(el("p", { className: "small" }, withInlineCode(text)));
      }
    },
    // Both write only on a real change: an unchanged re-check leaves the
    // section's DOM untouched.
    setChecking(checking) {
      const label = checking ? "Checking…" : "Check again";
      if (checkAgain.textContent !== label) checkAgain.textContent = label;
    },
    setOutboxLine(text) {
      if (outboxLine.textContent === text) return;
      outboxLine.textContent = text;
      outboxLine.hidden = text === "";
    },
  };
}

/** What the outbox line needs to know besides the queue itself. */
interface OutboxContext {
  /** Something was queued in this browser session (outbox.ts's
   * `outboxUsedThisSession`). */
  readonly usedThisSession: boolean;
  /** The pairing this browser holds now, or null. */
  readonly pairedDeviceId: string | null;
  /** This browser has paired before (storage.ts's `getPairedBefore`). */
  readonly pairedBefore: boolean;
}

/**
 * P07-B revision 1, B10, and revision 2: "N saved jobs waiting to send",
 * with the reason when it's one a person can act on (B3: something other
 * than the runner is answering on its port), or "All saved jobs sent." --
 * but only once something was actually queued in this browser session
 * (polish: not on a fresh install). Empty means no line at all.
 *
 * P07-B revision 3: waiting on a pairing only while the pause holds
 * (outbox.ts's `pauseInEffect`), and "paired again" for a browser that
 * already was -- revision 2 said "waiting until this browser is paired"
 * next to a paired device.
 */
function outboxSummaryText(entries: readonly OutboxEntry[], context: OutboxContext): string {
  if (entries.length === 0) return context.usedThisSession ? "All saved jobs sent." : "";
  const jobs = `${entries.length} saved job${entries.length === 1 ? "" : "s"}`;
  if (entries.every((entry) => pauseInEffect(entry, context.pairedDeviceId))) {
    const again = context.pairedBefore || context.pairedDeviceId !== null;
    return `${jobs} waiting until this browser is paired${again ? " again" : ""}.`;
  }
  const notTheRunner = entries.some(
    (entry) =>
      !pauseInEffect(entry, context.pairedDeviceId) &&
      (entry.lastErrorCode === "invalid_response" || entry.lastErrorCode === "unknown_error"),
  );
  if (notTheRunner) return `${jobs} waiting to send. Something other than the runner is answering on its port; trying again.`;
  return `${jobs} waiting to send.`;
}

const statusView = buildStatusView();

let statusCheck = 0;

/** P07-B revision 3 polish: how long "Checking…" stays on the button for a
 * check it started. A loopback answer takes a few milliseconds, and the
 * label used to flash for about 6 ms -- too short to see. */
const CHECKING_LABEL_MIN_MS = 600;

/** Re-checks the runner and updates Status (and Pairing, if the check
 * changed what's stored) in place. Checks can overlap -- a click, a window
 * focus, a pairing -- and only the latest one's answer is shown. A check
 * the button started reads "Checking…" for at least
 * CHECKING_LABEL_MIN_MS and then restates its result (revision 3 polish);
 * a re-check on window focus is silent unless it finds something new. */
async function refreshStatusSection(options: { fromButton?: boolean } = {}): Promise<void> {
  statusCheck += 1;
  const thisCheck = statusCheck;
  const fromButton = options.fromButton === true;
  const labelHeldUntil = Date.now() + CHECKING_LABEL_MIN_MS;
  if (fromButton) statusView.setChecking(true);
  const state = await readStatusState();
  const holdFor = labelHeldUntil - Date.now();
  if (fromButton && holdFor > 0) await new Promise((resolve) => setTimeout(resolve, holdFor));
  if (thisCheck !== statusCheck) return;
  statusView.setChecking(false);
  statusView.show(state, { restate: fromButton });
  await syncPairingSection();
  await refreshOutboxLine();
}

let outboxCheck = 0;

async function refreshOutboxLine(): Promise<void> {
  outboxCheck += 1;
  const thisCheck = outboxCheck;
  const entries = await listQueuedCaptures();
  const context: OutboxContext = {
    usedThisSession: await outboxUsedThisSession(),
    pairedDeviceId: (await getDeviceToken())?.deviceId ?? null,
    pairedBefore: await getPairedBefore(),
  };
  if (thisCheck !== outboxCheck) return;
  statusView.setOutboxLine(outboxSummaryText(entries, context));
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
 * (`render()` awaited the status check before mounting anything at all):
 * #app now always has real, interactive content on the very first paint.
 */
async function render(): Promise<void> {
  const current = await getDeviceToken();
  // P07-B revision 3, UI issue 1: opened after the bridge refused this
  // browser's token (e.g. the popup's 401), the Pairing card starts out
  // saying so -- the same line a rebuild on this page would set. Set before
  // the page is mounted, so it is not announced on top of Status's alert.
  if (current === null && (await getPairingExpired())) setPairingStatus(PAIRING_EXPIRED_LINE, "act");
  const pairing = pairingSection(current, await hasPairedBefore(current));
  pairingShownFor = current?.deviceId ?? null;
  const lastCapture = await getLastJobCapture();
  const fileBridge = fileBridgeSection(lastCapture !== null);
  statusView.show({ kind: "checking" });

  mount(
    app!,
    el("main", { className: "wrap" }, [
      el("h1", { text: "Job Assistant" }),
      el("span", { className: "small", text: "Pairing, runner status, and the file-bridge fallback." }),
      pairing,
      statusView.section,
      fileBridge,
      // E4 (mvp-spec §7.5): storage.session's lifetime is tied to this
      // browser staying open -- quitting Chrome forgets the pairing, by
      // design, not a bug to file.
      el("p", { className: "small", text: "Pairing lives only in this browser session — quitting Chrome un-pairs it." }),
    ]),
  );

  // The outbox line follows the queue as the popup and the worker change
  // it, without waiting for the next status check.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "session" && Object.keys(changes).some(isOutboxStorageKey)) void refreshOutboxLine();
  });

  await refreshStatusSection();

  // B10: re-check on refocus (e.g. the runner was started, then this tab
  // was switched back to), in addition to the explicit "Check again"
  // button inside the Status section itself.
  window.addEventListener("focus", () => {
    void refreshStatusSection();
  });
}

void render();
