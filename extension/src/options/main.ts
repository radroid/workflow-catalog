import "../shared/zod-jitless";
import { pairRequestSchema, type SessionManifest } from "@workflow-catalog/contracts";
import { stubBridgeClient } from "../shared/bridge-client";
import { el, mount } from "../shared/dom";
import { downloadJson } from "../shared/download";
import { clearDeviceToken, getDeviceToken, getLastJobCapture, type StoredDeviceToken } from "../shared/storage";
import { applyColorScheme } from "../shared/theme-init";
import { parseSessionManifestFile } from "../file-bridge/session-import";
import "./style.css";

applyColorScheme();

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("options/index.html is missing #app");
}

function pairingSection(current: StoredDeviceToken | null): HTMLElement {
  const codeInput = el("input", { attrs: { type: "text", placeholder: "Code from npm run setup" } }) as HTMLInputElement;
  const pairButton = el("button", { className: "primary", text: "Pair" });
  const status = el("p", { className: "small" });

  const paired = current !== null;

  const currentState = paired
    ? el("div", { className: "kv" }, [
        el("dt", { text: "Device" }),
        el("dd", { text: current.deviceName }),
        el("dt", { text: "Paired" }),
        el("dd", { text: current.pairedAt }),
      ])
    : el("p", { className: "small", text: "Not paired yet." });

  const unpairButton = el("button", { text: "Un-pair", attrs: paired ? {} : { disabled: "true" } });
  unpairButton.toggleAttribute("disabled", !paired);
  unpairButton.addEventListener("click", () => {
    void (async () => {
      await clearDeviceToken();
      replaceSection("pairing", await buildPairingSection());
    })();
  });

  pairButton.addEventListener("click", () => {
    void (async () => {
      status.textContent = "";
      const parsed = pairRequestSchema.safeParse({ code: codeInput.value });
      if (!parsed.success) {
        status.textContent = "Enter the code shown by npm run setup.";
        return;
      }
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
    el("div", { className: "card pad stack" }, [
      currentState,
      el("div", { className: "field" }, [codeInput, pairButton]),
      status,
      unpairButton,
    ]),
  ]);
}

async function buildPairingSection(): Promise<HTMLElement> {
  return pairingSection(await getDeviceToken());
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
    el("div", { className: "kv" }, [
      el("dt", { text: "Session" }),
      el("dd", { text: manifest.sessionId }),
      el("dt", { text: "Title" }),
      el("dd", { text: manifest.title }),
      el("dt", { text: "Created" }),
      el("dd", { text: manifest.createdAt }),
      el("dt", { text: "Items" }),
      el("dd", { text: String(manifest.items.length) }),
    ]),
    el("div", { className: "item-list" }, itemRows),
    el("p", { className: "small", text: "Read-only preview. Opening tabs arrives in a later version." }),
  ]);
}

function fileBridgeSection(hasLastCapture: boolean): HTMLElement {
  const exportButton = el("button", {
    className: "primary",
    text: hasLastCapture ? "Export last capture" : "No capture saved yet",
    attrs: hasLastCapture ? {} : { disabled: "true" },
  });
  exportButton.toggleAttribute("disabled", !hasLastCapture);
  const exportStatus = el("p", { className: "small" });

  exportButton.addEventListener("click", () => {
    void (async () => {
      const capture = await getLastJobCapture();
      if (!capture) {
        exportStatus.textContent = "No capture saved yet — save one from the popup first.";
        return;
      }
      downloadJson("job-capture.json", capture);
      exportStatus.textContent = "Exported job-capture.json.";
    })();
  });

  const fileInput = el("input", { attrs: { type: "file", accept: "application/json,.json" } }) as HTMLInputElement;
  const importResult = el("div", { className: "stack" });

  fileInput.addEventListener("change", () => {
    void (async () => {
      mount(importResult);
      const file = fileInput.files?.[0];
      if (!file) return;
      const text = await file.text();
      const parsed = parseSessionManifestFile(text);
      if (!parsed.ok) {
        mount(importResult, el("div", { className: "flash bad", text: parsed.reason }));
        return;
      }
      mount(importResult, renderSessionSummary(parsed.manifest));
    })();
  });

  return el("section", {}, [
    el("h2", { text: "File bridge" }),
    el("div", { className: "card pad stack" }, [
      el("div", { className: "stack" }, [exportButton, exportStatus]),
      el("div", { className: "stack" }, [
        el("label", { className: "small", text: "Import application-session.json" }),
        fileInput,
        importResult,
      ]),
    ]),
  ]);
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
  pairing.dataset.section = "pairing";

  const lastCapture = await getLastJobCapture();
  const fileBridge = fileBridgeSection(lastCapture !== null);
  fileBridge.dataset.section = "fileBridge";

  mount(
    app!,
    el("div", { className: "wrap" }, [
      el("h1", { text: "Job Assistant" }),
      el("span", { className: "small", text: "Pairing and the file-bridge fallback." }),
      pairing,
      fileBridge,
    ]),
  );
}

void render();
