import "../shared/zod-jitless";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { command, installFakeChrome, TASKS, type FakeChrome } from "../session/fake-chrome";

/**
 * P07 part C, in Settings: the carried Pairing items (the expired notice
 * follows `pairingExpired` on every sync; a half-typed code survives a
 * rebuild) and the file bridge for sessions (import into the side panel,
 * export completion events). Same dynamic-import pattern as main.test.ts:
 * options/main.ts renders as soon as it is imported. The chrome stand-in is
 * session/fake-chrome.ts, which has the `storage.local` sessions live in.
 */

const PAIRED = { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "device-token", pairedAt: "2026-09-25T09:00:00.000Z" };
const NOTICE = "Your pairing expired or was revoked.";

let fake: FakeChrome;
let originalFetch: typeof fetch;

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

function pairingSection(): Element {
  return document.querySelector('[data-section="pairing"]')!;
}

function pairingNotice(): Element {
  return pairingSection().querySelector("[data-notice]")!;
}

function pairingLine(): Element {
  return pairingSection().querySelector('[role="status"]')!;
}

function codeField(): HTMLInputElement {
  return pairingSection().querySelector('input[type="text"]') as HTMLInputElement;
}

/** What another tab (the popup, a second Settings page) does to storage, then this page's re-check on focus. */
async function elsewhere(change: (storage: typeof import("../shared/storage")) => Promise<void>): Promise<void> {
  await change(await import("../shared/storage"));
  window.dispatchEvent(new Event("focus"));
  await settle();
}

async function openSettings(seed: Record<string, unknown> = {}): Promise<void> {
  fake = installFakeChrome();
  await chrome.storage.session.set(seed);
  await import("./main");
  await vi.waitFor(() => expect(document.querySelector('[data-section="pairing"]')).not.toBeNull());
  await settle();
}

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  originalFetch = globalThis.fetch;
  // The runner isn't running: every status check fails the same way, so only storage moves the card.
  globalThis.fetch = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
});

afterEach(async () => {
  await settle();
  document.body.innerHTML = "";
  globalThis.fetch = originalFetch;
});

describe("carried into part C: the Pairing card's expired notice is re-derived from pairingExpired on every sync, silently", () => {
  it("a card that never showed the paired state (opened after an Un-pair) shows the notice once a pairing made elsewhere is refused -- without rebuilding the card", async () => {
    await openSettings({ pairedBeforeThisSession: true });
    const card = pairingSection();
    expect(card.textContent).toContain("Not paired.");
    expect(pairingNotice().textContent).toBe("");

    await elsewhere(async ({ recordPairing, forgetInvalidToken }) => {
      await recordPairing(PAIRED);
      await forgetInvalidToken(PAIRED.token);
    });
    expect(pairingNotice().textContent).toBe(NOTICE);
    expect(pairingNotice().className, "amber: the person has to pair again").toBe("flash");
    expect(pairingSection(), "the same card: nothing was rebuilt").toBe(card);
    expect(pairingLine().textContent, "set silently, not in the live line").toBe("");
  });

  it("a never-paired card shows it too (its label moves to npm run pair)", async () => {
    await openSettings();
    expect(pairingSection().textContent).toContain("Not paired yet.");
    await elsewhere(async ({ recordPairing, forgetInvalidToken }) => {
      await recordPairing(PAIRED);
      await forgetInvalidToken(PAIRED.token);
    });
    expect(pairingNotice().textContent).toBe(NOTICE);
    expect(pairingSection().textContent).toContain("Not paired.");
    expect(pairingSection().querySelector("label code")?.textContent).toBe("npm run pair");
  });

  it("the notice doesn't outlive a pair and un-pair made in another tab", async () => {
    await openSettings({ pairingExpired: true, pairedBeforeThisSession: true });
    expect(pairingNotice().textContent).toBe(NOTICE);
    const card = pairingSection();

    await elsewhere(async ({ recordPairing, forgetPairing }) => {
      await recordPairing(PAIRED);
      await forgetPairing();
    });
    expect(pairingNotice().textContent).toBe("");
    expect(pairingLine().textContent).toBe("");
    expect(pairingSection().textContent).toContain("Not paired.");
    expect(pairingSection(), "the same card").toBe(card);
  });
});

describe("carried into part C: a half-typed code survives a rebuild", () => {
  it("when focus was in the code field, the rebuilt card's field has the same text, the caret at its end, and focus", async () => {
    await openSettings();
    const field = codeField();
    field.focus();
    field.value = "7KQ2M-X9";
    await elsewhere(async ({ recordPairing, forgetInvalidToken }) => {
      await recordPairing(PAIRED);
      await forgetInvalidToken(PAIRED.token);
    });
    const rebuilt = codeField();
    expect(rebuilt, "the card was rebuilt (its label changed)").not.toBe(field);
    expect(rebuilt.value).toBe("7KQ2M-X9");
    expect(rebuilt.selectionStart).toBe(8);
    expect(document.activeElement).toBe(rebuilt);
  });

  it("text in a field that didn't have focus isn't carried (only what the person is typing now)", async () => {
    await openSettings();
    codeField().value = "7KQ2M-X9";
    (document.activeElement as HTMLElement | null)?.blur();
    await elsewhere(async ({ recordPairing, forgetInvalidToken }) => {
      await recordPairing(PAIRED);
      await forgetInvalidToken(PAIRED.token);
    });
    expect(codeField().value).toBe("");
  });
});

function importFile(text: string, name = "application-session.json"): void {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [new File([text], name, { type: "application/json" })], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

const EXAMPLE = readFileSync(join(__dirname, "../../fixtures/application-session.example.json"), "utf8");

describe("the file bridge for sessions: import application-session.json into the side panel", () => {
  it("stores the imported session as waiting, says nothing opens until Start applying, and opens no tab", async () => {
    await openSettings();
    importFile(EXAMPLE);
    await vi.waitFor(() => expect(document.querySelector("[data-import-outcome]")).not.toBeNull());
    expect(document.querySelector("[data-import-outcome]")?.textContent).toBe(
      "Added to the side panel, ready to open. Nothing opens until you choose Start applying there.",
    );
    const { listSessions } = await import("../session/store");
    const [session] = await listSessions();
    expect(session).toMatchObject({ sessionId: "5b6f1c2e-8d4a-4f3b-9c1d-2e3f4a5b6c7d", source: "file", phase: "waiting" });
    expect(fake.calls).toEqual({ create: 0, group: 0, nameGroup: 0 });
    expect(document.body.textContent, "part A's placeholder is gone").not.toContain("Read-only preview");
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Open the side panel")).toBe(true);
  });

  it("importing the same session again (or an older copy) changes nothing", async () => {
    await openSettings();
    importFile(EXAMPLE);
    await vi.waitFor(() => expect(document.querySelector("[data-import-outcome]")).not.toBeNull());
    const { listSessions } = await import("../session/store");
    const before = await listSessions();
    importFile(EXAMPLE.replace("Apply today: Quill and Fernwood (fictional)", "An older copy"));
    await vi.waitFor(() => expect(document.querySelector("[data-import-outcome]")?.textContent).toBe("This session is already in the side panel, so nothing changed."));
    expect(await listSessions()).toEqual(before);
  });

  it("marks an address it won't open, and refuses a file with none it can", async () => {
    await openSettings();
    const unsafe = JSON.parse(EXAMPLE) as { items: Array<{ url: string }> };
    unsafe.items[1]!.url = "http://169.254.169.254/latest/meta-data";
    importFile(JSON.stringify(unsafe));
    await vi.waitFor(() => expect(document.querySelector("[data-import-outcome]")).not.toBeNull());
    expect(document.querySelector('[data-section="fileBridge"]')?.textContent).toContain("Its address isn't a secure (https) web address, so it won't be opened.");
    expect(document.querySelector("[data-import-outcome]")?.textContent).toContain("ready to open");

    unsafe.items[0]!.url = "https://localhost/postings/quill";
    importFile(JSON.stringify({ ...unsafe, sessionId: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a" }));
    await vi.waitFor(() =>
      expect(document.querySelector("[data-import-outcome]")?.textContent).toBe(
        "Added to the side panel, but it won't be opened. None of its addresses can be opened safely, so nothing was opened.",
      ),
    );
    expect(fake.calls.create).toBe(0);
  });
});

describe("the file bridge for sessions: export completion events", () => {
  it("adds nothing to File bridge while there is nothing to export (its one button is still Export last capture)", async () => {
    await openSettings();
    const block = document.querySelector("[data-completion-export]") as HTMLElement;
    expect(block.hidden).toBe(true);
    expect(block.childElementCount).toBe(0);
    expect([...document.querySelectorAll('[data-section="fileBridge"] button')].map((button) => button.textContent)).toEqual(["No capture saved yet"]);
  });

  it("exports every event this browser made for a runner's session, in order, as completion-events.json { events }, leaving refused ones out", async () => {
    const downloads: Array<{ name: string; data: unknown }> = [];
    vi.doMock("../shared/download", () => ({ downloadJson: (name: string, data: unknown) => downloads.push({ name, data }) }));
    fake = installFakeChrome();
    const report = { protocol: 1, type: "browser_command_result", eventId: "f1111111-1111-4111-8111-111111111111", commandId: command().commandId, status: "completed", items: [{ taskId: TASKS[0], status: "opened" }], occurredAt: "2026-09-25T09:00:00.000Z" };
    const choice = { protocol: 1, type: "application_status_changed", eventId: "f2222222-2222-4222-8222-222222222222", taskId: TASKS[0], expectedRevision: 1, status: "applied", occurredAt: "2026-09-25T09:05:00.000Z" };
    const stale = { ...choice, eventId: "f3333333-3333-4333-8333-333333333333", status: "deferred" };
    await chrome.storage.local.set({
      [`wcSession:${command().sessionId}`]: {
        sessionId: command().sessionId,
        title: "Apply today",
        source: "bridge",
        commandId: command().commandId,
        receivedAt: "2026-09-25T08:59:00.000Z",
        phase: "open",
        items: [{ taskId: TASKS[0], jobRevision: 1, url: "https://jobs.example/postings/fictional-1" }],
        events: [
          { event: report, state: "pending", at: "2026-09-25T09:00:00.000Z" },
          { event: stale, state: "refused", at: "2026-09-25T09:01:00.000Z", code: "stale_revision" },
          { event: choice, state: "pending", at: "2026-09-25T09:05:00.000Z" },
        ],
      },
    });
    await import("./main");
    await vi.waitFor(() => expect((document.querySelector("[data-completion-export]") as HTMLElement | null)?.hidden).toBe(false));
    expect(document.querySelector("[data-completion-export]")?.textContent).toContain("2 session updates");
    ([...document.querySelectorAll("button")].find((button) => button.textContent === "Export session updates") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0]).toEqual({ name: "completion-events.json", data: { events: [report, choice] } });
    expect(document.querySelector('[data-section="fileBridge"]')?.textContent).toContain("Put it in your workspace's inbox/ folder");
    vi.doUnmock("../shared/download");
  });

  it("says a choice on a session from a file stays in this browser, to mark on the Board", async () => {
    await openSettings();
    importFile(EXAMPLE);
    await vi.waitFor(() => expect(document.querySelector("[data-import-outcome]")).not.toBeNull());
    const { mutateSession, withItem } = await import("../session/store");
    await mutateSession("5b6f1c2e-8d4a-4f3b-9c1d-2e3f4a5b6c7d", (session) => ({
      session: withItem(session!, TASKS[0], (item) => ({ ...item, choice: { status: "applied", at: "2026-09-25T09:00:00.000Z", outcome: "local" } })),
    }));
    await vi.waitFor(() => expect((document.querySelector("[data-completion-export]") as HTMLElement).hidden).toBe(false));
    expect(document.querySelector("[data-completion-export]")?.textContent).toContain("1 choice on sessions from a file is kept in this browser only. Mark it on the runner's Board.");
  });
});
