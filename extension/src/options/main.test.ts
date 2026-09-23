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

afterEach(async () => {
  // The page keeps working after a test's last assertion: render()'s
  // status check goes on to re-sync Pairing and read the outbox. Let that
  // finish against this test's fakes before they are torn down --
  // otherwise it rejects with "chrome is not defined" after the test.
  await new Promise((resolve) => setTimeout(resolve, 20));
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
    // P07-B revision 3 polish: "yet" only for a browser that never paired.
    expect(document.querySelector('[data-section="pairing"]')?.textContent).toContain("Not paired.");
    expect(document.body.textContent).not.toContain("Not paired yet.");
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

  it("P07-B revision 1, B10: shows a 'Check again' button, and -- revision 2 polish -- no outbox line on a fresh install, where nothing was ever queued", async () => {
    installFakeChrome();
    await import("./main");
    await vi.waitFor(() => {
      expect(document.querySelector('[data-section="status"]')?.textContent).toContain("Pair this browser above");
    });
    const section = document.querySelector('[data-section="status"]')!;
    expect([...section.querySelectorAll("button")].some((b) => b.textContent === "Check again")).toBe(true);
    expect(section.textContent).not.toContain("saved job");
  });

  it("P07-B revision 1, B10: 'All saved jobs sent.' once something queued in this browser session has gone out", async () => {
    installFakeChrome({ jobCaptureOutboxUsedThisSession: true });
    await import("./main");
    await vi.waitFor(() => {
      expect(document.querySelector('[data-section="status"]')?.textContent).toContain("All saved jobs sent.");
    });
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
      expect(document.querySelector('[data-section="pairing"]')?.textContent).toContain("Not paired.");
    });
    // P07-B revision 3 polish: after an expiry, not "Not paired yet."
    expect(document.querySelector('[data-section="pairing"]')?.textContent).not.toContain("Not paired yet.");
    const unpairButton = [...document.querySelectorAll('[data-section="pairing"] button')].find((b) => b.textContent === "Un-pair") as HTMLButtonElement;
    expect(unpairButton.disabled).toBe(true);
    expect(unpairButton.closest("[hidden]"), "P07-B revision 2 polish: nothing to un-pair, so not shown").not.toBeNull();
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

describe("P07-B revision 2, C2 and polish: Status updates in place, and Pairing keeps up", () => {
  const PAIRED = { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "device-token", pairedAt: "2026-09-22T09:00:00.000Z" };
  const STATUS_OK = { version: "0.4.0", workspaceId: "ws_fictional_workspace_id", budget: { dailyRunLimit: 0, runsUsedToday: 0, paused: false }, schedules: [] };
  const TOKEN_INVALID = { ok: false, error: { code: "token_invalid", message: "This device token is not valid (unknown, revoked or expired). Pair the extension again." } };

  /** Lets every pending promise chain (the fake storage and fetch are
   * promise-only) run to the end. */
  function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 20));
  }

  function statusSection(): Element {
    return document.querySelector('[data-section="status"]')!;
  }

  function checkAgainButton(): HTMLButtonElement {
    return [...statusSection().querySelectorAll("button")].find((b) => b.textContent === "Check again") as HTMLButtonElement;
  }

  function watch(target: Node): MutationRecord[] {
    const records: MutationRecord[] = [];
    new MutationObserver((batch) => records.push(...batch)).observe(target, { subtree: true, childList: true, characterData: true, attributes: true });
    return records;
  }

  it("'Check again' keeps focus, holds 'Checking…' long enough to see, and restates an unchanged problem: the alert re-inserted once, nothing else in the section touched (revision 3 polish)", async () => {
    installFakeChrome({ deviceToken: PAIRED });
    let statusCalls = 0;
    globalThis.fetch = (() => {
      statusCalls += 1;
      return Promise.reject(new TypeError("Failed to fetch"));
    }) as typeof fetch;
    await import("./main");
    await vi.waitFor(() => expect(statusSection().querySelector('[role="alert"]')).not.toBeNull());
    await settle();
    const section = statusSection();
    const alertBefore = section.querySelector('[role="alert"]')!;
    const button = checkAgainButton();
    button.focus();
    const callsBefore = statusCalls;
    const records = watch(section);

    button.click();
    expect(button.textContent, "shows the check it started").toBe("Checking…");
    await vi.waitFor(() => expect(statusCalls).toBe(callsBefore + 1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(button.textContent, "revision 2's label lasted about 6 ms").toBe("Checking…");
    await vi.waitFor(() => expect(button.textContent).toBe("Check again"));
    await settle();

    expect(statusSection(), "the section itself is never rebuilt").toBe(section);
    expect(document.activeElement, "revision 1 dropped focus to <body> here").toBe(button);
    const alertAfter = section.querySelector('[role="alert"]')!;
    expect(alertAfter, "restated: a fresh alert, so it is announced again").not.toBe(alertBefore);
    expect(alertAfter.textContent).toBe(alertBefore.textContent);
    expect(section.querySelectorAll('[role="alert"]'), "one alert, never two").toHaveLength(1);
    const outsideTheButton = records.filter((record) => !button.contains(record.target));
    expect(outsideTheButton.length).toBeGreaterThan(0);
    expect(
      outsideTheButton.every(
        (record) =>
          record.type === "childList" &&
          [...record.addedNodes, ...record.removedNodes].every((node) => node instanceof Element && node.getAttribute("role") === "alert"),
      ),
      "nothing but the button's label and the alert itself changed",
    ).toBe(true);
  });

  it("'Check again' restates an unchanged connected state in the polite region; a window-focus re-check still says nothing (revision 3 polish)", async () => {
    installFakeChrome({ deviceToken: PAIRED });
    stubFetch(() => jsonResponse(200, STATUS_OK));
    await import("./main");
    await vi.waitFor(() => expect(statusSection().textContent).toContain("Connected"));
    await settle();
    const politeRegion = statusSection().querySelector('[role="status"]')!;
    const cardBefore = politeRegion.firstElementChild;

    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(politeRegion.firstElementChild, "a re-check nobody asked for changes nothing").toBe(cardBefore);

    checkAgainButton().click();
    await vi.waitFor(() => expect(checkAgainButton()).toBeDefined());
    await settle();
    expect(politeRegion.firstElementChild, "refilled, so the result is announced again").not.toBe(cardBefore);
    expect(politeRegion.textContent).toBe(cardBefore?.textContent);
    expect(statusSection().querySelector('[role="status"]'), "the same live region throughout").toBe(politeRegion);
  });

  it("a re-check on window focus that finds nothing new changes nothing; one that finds a change shows it in the polite region and removes the alert", async () => {
    installFakeChrome({ deviceToken: PAIRED });
    let runnerUp = false;
    globalThis.fetch = ((input: RequestInfo | URL) =>
      runnerUp && String(input).endsWith("/status") ? Promise.resolve(jsonResponse(200, STATUS_OK)) : Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
    await import("./main");
    await vi.waitFor(() => expect(statusSection().querySelector('[role="alert"]')).not.toBeNull());
    await settle();
    const section = statusSection();
    const politeRegion = section.querySelector('[role="status"]')!;
    const records = watch(section);

    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(records, "the same 'can't reach the runner' state: no DOM change, so nothing is re-announced").toEqual([]);

    runnerUp = true;
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(politeRegion.textContent).toContain("Connected"));
    expect(section.querySelector('[role="alert"]')).toBeNull();
    expect(section.querySelector('[role="status"]'), "the polite region is the same node throughout").toBe(politeRegion);
  });

  it("after a 401, the code label keeps crediting npm run pair, and a re-check keeps 'expired or was revoked' instead of 'Pair this browser above…'", async () => {
    installFakeChrome({ deviceToken: PAIRED });
    stubFetch(() => jsonResponse(401, TOKEN_INVALID));
    await import("./main");
    await vi.waitFor(() => expect(statusSection().textContent).toContain("expired or was revoked"));
    await vi.waitFor(() => expect(document.querySelector('[data-section="pairing"]')?.textContent).toContain("Not paired."));
    expect(document.querySelector('label[for] code')?.textContent, "revision 1 reverted to npm run setup here").toBe("npm run pair");

    checkAgainButton().click();
    await vi.waitFor(() => expect(checkAgainButton()).toBeDefined());
    await settle();
    expect(statusSection().querySelector('[role="alert"]')?.textContent).toBe("Your pairing has expired or was revoked. Pair again above.");
    expect(statusSection().textContent).not.toContain("Pair this browser above");
  });

  it("when a re-check's 401 rebuilds Pairing while focus is inside it, focus moves to the code field instead of <body>", async () => {
    installFakeChrome({ deviceToken: PAIRED });
    let revoked = false;
    globalThis.fetch = (() => Promise.resolve(revoked ? jsonResponse(401, TOKEN_INVALID) : jsonResponse(200, STATUS_OK))) as typeof fetch;
    await import("./main");
    await vi.waitFor(() => expect(statusSection().textContent).toContain("Connected"));
    const pairAgain = [...document.querySelectorAll("button")].find((b) => b.textContent === "Pair again") as HTMLButtonElement;
    pairAgain.focus();

    revoked = true;
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(document.querySelector('[data-section="pairing"]')?.textContent).toContain("Not paired."));

    expect(document.activeElement).toBe(document.querySelector('[data-section="pairing"] input[type="text"]'));
  });

  it("a routine re-check never rebuilds Pairing (the same section node, focus untouched)", async () => {
    installFakeChrome({ deviceToken: PAIRED });
    stubFetch(() => jsonResponse(200, STATUS_OK));
    await import("./main");
    await vi.waitFor(() => expect(statusSection().textContent).toContain("Connected"));
    const pairing = document.querySelector('[data-section="pairing"]');

    checkAgainButton().click();
    await settle();

    expect(document.querySelector('[data-section="pairing"]')).toBe(pairing);
  });

  it("unpaired, the Un-pair row is hidden, so the first control in Pairing is the code field", async () => {
    installFakeChrome();
    await import("./main");
    await vi.waitFor(() => expect(document.querySelector("form")).not.toBeNull());
    const pairing = document.querySelector('[data-section="pairing"]')!;
    const firstVisibleControl = [...pairing.querySelectorAll("button, input, a")].find((control) => control.closest("[hidden]") === null);
    expect(firstVisibleControl).toBe(pairing.querySelector('input[type="text"]'));
  });

  it("message tones (revision 3, H1): a refused code is amber .flash -- the person has to act -- and 'Paired.' the neutral .flash.ok", async () => {
    installFakeChrome();
    let accept = false;
    stubFetch(() =>
      accept
        ? jsonResponse(200, { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "opaque-token" })
        : jsonResponse(401, { ok: false, error: { code: "pairing_code_invalid", message: "This pairing code is not valid." } }),
    );
    await import("./main");
    await vi.waitFor(() => expect(document.querySelector("form")).not.toBeNull());
    const pairingStatus = document.querySelector('[data-section="pairing"] [role="status"]')!;
    const input = document.querySelector('input[type="text"]') as HTMLInputElement;

    input.value = "AAAAA-AAAAA";
    (document.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(pairingStatus.textContent).toBe("This pairing code is not valid."));
    expect(pairingStatus.className, "revision 2 drew this red").toBe("flash");

    accept = true;
    (document.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(pairingStatus.textContent).toBe("Paired."));
    expect(pairingStatus.className).toBe("flash ok");
  });

  it("'Pairing…' (revision 3 polish): the neutral .flash.info, Pair stays focusable (aria-disabled, never disabled), and a second submit while it waits is ignored", async () => {
    installFakeChrome();
    let pairCalls = 0;
    let answer: (response: Response) => void = () => undefined;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      if (!String(input).endsWith("/pair")) return Promise.reject(new TypeError("Failed to fetch"));
      pairCalls += 1;
      return new Promise<Response>((resolve) => {
        answer = resolve;
      });
    }) as typeof fetch;
    await import("./main");
    await vi.waitFor(() => expect(document.querySelector("form")).not.toBeNull());
    await settle();
    const pairingStatus = document.querySelector('[data-section="pairing"] [role="status"]')!;
    const input = document.querySelector('input[type="text"]') as HTMLInputElement;
    const form = document.querySelector("form") as HTMLFormElement;
    const pairButton = form.querySelector('button[type="submit"]') as HTMLButtonElement;

    input.value = "7KQ2M-X9RTB";
    pairButton.focus();
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(pairingStatus.textContent).toBe("Pairing…"));
    expect(pairingStatus.className).toBe("flash info");
    expect(pairButton.getAttribute("aria-disabled")).toBe("true");
    expect(pairButton.disabled, "revision 2 set disabled, which dropped focus to <body>").toBe(false);
    expect(document.activeElement).toBe(pairButton);

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(pairCalls, "the guard ignored the second submit").toBe(1);

    answer(jsonResponse(200, { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "opaque-token" }));
    await vi.waitFor(() => expect(pairingStatus.textContent).toBe("Paired."));
    expect(pairButton.hasAttribute("aria-disabled")).toBe(false);
  });

  it("UI issue 4 (revision 3): 'Enter the code shown by …' renders the command as <code>, not as plain text", async () => {
    installFakeChrome();
    await import("./main");
    await vi.waitFor(() => expect(document.querySelector("form")).not.toBeNull());
    const input = document.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = "";
    (document.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const pairingStatus = document.querySelector('[data-section="pairing"] [role="status"]')!;
    await vi.waitFor(() => expect(pairingStatus.textContent).toBe("Enter the code shown by npm run setup."));
    expect(pairingStatus.querySelector("code")?.textContent).toBe("npm run setup");
    expect(pairingStatus.className, "the person has to act: amber").toBe("flash");
  });

  it("B3: the outbox line says why a capture is waiting when something other than the runner answered on its port", async () => {
    installFakeChrome({
      jobCaptureOutboxUsedThisSession: true,
      "jobCaptureOutbox:11111111-1111-4111-8111-111111111111": {
        capture: {
          protocol: 1,
          type: "job_capture",
          eventId: "11111111-1111-4111-8111-111111111111",
          url: "https://jobs.example/postings/1",
          text: "Backend Engineer — Quill, a fictional posting for tests.",
          extractorVersion: "extractor@0.1.0",
          contentHash: "a".repeat(64),
          occurredAt: "2026-09-22T00:00:00.000Z",
        },
        attempts: 2,
        queuedAt: "2026-09-22T00:00:01.000Z",
        lastErrorCode: "invalid_response",
      },
    });
    await import("./main");
    await vi.waitFor(() =>
      expect(statusSection().textContent).toContain(
        "1 saved job waiting to send. Something other than the runner is answering on its port; trying again.",
      ),
    );
  });

  it("the outbox line follows the queue as it changes, without a re-check", async () => {
    const fake = installFakeChrome();
    await import("./main");
    await vi.waitFor(() => expect(statusSection().textContent).toContain("Pair this browser above"));
    await settle();
    expect(statusSection().textContent).not.toContain("saved job");

    const { enqueueCapture } = await import("../shared/outbox");
    await enqueueCapture(
      {
        protocol: 1,
        type: "job_capture",
        eventId: "11111111-1111-4111-8111-111111111111",
        url: "https://jobs.example/postings/1",
        text: "Backend Engineer — Quill, a fictional posting for tests.",
        extractorVersion: "extractor@0.1.0",
        contentHash: "a".repeat(64),
        occurredAt: "2026-09-22T00:00:00.000Z",
      },
      { code: "not_paired", message: "not paired" },
    );
    for (const listener of fake.changeListeners) {
      listener({ "jobCaptureOutbox:11111111-1111-4111-8111-111111111111": { newValue: {} } }, "session");
    }
    await vi.waitFor(() => expect(statusSection().textContent).toContain("1 saved job waiting until this browser is paired."));
  });

  describe("P07-B revision 3: the Pairing line, plain Status messages, and amber problems", () => {
    const OTHER_DEVICE = { deviceId: "3f9d2c1b-7a6e-4d5c-8b4a-1e2f3a4b5c6d", token: "other-device-token", pairedAt: "2026-09-22T10:00:00.000Z" };
    const CAPTURE = {
      protocol: 1,
      type: "job_capture",
      eventId: "11111111-1111-4111-8111-111111111111",
      url: "https://jobs.example/postings/1",
      text: "Backend Engineer — Quill, a fictional posting for tests.",
      extractorVersion: "extractor@0.1.0",
      contentHash: "a".repeat(64),
      occurredAt: "2026-09-22T00:00:00.000Z",
    };

    function pairingSection(): Element {
      return document.querySelector('[data-section="pairing"]')!;
    }

    function pairingLine(): Element {
      return pairingSection().querySelector('[role="status"]')!;
    }

    function submitCode(code: string): void {
      (document.querySelector('input[type="text"]') as HTMLInputElement).value = code;
      (document.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }

    it("UI issue 1, revoked: after 'Paired.', a re-check that finds the pairing refused replaces the line with 'Your pairing expired or was revoked.' -- amber, and what the code field is described by -- instead of 'Paired.' next to 'Not paired.'", async () => {
      installFakeChrome();
      let revoked = false;
      globalThis.fetch = ((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/pair")) return Promise.resolve(jsonResponse(200, { deviceId: PAIRED.deviceId, token: PAIRED.token }));
        if (url.endsWith("/status")) return Promise.resolve(revoked ? jsonResponse(401, TOKEN_INVALID) : jsonResponse(200, STATUS_OK));
        return Promise.reject(new TypeError("Failed to fetch"));
      }) as typeof fetch;
      await import("./main");
      await vi.waitFor(() => expect(document.querySelector("form")).not.toBeNull());
      const line = pairingLine();
      submitCode("7KQ2M-X9RTB");
      await vi.waitFor(() => expect(line.textContent).toBe("Paired."));
      await vi.waitFor(() => expect(statusSection().textContent).toContain("Connected"));
      await settle();

      revoked = true;
      checkAgainButton().click();
      await vi.waitFor(() => expect(pairingSection().textContent).toContain("Not paired."), { timeout: 2000 });

      expect(pairingLine(), "still the one persistent live region").toBe(line);
      expect(line.textContent).toBe("Your pairing expired or was revoked.");
      expect(line.className, "the person has to pair again: amber").toBe("flash");
      const codeField = pairingSection().querySelector('input[type="text"]')!;
      expect(document.getElementById(codeField.getAttribute("aria-describedby")!)?.textContent).toBe("Your pairing expired or was revoked.");
      expect(pairingSection().textContent, "revision 2 kept 'Paired.' here").not.toContain("Paired.");
    });

    it("UI issue 1, paired elsewhere: after 'Un-paired.', a pairing made in another tab clears the line when a re-check shows the new device", async () => {
      installFakeChrome({ deviceToken: PAIRED });
      stubFetch(() => jsonResponse(200, STATUS_OK));
      await import("./main");
      await vi.waitFor(() => expect(statusSection().textContent).toContain("Connected"));
      ([...document.querySelectorAll("button")].find((b) => b.textContent === "Un-pair") as HTMLButtonElement).click();
      const line = pairingLine();
      await vi.waitFor(() => expect(line.textContent).toBe("Un-paired. You can pair again below."));
      await settle();

      const { recordPairing } = await import("../shared/storage");
      await recordPairing(OTHER_DEVICE);
      window.dispatchEvent(new Event("focus"));
      await vi.waitFor(() => expect(pairingSection().textContent).toContain("3f9d2c1b"));

      expect(line.textContent, "revision 2 kept 'Un-paired.' next to the new device").toBe("");
      expect(pairingSection().textContent).not.toContain("Un-paired");
    });

    it("UI issue 1, opened after a refusal elsewhere: the page starts with the line already saying so", async () => {
      installFakeChrome({ pairingExpired: true, pairedBeforeThisSession: true });
      await import("./main");
      await vi.waitFor(() => expect(document.querySelector("form")).not.toBeNull());
      expect(pairingLine().textContent).toBe("Your pairing expired or was revoked.");
      expect(pairingLine().className).toBe("flash");
      expect(pairingSection().textContent).toContain("Not paired.");
      expect(pairingSection().textContent).not.toContain("Not paired yet.");
    });

    it.each([
      ["a web page (200, text/html)", () => new Response("<!doctype html><title>Some other app</title>", { status: 200, headers: { "content-type": "text/html" } })],
      ["a 404 outside the runner's envelope", () => new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } })],
      // Not "Your pairing has expired": a 401 page that isn't the
      // runner's says nothing about this browser's token.
      ["a 401 outside the runner's envelope", () => new Response("<!doctype html><title>Sign in</title>", { status: 401, headers: { "content-type": "text/html" } })],
      ["a JSON answer that isn't the runner's status", () => jsonResponse(200, { hello: "world" })],
    ])("H2: %s on the runner's port reads as one plain sentence with a next step -- no field names, no status codes -- and keeps the pairing", async (_name, answer) => {
      installFakeChrome({ deviceToken: PAIRED });
      stubFetch(() => answer());
      await import("./main");
      await vi.waitFor(() => expect(statusSection().querySelector('[role="alert"]')).not.toBeNull());
      const alert = statusSection().querySelector('[role="alert"]')!;
      expect(alert.textContent).toBe(
        "Something other than the runner is answering on its port. Close that program, then start the runner with npm run runner.",
      );
      expect(alert.querySelector("code")?.textContent).toBe("npm run runner");
      expect(alert.textContent).not.toMatch(/HTTP|shape|\b[1-5]\d\d\b|invalid_response|unknown_error/);
      expect(alert.className).toBe("flash");
      expect(pairingSection().textContent, "not the runner refusing the token").toContain("8b0c6f0e");
    });

    it("H2: pairing while another program answers on the runner's port says so in the Pairing line -- the same sentence as Status, not the code's fault", async () => {
      installFakeChrome();
      stubFetch(() => new Response("<!doctype html><title>Some other app</title>", { status: 200, headers: { "content-type": "text/html" } }));
      await import("./main");
      await vi.waitFor(() => expect(document.querySelector("form")).not.toBeNull());
      submitCode("7KQ2M-X9RTB");
      await vi.waitFor(() =>
        expect(pairingLine().textContent).toBe(
          "Something other than the runner is answering on its port. Close that program, then start the runner with npm run runner.",
        ),
      );
      expect(pairingLine().querySelector("code")?.textContent).toBe("npm run runner");
      expect(pairingLine().className).toBe("flash");
      expect(document.querySelector('input[type="text"]')?.getAttribute("aria-invalid"), "the code wasn't the problem").toBeNull();
    });

    it("H2: a status check that two re-pairings overtake says to check again -- not bridge-client's words about a capture being sent", async () => {
      installFakeChrome({ deviceToken: { ...PAIRED, token: "token-one" } });
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const auth = (init?.headers as Record<string, string>).authorization;
        if (auth === "Bearer token-one") await chrome.storage.session.set({ deviceToken: { ...OTHER_DEVICE, token: "token-two" } });
        if (auth === "Bearer token-two") {
          await chrome.storage.session.set({ deviceToken: { ...OTHER_DEVICE, deviceId: "0d2e8b20-4b3c-4e77-9f50-2c3d4e5f6071", token: "token-three" } });
        }
        return jsonResponse(401, TOKEN_INVALID);
      }) as typeof fetch;
      await import("./main");
      await vi.waitFor(() =>
        expect(statusSection().querySelector('[role="alert"]')?.textContent).toBe("This browser was just paired again. Check again in a moment."),
      );
      expect(statusSection().textContent).not.toContain("sent again");
    });

    it("H2: a real 5xx from the runner says it had a problem, with a next step", async () => {
      installFakeChrome({ deviceToken: PAIRED });
      stubFetch(() => jsonResponse(500, { ok: false, error: { code: "internal_error", message: "The runner hit an unexpected error." } }));
      await import("./main");
      await vi.waitFor(() => expect(statusSection().querySelector('[role="alert"]')).not.toBeNull());
      const alert = statusSection().querySelector('[role="alert"]')!;
      expect(alert.textContent).toBe("The runner had a problem. Check again in a moment, or restart it with npm run runner.");
      expect(alert.querySelector("code")?.textContent).toBe("npm run runner");
      expect(alert.textContent).not.toMatch(/HTTP|\b[1-5]\d\d\b/);
    });

    it.each([
      ["runner down", () => Promise.reject(new TypeError("Failed to fetch"))],
      ["401", () => Promise.resolve(jsonResponse(401, TOKEN_INVALID))],
      [
        "403",
        () =>
          Promise.resolve(
            jsonResponse(403, { ok: false, error: { code: "origin_not_allowed", message: "This request's Origin is not the extension origin this device paired from." } }),
          ),
      ],
    ])("H1: every Status problem waits on the person, so it is amber .flash, never red (%s)", async (_name, answer) => {
      installFakeChrome({ deviceToken: PAIRED });
      globalThis.fetch = (() => answer()) as typeof fetch;
      await import("./main");
      await vi.waitFor(() => expect(statusSection().querySelector('[role="alert"]')).not.toBeNull());
      expect(statusSection().querySelector('[role="alert"]')!.className).toBe("flash");
    });

    it("the outbox line: a pause that still holds on a browser that was paired says 'paired again'", async () => {
      installFakeChrome({
        deviceToken: PAIRED,
        pairingOriginMismatch: true,
        jobCaptureOutboxUsedThisSession: true,
        [`jobCaptureOutbox:${CAPTURE.eventId}`]: {
          capture: CAPTURE,
          attempts: 1,
          queuedAt: "2026-09-22T00:00:01.000Z",
          pausedReason: "origin_not_allowed",
          pausedFor: PAIRED.deviceId,
          lastErrorCode: "origin_not_allowed",
        },
      });
      await import("./main");
      await vi.waitFor(() => expect(statusSection().textContent).toContain("1 saved job waiting until this browser is paired again."));
    });

    it("the outbox line: a pause left from an older pairing no longer holds, so the capture counts as waiting to send", async () => {
      installFakeChrome({
        deviceToken: PAIRED,
        jobCaptureOutboxUsedThisSession: true,
        [`jobCaptureOutbox:${CAPTURE.eventId}`]: {
          capture: CAPTURE,
          attempts: 1,
          queuedAt: "2026-09-22T00:00:01.000Z",
          pausedReason: "token_invalid",
          pausedFor: OTHER_DEVICE.deviceId,
          lastErrorCode: "token_invalid",
        },
      });
      stubFetch(() => jsonResponse(200, STATUS_OK));
      await import("./main");
      await vi.waitFor(() => expect(statusSection().textContent).toContain("1 saved job waiting to send."));
      expect(statusSection().textContent).not.toContain("until this browser is paired");
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
