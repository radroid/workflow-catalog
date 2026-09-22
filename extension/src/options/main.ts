import "../shared/zod-jitless";
import { jobCaptureSchema, pairRequestSchema, type SessionManifest } from "@workflow-catalog/contracts";
import { bridgeClient, type BridgeError } from "../shared/bridge-client";
import { el, mount } from "../shared/dom";
import { downloadJson } from "../shared/download";
import { abbreviateUuid, formatTimestamp } from "../shared/format";
import { clearDeviceToken, getDeviceToken, getLastJobCapture, setDeviceToken, type StoredDeviceToken } from "../shared/storage";
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
    "Manage paired devices, including actual revocation, on the runner's ",
    el("a", { attrs: { href: RUNNER_STATUS_URL, target: "_blank", rel: "noopener" }, text: "status page" }),
    ".",
  ]);
}

/** `flashMessage`, when given, is shown in the status line as soon as the
 * section renders -- used for "Un-paired." after a successful un-pair,
 * since that action tears down and rebuilds this whole section (the old
 * status paragraph, and the message any earlier render put in it, goes
 * with it). */
function pairingSection(current: StoredDeviceToken | null, flashMessage?: string): HTMLElement {
  const codeFieldId = nextId("pairing-code");
  const statusId = nextId("pairing-status");

  const codeInput = el("input", {
    attrs: { type: "text", id: codeFieldId, placeholder: "e.g. 7KQ2M-X9RTB", "aria-describedby": statusId },
  }) as HTMLInputElement;
  const codeLabel = el("label", { className: "small", attrs: { for: codeFieldId }, text: "Code from npm run setup" });
  const pairButton = el("button", { className: "primary", attrs: { type: "submit" }, text: "Pair" });
  const status = el("p", {
    className: "small",
    attrs: { id: statusId, role: "status", "aria-live": "polite" },
    text: flashMessage ?? "",
  });

  const paired = current !== null;

  const currentState = paired
    ? el("dl", { className: "kv" }, [
        el("dt", { text: "Device" }),
        el("dd", { text: abbreviateUuid(current.deviceId), attrs: { title: current.deviceId } }),
        el("dt", { text: "Paired" }),
        el("dd", { text: formatTimestamp(current.pairedAt) }),
      ])
    : el("p", { className: "small", text: "Not paired yet." });

  const unpairButton = el("button", { text: "Un-pair", attrs: paired ? {} : { disabled: "true" } });
  unpairButton.toggleAttribute("disabled", !paired);
  unpairButton.addEventListener("click", () => {
    void (async () => {
      await clearDeviceToken();
      const fresh = pairingSection(null, "Un-paired. You can pair again below.");
      replaceSection("pairing", fresh);
      // Un-pairing tears down and rebuilds the whole section -- the old,
      // focused Un-pair button no longer exists to keep focus on, so it
      // was silently dropping to <body>. Land on the field the next
      // action (pairing again) actually needs, instead.
      fresh.querySelector<HTMLInputElement>('input[type="text"]')?.focus();
      await refreshStatusSection();
    })();
  });

  const form = el("form", { className: "field" }, [codeInput, pairButton]);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const code = codeInput.value.trim();
      if (code.length === 0) {
        codeInput.setAttribute("aria-invalid", "true");
        status.textContent = "Enter the code shown by npm run setup.";
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
        status.textContent = "Enter the code shown by npm run setup.";
        return;
      }
      codeInput.removeAttribute("aria-invalid");
      pairButton.disabled = true;
      status.textContent = "Pairing…";
      const result = await bridgeClient.pair(parsed.data);
      pairButton.disabled = false;
      if (!result.ok) {
        codeInput.setAttribute("aria-invalid", "true");
        status.textContent = result.error.message;
        return;
      }
      const token: StoredDeviceToken = { deviceId: result.value.deviceId, token: result.value.token, pairedAt: new Date().toISOString() };
      await setDeviceToken(token);
      const fresh = pairingSection(token, "Paired.");
      replaceSection("pairing", fresh);
      fresh.querySelector("button")?.focus();
      await refreshStatusSection();
    })();
  });

  return el("section", {}, [
    el("h2", { text: "Pairing" }),
    el("div", { className: "card pad stack" }, [currentState, codeLabel, form, status, unpairButton, statusPageLink()]),
  ]);
}

async function buildPairingSection(): Promise<HTMLElement> {
  const section = pairingSection(await getDeviceToken());
  section.dataset.section = "pairing";
  return section;
}

/**
 * `GET /status` (P07-B deliverable 2): connected/version/workspace when it
 * succeeds, and one of four clear, recoverable, announced states per the
 * bridge's own classification of the failure -- never a stuck spinner or a
 * raw error dump.
 */
function statusFailureMessage(error: BridgeError): string {
  if (error.code === "not_paired") return "Pair a device above to see the runner's status.";
  if (error.code === "network_error") return error.message;
  if (error.status === 401) return "Your pairing has expired or was revoked. Pair again above.";
  if (error.status === 403) return "This device isn't recognized by the runner (wrong extension or device). Pair again above.";
  if (error.status === 429) return "Too many attempts. Wait, then run `npm run pair` for a new code.";
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
      el("dd", { text: status.workspaceId }),
    ]),
  ]);
}

async function buildStatusSection(): Promise<HTMLElement> {
  const statusId = nextId("bridge-status");
  const result = await bridgeClient.getStatus();
  let body: HTMLElement;
  if (result.ok) {
    body = renderConnectedStatus(result.value);
    body.setAttribute("role", "status");
    body.id = statusId;
  } else if (result.error.code === "not_paired") {
    body = el("p", { className: "small", attrs: { role: "status", id: statusId }, text: statusFailureMessage(result.error) });
  } else {
    body = el("div", { className: "flash bad", attrs: { role: "alert", id: statusId }, text: statusFailureMessage(result.error) });
  }
  const section = el("section", {}, [el("h2", { text: "Status" }), body]);
  section.dataset.section = "status";
  return section;
}

async function refreshStatusSection(): Promise<void> {
  replaceSection("status", await buildStatusSection());
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

async function render(): Promise<void> {
  const pairing = await buildPairingSection();
  const status = await buildStatusSection();
  const lastCapture = await getLastJobCapture();
  const fileBridge = fileBridgeSection(lastCapture !== null);

  mount(
    app!,
    el("main", { className: "wrap" }, [
      el("h1", { text: "Job Assistant" }),
      el("span", { className: "small", text: "Pairing, runner status, and the file-bridge fallback." }),
      pairing,
      status,
      fileBridge,
    ]),
  );
}

void render();
