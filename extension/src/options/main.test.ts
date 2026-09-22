import "../shared/zod-jitless";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Same dynamic-import pattern as popup/main.test.ts, for the same reason:
 * options/main.ts asserts #app exists and starts rendering as soon as it's
 * imported, so the DOM has to exist first and the module has to be
 * re-evaluated fresh per test. */

function installFakeChrome(sessionSeed: Record<string, unknown> = {}): {
  changeListeners: Array<(changes: Record<string, { newValue?: unknown }>, areaName: string) => void>;
} {
  const sessionData: Record<string, unknown> = { ...sessionSeed };
  const changeListeners: Array<(changes: Record<string, { newValue?: unknown }>, areaName: string) => void> = [];
  globalThis.chrome = {
    storage: {
      session: {
        async get(keys: string | string[] | undefined) {
          if (keys === undefined) return { ...sessionData };
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const key of list) if (key in sessionData) out[key] = sessionData[key];
          return out;
        },
        async set(items: Record<string, unknown>) {
          Object.assign(sessionData, items);
        },
        async remove(keys: string | string[]) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete sessionData[key];
        },
      },
      onChanged: {
        addListener: (fn: (changes: Record<string, { newValue?: unknown }>, areaName: string) => void) => {
          changeListeners.push(fn);
        },
      },
    },
  } as unknown as typeof chrome;
  return { changeListeners };
}

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
  document.body.innerHTML = "";
  // @ts-expect-error -- test cleanup of a partial chrome stub
  delete globalThis.chrome;
});

describe("options page pairing form (review fold-in g: Enter should submit, not do nothing)", () => {
  it("submitting the form (Enter in the code field) with a whitespace-only code shows the invalid-code message instead of calling the stub (fold-in g: trim + refuse whitespace-only)", async () => {
    installFakeChrome();
    await import("./main");
    await vi.waitFor(() => {
      expect(document.querySelector("form")).not.toBeNull();
    });

    const input = document.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = "   ";
    const form = document.querySelector("form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(document.querySelector('[role="status"]')?.textContent).toContain("Enter the code");
    });
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("submitting a real-shaped code reaches the stub bridge client (a real 'not connected yet' result, not a client-side rejection)", async () => {
    installFakeChrome();
    await import("./main");
    await vi.waitFor(() => {
      expect(document.querySelector("form")).not.toBeNull();
    });

    const input = document.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = "FERN-4821";
    const form = document.querySelector("form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(document.querySelector('[role="status"]')?.textContent).toContain("next version");
    });
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });
});

describe("options page accessible structure (review issue 6: axe WCAG A failures)", () => {
  it("the pairing code field has a real <label for>, not just a placeholder", async () => {
    installFakeChrome();
    await import("./main");
    await vi.waitFor(() => {
      expect(document.querySelector('input[type="text"]')).not.toBeNull();
    });
    const input = document.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input.labels?.length).toBeGreaterThan(0);
    expect(input.labels?.[0]?.textContent).toContain("Code from npm run setup");
  });

  it("the file input has a real <label for>", async () => {
    installFakeChrome();
    await import("./main");
    await vi.waitFor(() => {
      expect(document.querySelector('input[type="file"]')).not.toBeNull();
    });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.labels?.length).toBeGreaterThan(0);
  });

  it("uses <dl>/<dt>/<dd> for the file-bridge/pairing summaries, never dt/dd loose inside a div", async () => {
    installFakeChrome({
      deviceToken: {
        deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f",
        token: "fictional-token",
        deviceName: "Sam's test laptop",
        pairedAt: "2026-09-22T09:00:00.000Z",
      },
    });
    await import("./main");
    await vi.waitFor(() => {
      expect(document.querySelector("dt")).not.toBeNull();
    });
    for (const dt of document.querySelectorAll("dt")) {
      expect(dt.parentElement?.tagName).toBe("DL");
    }
  });

  it("wraps the page content in a <main> landmark", async () => {
    installFakeChrome();
    await import("./main");
    await vi.waitFor(() => {
      expect(document.querySelector("main")).not.toBeNull();
    });
  });
});

describe("file import size limit (review issue 3)", () => {
  it("refuses an oversized file with a visible alert, without reading it, instead of hanging", async () => {
    installFakeChrome();
    await import("./main");
    await vi.waitFor(() => {
      expect(document.querySelector('input[type="file"]')).not.toBeNull();
    });

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    // 300,000 bytes: over MAX_BRIDGE_BODY_BYTES (262,144) without actually
    // allocating anything close to the reviewer's 20 MB repro.
    const big = new File([new Uint8Array(300_000)], "big.json", { type: "application/json" });
    Object.defineProperty(fileInput, "files", { value: [big], writable: false });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')).not.toBeNull();
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/too large/i);
  });
});

describe("export button reactivity (review fold-in d: reflect storage changes without a reload)", () => {
  it("enables the export button when chrome.storage.onChanged reports a new lastJobCapture", async () => {
    const { changeListeners } = installFakeChrome();
    await import("./main");
    await vi.waitFor(() => {
      expect(changeListeners.length).toBeGreaterThan(0);
    });

    const exportButton = [...document.querySelectorAll("button")].find((b) => /capture/i.test(b.textContent ?? "")) as HTMLButtonElement;
    expect(exportButton.disabled).toBe(true);

    for (const listener of changeListeners) {
      listener({ lastJobCapture: { newValue: { protocol: 1 } } }, "session");
    }

    expect(exportButton.disabled).toBe(false);
    expect(exportButton.textContent).toBe("Export last capture");
  });
});
