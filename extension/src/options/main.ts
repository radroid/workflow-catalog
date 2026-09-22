import "../shared/zod-jitless";
import { jobCaptureSchema, pairRequestSchema, type SessionManifest } from "@workflow-catalog/contracts";
import { stubBridgeClient } from "../shared/bridge-client";
import { el, mount } from "../shared/dom";
import { downloadJson } from "../shared/download";
import { abbreviateUuid, formatTimestamp } from "../shared/format";
import { clearDeviceToken, getDeviceToken, getLastJobCapture, type StoredDeviceToken } from "../shared/storage";
import { applyColorScheme } from "../shared/theme-init";
import { checkImportFileSize, parseSessionManifestFile } from "../file-bridge/session-import";
import "./style.css";

applyColorScheme();

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("options/index.html is missing #app");
}

let pairingCodeFieldId = 0;
function nextId(prefix: string): string {
  pairingCodeFieldId += 1;
  return `${prefix}-${pairingCodeFieldId}`;
}

function pairingSection(current: StoredDeviceToken | null): HTMLElement {
  const codeFieldId = nextId("pairing-code");
  const statusId = nextId("pairing-status");

  const codeInput = el("input", {
    attrs: { type: "text", id: codeFieldId, placeholder: "e.g. FERN-4821", "aria-describedby": statusId },
  }) as HTMLInputElement;
  const codeLabel = el("label", { className: "small", attrs: { for: codeFieldId }, text: "Code from npm run setup" });
  const pairButton = el("button", { className: "primary", attrs: { type: "submit" }, text: "Pair" });
  const status = el("p", { className: "small", attrs: { id: statusId, role: "status", "aria-live": "polite" } });

  const paired = current !== null;

  const currentState = paired
    ? el("dl", { className: "kv" }, [
        el("dt", { text: "Device" }),
        el("dd", { text: current.deviceName }),
        el("dt", { text: "Paired" }),
        el("dd", { text: formatTimestamp(current.pairedAt) }),
      ])
    : el("p", { className: "small", text: "Not paired yet." });

  const unpairButton = el("button", { text: "Un-pair", attrs: paired ? {} : { disabled: "true" } });
  unpairButton.toggleAttribute("disabled", !paired);
  unpairButton.addEventListener("click", () => {
    void (async () => {
      await clearDeviceToken();
      const fresh = await buildPairingSection();
      replaceSection("pairing", fresh);
      // Un-pairing tears down and rebuilds the whole section -- the old,
      // focused Un-pair button no longer exists to keep focus on, so it
      // was silently dropping to <body>. Land on the field the next
      // action (pairing again) actually needs, instead.
      fresh.querySelector<HTMLInputElement>('input[type="text"]')?.focus();
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
      const parsed = pairRequestSchema.safeParse({ code });
      if (!parsed.success) {
        codeInput.setAttribute("aria-invalid", "true");
        status.textContent = "Enter the code shown by npm run setup.";
        return;
      }
      codeInput.removeAttribute("aria-invalid");
      pairButton.disabled = true;
      const result = await stubBridgeClient.pair(parsed.data);
      pairButton.disabled = false;
      // Part A's stub never succeeds (no network — see bridge-client.ts);
      // this is still real wiring, not a fake success path.
      status.textContent = result.ok ? "Paired." : result.message;
    })();
  });

  return el("section", {}, [
    el("h2", { text: "Pairing" }),
    el("div", { className: "card pad stack" }, [currentState, codeLabel, form, status, unpairButton]),
  ]);
}

async function buildPairingSection(): Promise<HTMLElement> {
  const section = pairingSection(await getDeviceToken());
  section.dataset.section = "pairing";
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

async function render(): Promise<void> {
  const pairing = await buildPairingSection();
  const lastCapture = await getLastJobCapture();
  const fileBridge = fileBridgeSection(lastCapture !== null);

  mount(
    app!,
    el("main", { className: "wrap" }, [
      el("h1", { text: "Job Assistant" }),
      el("span", { className: "small", text: "Pairing and the file-bridge fallback." }),
      pairing,
      fileBridge,
    ]),
  );
}

void render();
