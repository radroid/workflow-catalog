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

let originalFetch: typeof fetch;

/** Every render() calls GET /status once, in addition to whatever a given
 * test's own pairing submit does -- so every test needs *some* fetch
 * behaviour defined, never a real network call. Default: reject, as if the
 * runner isn't running; a test that seeds a deviceToken and cares about a
 * specific response overrides this with stubFetch(). */
function stubFetch(handler: (url: string, init: RequestInit) => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
});

afterEach(() => {
  document.body.innerHTML = "";
  globalThis.fetch = originalFetch;
  // @ts-expect-error -- test cleanup of a partial chrome stub
  delete globalThis.chrome;
});

describe("options page pairing form (review fold-in g: Enter should submit, not do nothing)", () => {
  it("submitting the form (Enter in the code field) with a whitespace-only code shows the invalid-code message instead of calling the bridge", async () => {
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

  it("submitting a code longer than the contracts cap is refused locally, with a visible error style, never reaching the bridge", async () => {
    installFakeChrome();
    globalThis.fetch = (() => {
      throw new Error("must not call fetch for a code that fails local validation");
    }) as typeof fetch;
    await import("./main");
    await vi.waitFor(() => {
      expect(document.querySelector("form")).not.toBeNull();
    });

    const input = document.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = "X".repeat(65);
    const form = document.querySelector("form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(document.querySelector('[role="status"]')?.textContent).toContain("Enter the code");
    });
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("submitting a real-shaped code that the bridge accepts shows the abbreviated device id and announces 'Paired.'", async () => {
    installFakeChrome();
    stubFetch((url) => {
      expect(url).toBe("http://127.0.0.1:4310/pair");
      return jsonResponse(200, { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "opaque-token" });
    });
    await import("./main");
    await vi.waitFor(() => {
      expect(document.querySelector("form")).not.toBeNull();
    });

    const input = document.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = "7KQ2M-X9RTB";
    const form = document.querySelector("form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(document.querySelector('[role="status"]')?.textContent).toBe("Paired.");
    });
    expect(document.body.textContent).toContain("8b0c6f0e");
    const unpairButton = [...document.querySelectorAll("button")].find((b) => b.textContent === "Un-pair");
    expect(unpairButton?.disabled).toBe(false);
  });

  it("submitting a code the bridge rejects (wrong/expired) shows the bridge's own message and a visible error style, and does not store a token", async () => {
    installFakeChrome();
    stubFetch(() =>
      jsonResponse(401, {
        ok: false,
        error: { code: "pairing_code_invalid", message: "This pairing code is not valid: it is wrong, was already used, or was withdrawn after too many wrong tries. Run `npm run pair` for a new one." },
      }),
    );
    await import("./main");
    await vi.waitFor(() => {
      expect(document.querySelector("form")).not.toBeNull();
    });

    const input = document.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = "AAAAA-AAAAA";
    const form = document.querySelector("form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(document.querySelector('[role="status"]')?.textContent).toContain("npm run pair");
    });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.body.textContent).toContain("Not paired yet.");
  });
});

describe("un-pairing", () => {
  it("forgets the token, announces the un-pair, and always links to the runner's status page for actual revocation", async () => {
    installFakeChrome({
      deviceToken: { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "opaque-token", pairedAt: "2026-09-22T09:00:00.000Z" },
    });
    await import("./main");
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("8b0c6f0e");
    });

    const statusLink = document.querySelector('a[href="http://127.0.0.1:4310/ui/status"]');
    expect(statusLink, "the status-page link should already be present while paired").not.toBeNull();

    const unpairButton = [...document.querySelectorAll("button")].find((b) => b.textContent === "Un-pair") as HTMLButtonElement;
    unpairButton.click();

    await vi.waitFor(() => {
      expect(document.querySelector('[role="status"]')?.textContent).toContain("Un-paired");
    });
    expect(document.body.textContent).toContain("Not paired yet.");
    expect(document.querySelector('a[href="http://127.0.0.1:4310/ui/status"]'), "the status-page link should still be present unpaired").not.toBeNull();
    // Focus lands on the code field, not silently dropped to <body>
    // (part-A review issue 5, still true with the new flash-message path).
    expect(document.activeElement).toBe(document.querySelector('input[type="text"]'));
  });
});

describe("runner status section (P07-B deliverable 2: GET /status)", () => {
  it("shows 'pair a device' (not an error) when nothing is paired yet", async () => {
    installFakeChrome();
    await import("./main");
    await vi.waitFor(() => {
      expect(document.querySelector('[data-section="status"]')).not.toBeNull();
    });
    const section = document.querySelector('[data-section="status"]')!;
    expect(section.textContent).toContain("Pair a device above");
    expect(section.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows connected/version/workspace when the bridge answers", async () => {
    installFakeChrome({ deviceToken: { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "device-token", pairedAt: "2026-09-22T09:00:00.000Z" } });
    stubFetch(() =>
      jsonResponse(200, {
        version: "0.4.0",
        workspaceId: "ws_fictional",
        budget: { dailyRunLimit: 0, runsUsedToday: 0, paused: false },
        schedules: [],
      }),
    );
    await import("./main");
    await vi.waitFor(() => {
      const section = document.querySelector('[data-section="status"]');
      expect(section?.textContent).toContain("0.4.0");
    });
    const section = document.querySelector('[data-section="status"]')!;
    expect(section.textContent).toContain("ws_fictional");
    for (const dt of section.querySelectorAll("dt")) {
      expect(dt.parentElement?.tagName).toBe("DL");
    }
  });

  it("runner not running (network error) shows a clear, recoverable message", async () => {
    installFakeChrome({ deviceToken: { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "device-token", pairedAt: "2026-09-22T09:00:00.000Z" } });
    // beforeEach's default fetch already rejects -- exercised as-is.
    await import("./main");
    await vi.waitFor(() => {
      const section = document.querySelector('[data-section="status"]');
      expect(section).not.toBeNull();
      expect(section!.querySelector('[role="alert"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-section="status"]')?.textContent).toContain("npm run runner");
  });

  it("401 (expired or revoked token) says to re-pair", async () => {
    installFakeChrome({ deviceToken: { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "device-token", pairedAt: "2026-09-22T09:00:00.000Z" } });
    stubFetch(() => jsonResponse(401, { ok: false, error: { code: "token_invalid", message: "This device token is not valid (unknown, revoked or expired). Pair the extension again." } }));
    await import("./main");
    await vi.waitFor(() => {
      expect(document.querySelector('[data-section="status"]')?.textContent).toContain("expired or was revoked");
    });
  });

  it("403 origin_not_allowed says wrong extension or device, re-pair", async () => {
    installFakeChrome({ deviceToken: { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "device-token", pairedAt: "2026-09-22T09:00:00.000Z" } });
    stubFetch(() => jsonResponse(403, { ok: false, error: { code: "origin_not_allowed", message: "This request's Origin is not the extension origin this device paired from." } }));
    await import("./main");
    await vi.waitFor(() => {
      expect(document.querySelector('[data-section="status"]')?.textContent).toContain("isn't recognized by the runner");
    });
  });

  it("429 says wait, then get a new code with npm run pair", async () => {
    installFakeChrome({ deviceToken: { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "device-token", pairedAt: "2026-09-22T09:00:00.000Z" } });
    stubFetch(() => jsonResponse(429, { ok: false, error: { code: "too_many_attempts", message: "Too many wrong pairing codes." } }));
    await import("./main");
    await vi.waitFor(() => {
      expect(document.querySelector('[data-section="status"]')?.textContent).toContain("npm run pair");
    });
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
