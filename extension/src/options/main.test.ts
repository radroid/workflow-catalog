import "../shared/zod-jitless";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Same dynamic-import pattern as popup/main.test.ts, for the same reason:
 * options/main.ts asserts #app exists and starts rendering as soon as it's
 * imported, so the DOM has to exist first and the module has to be
 * re-evaluated fresh per test. */

function installFakeChrome(sessionSeed: Record<string, unknown> = {}): {
  changeListeners: Array<(changes: Record<string, { newValue?: unknown }>, areaName: string) => void>;
  alarms: Map<string, { delayInMinutes?: number }>;
} {
  const sessionData: Record<string, unknown> = { ...sessionSeed };
  const changeListeners: Array<(changes: Record<string, { newValue?: unknown }>, areaName: string) => void> = [];
  const alarms = new Map<string, { delayInMinutes?: number }>();
  globalThis.chrome = {
    storage: {
      session: {
        async get(keys: string | string[] | null | undefined) {
          // null/undefined both mean "everything" -- shared/outbox.ts's
          // readOutbox() (now called on every Status render, via
          // outboxSummaryLine -- P07-B revision 1, B10) relies on
          // get(null) to enumerate every jobCaptureOutbox:<eventId> key.
          if (keys === undefined || keys === null) return { ...sessionData };
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
    // A successful pairing now flushes the outbox (E2/B3's "after a new
    // pairing, flush") and shared/outbox.ts's flushOutbox always touches
    // chrome.alarms at the end, so every test that pairs successfully
    // needs this, not just the ones that exercise the outbox directly.
    alarms: {
      async create(name: string, info: { delayInMinutes?: number }) {
        alarms.set(name, info);
      },
      async get(name: string) {
        return alarms.get(name);
      },
      async clear(name: string) {
        const existed = alarms.has(name);
        alarms.delete(name);
        return existed;
      },
    },
  } as unknown as typeof chrome;
  return { changeListeners, alarms };
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

  it("submitting a code the bridge rejects (wrong/expired) shows the bridge's own message, rendered with <code> instead of literal backticks (E3/B12), with a visible error style, and does not store a token", async () => {
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
    // The message's own literal backticks around "npm run pair" are gone
    // from the rendered text -- they became a real <code> element instead.
    expect(document.querySelector('[role="status"]')?.textContent).not.toContain("`");
    const codeEl = document.querySelector('[role="status"] code');
    expect(codeEl?.textContent).toBe("npm run pair");
    // B7: focus lands back on the code field after a failed pairing
    // attempt, not left wherever the browser's own post-submit default
    // would have put it.
    expect(document.activeElement).toBe(input);
  });

  it("P07-B revision 1, B8: a network error (runner down) while pairing does NOT mark the code field invalid -- the code itself wasn't the problem", async () => {
    installFakeChrome();
    // beforeEach's default fetch already rejects (network_error).
    await import("./main");
    await vi.waitFor(() => expect(document.querySelector("form")).not.toBeNull());

    const input = document.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = "7KQ2M-X9RTB";
    const form = document.querySelector("form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(document.querySelector('[role="status"]')?.textContent).toContain("Can't reach the runner");
    });
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("P07-B revision 1, B8: a 429 while pairing does NOT mark the code field invalid, and shows the minutes countdown", async () => {
    installFakeChrome();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: { code: "too_many_attempts", message: "Too many wrong pairing codes." } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "600" },
      })) as typeof fetch;
    await import("./main");
    await vi.waitFor(() => expect(document.querySelector("form")).not.toBeNull());

    const input = document.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = "7KQ2M-X9RTB";
    const form = document.querySelector("form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(document.querySelector('[role="status"]')?.textContent).toBe("Too many tries. Try again in about 10 minutes.");
    });
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("P07-B revision 1, B7: the Pairing section's live region is the SAME DOM node across a pair -- a screen reader only announces mutations to a node that was already present, not one just (re)inserted", async () => {
    installFakeChrome();
    await import("./main");
    await vi.waitFor(() => expect(document.querySelector("form")).not.toBeNull());
    const before = document.querySelector('[data-section="pairing"] [role="status"]');
    expect(before).not.toBeNull();

    stubFetch(() => jsonResponse(200, { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "opaque-token" }));
    const input = document.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = "7KQ2M-X9RTB";
    (document.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toBe("Paired."));

    const after = document.querySelector('[data-section="pairing"] [role="status"]');
    expect(after, "same node instance, not a freshly created replacement").toBe(before);
  });
});

describe("P07-B revision 1, E3/B12/polish: the code label and the collapsed 'Pair again' form", () => {
  it("a fresh, never-paired page credits npm run setup for the code, as <code>", async () => {
    installFakeChrome();
    await import("./main");
    await vi.waitFor(() => expect(document.querySelector("label")).not.toBeNull());
    const label = document.querySelector('label[for]') as HTMLLabelElement;
    expect(label.textContent).toBe("Code from npm run setup");
    expect(label.querySelector("code")?.textContent).toBe("npm run setup");
  });

  it("once paired, the code form collapses behind 'Pair again', which expands it and focuses the code field on click", async () => {
    installFakeChrome({
      deviceToken: { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "opaque-token", pairedAt: "2026-09-22T09:00:00.000Z" },
    });
    await import("./main");
    await vi.waitFor(() => expect(document.body.textContent).toContain("8b0c6f0e"));

    const codeInput = document.querySelector('input[type="text"]') as HTMLInputElement;
    expect(codeInput.closest("[hidden]"), "the code form starts collapsed while already paired").not.toBeNull();
    const pairAgainButton = [...document.querySelectorAll("button")].find((b) => b.textContent === "Pair again") as HTMLButtonElement;
    expect(pairAgainButton.hidden).toBe(false);

    pairAgainButton.click();

    expect(pairAgainButton.hidden).toBe(true);
    expect(codeInput.closest('[hidden]')).toBeNull();
    expect(document.activeElement).toBe(codeInput);
    // Re-pairing after having been paired before credits npm run pair, not setup.
    const label = document.querySelector('label[for]') as HTMLLabelElement;
    expect(label.querySelector("code")?.textContent).toBe("npm run pair");
  });

  it("after Un-pair, the code label now credits npm run pair (this browser has paired before)", async () => {
    installFakeChrome({
      deviceToken: { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "opaque-token", pairedAt: "2026-09-22T09:00:00.000Z" },
    });
    await import("./main");
    await vi.waitFor(() => expect(document.body.textContent).toContain("8b0c6f0e"));
    const unpairButton = [...document.querySelectorAll("button")].find((b) => b.textContent === "Un-pair") as HTMLButtonElement;
    unpairButton.click();
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toContain("Un-paired"));

    const label = document.querySelector('label[for]') as HTMLLabelElement;
    expect(label.querySelector("code")?.textContent).toBe("npm run pair");
  });
});

describe("P07-B revision 1, E2/E4", () => {
  it("E4: the options page states, in one line, that quitting Chrome un-pairs it (storage.session's own lifetime)", async () => {
    installFakeChrome();
    await import("./main");
    await vi.waitFor(() => expect(document.querySelector("main")).not.toBeNull());
    expect(document.body.textContent).toContain("quitting Chrome un-pairs it");
  });

  it("E2 + B3 'after a new pairing, flush': a capture queued (paused) from an earlier not-paired Save is delivered the moment pairing succeeds", async () => {
    installFakeChrome();
    const { enqueueCapture, listQueuedCaptures } = await import("../shared/outbox");
    const capture = {
      protocol: 1 as const,
      type: "job_capture" as const,
      eventId: "11111111-1111-4111-8111-111111111111",
      url: "https://jobs.example/postings/1",
      text: "Backend Engineer — Quill, a fictional posting for tests.",
      extractorVersion: "extractor@0.1.0",
      contentHash: "a".repeat(64),
      occurredAt: "2026-09-22T00:00:00.000Z",
    };
    await enqueueCapture(capture, { code: "not_paired", message: "not paired" });
    expect((await listQueuedCaptures())[0]?.pausedReason).toBe("not_paired");

    let posted = false;
    stubFetch((url) => {
      if (url === "http://127.0.0.1:4310/pair") {
        return jsonResponse(200, { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "opaque-token" });
      }
      posted = true;
      return jsonResponse(200, { ok: true, eventId: capture.eventId, type: "job_capture", duplicate: false, outcome: "journaled" });
    });
    await import("./main");
    await vi.waitFor(() => expect(document.querySelector("form")).not.toBeNull());

    const input = document.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = "7KQ2M-X9RTB";
    (document.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toBe("Paired."));

    await vi.waitFor(async () => expect(await listQueuedCaptures()).toEqual([]));
    expect(posted).toBe(true);
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
  it("shows 'pair this browser' (not an error) when nothing is paired yet", async () => {
    installFakeChrome();
    await import("./main");
    await vi.waitFor(() => {
      expect(document.querySelector('[data-section="status"]')).not.toBeNull();
    });
    await vi.waitFor(() => {
      // The placeholder ("Checking the runner…", B4) resolves to the real
      // not-paired message asynchronously -- wait for that, not just the
      // section's initial (placeholder) presence.
      expect(document.querySelector('[data-section="status"]')?.textContent).toContain("Pair this browser above");
    });
    const section = document.querySelector('[data-section="status"]')!;
    expect(section.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows connected/version/workspace (abbreviated, full value in a title attribute) when the bridge answers", async () => {
    installFakeChrome({ deviceToken: { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "device-token", pairedAt: "2026-09-22T09:00:00.000Z" } });
    stubFetch(() =>
      jsonResponse(200, {
        version: "0.4.0",
        workspaceId: "ws_fictional_workspace_id",
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
    const workspaceDd = [...section.querySelectorAll("dt")].find((dt) => dt.textContent === "Workspace")?.nextElementSibling;
    expect(workspaceDd?.textContent).toBe("ws_ficti…");
    expect(workspaceDd?.getAttribute("title")).toBe("ws_fictional_workspace_id");
    for (const dt of section.querySelectorAll("dt")) {
      expect(dt.parentElement?.tagName).toBe("DL");
    }
  });

  it("P07-B revision 1, B10: shows an outbox summary line and a 'Check again' button", async () => {
    installFakeChrome();
    await import("./main");
    await vi.waitFor(() => {
      expect(document.querySelector('[data-section="status"]')?.textContent).toContain("All saved jobs sent.");
    });
    const section = document.querySelector('[data-section="status"]')!;
    expect([...section.querySelectorAll("button")].some((b) => b.textContent === "Check again")).toBe(true);
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

  it("403 origin_not_allowed says this pairing belongs to a different install, re-pair (P07-B revision 1, B3 wording)", async () => {
    installFakeChrome({ deviceToken: { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "device-token", pairedAt: "2026-09-22T09:00:00.000Z" } });
    stubFetch(() => jsonResponse(403, { ok: false, error: { code: "origin_not_allowed", message: "This request's Origin is not the extension origin this device paired from." } }));
    await import("./main");
    await vi.waitFor(() => {
      expect(document.querySelector('[data-section="status"]')?.textContent).toContain("belongs to a different install");
    });
  });

  it("P07-B revision 1, B3: a stored origin-mismatch flag (set by a POST job_capture's own 403, which GET /status could never see itself) shows the same message without ever calling GET /status", async () => {
    installFakeChrome({ deviceToken: { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "device-token", pairedAt: "2026-09-22T09:00:00.000Z" }, pairingOriginMismatch: true });
    globalThis.fetch = (() => {
      throw new Error("must not call GET /status once the stored mismatch flag is set");
    }) as typeof fetch;
    await import("./main");
    await vi.waitFor(() => {
      expect(document.querySelector('[data-section="status"]')?.textContent).toContain("belongs to a different install");
    });
  });

  it("401 clears the stored token (bridge-client.ts's onTokenInvalid) so Pairing also stops showing paired, in the same render pass (P07-B revision 1, B3)", async () => {
    installFakeChrome({ deviceToken: { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "device-token", pairedAt: "2026-09-22T09:00:00.000Z" } });
    stubFetch(() => jsonResponse(401, { ok: false, error: { code: "token_invalid", message: "This device token is not valid (unknown, revoked or expired). Pair the extension again." } }));
    await import("./main");
    await vi.waitFor(() => {
      expect(document.querySelector('[data-section="status"]')?.textContent).toContain("expired or was revoked");
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-section="pairing"]')?.textContent).toContain("Not paired yet.");
    });
    const unpairButton = [...document.querySelectorAll('[data-section="pairing"] button')].find((b) => b.textContent === "Un-pair") as HTMLButtonElement;
    expect(unpairButton.disabled).toBe(true);
  });

  it("P07-B revision 1, B8: 429 says 'Too many tries', with a minutes countdown from Retry-After", async () => {
    installFakeChrome({ deviceToken: { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "device-token", pairedAt: "2026-09-22T09:00:00.000Z" } });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: { code: "too_many_attempts", message: "Too many wrong pairing codes." } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "137" },
      })) as typeof fetch;
    await import("./main");
    await vi.waitFor(() => {
      expect(document.querySelector('[data-section="status"]')?.textContent).toContain("Too many tries. Try again in about 3 minutes.");
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
