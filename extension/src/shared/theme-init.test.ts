import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyColorScheme } from "./theme-init";

class FakeMediaQueryList {
  matches: boolean;
  private listeners: Array<() => void> = [];

  constructor(matches: boolean) {
    this.matches = matches;
  }

  addEventListener(_type: "change", listener: () => void): void {
    this.listeners.push(listener);
  }

  removeEventListener(_type: "change", listener: () => void): void {
    this.listeners = this.listeners.filter((entry) => entry !== listener);
  }

  setMatches(matches: boolean): void {
    this.matches = matches;
    for (const listener of this.listeners) listener();
  }
}

let fakeMedia: FakeMediaQueryList;
let originalMatchMedia: typeof window.matchMedia;

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
  originalMatchMedia = window.matchMedia;
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  document.documentElement.removeAttribute("data-theme");
});

function stubMatchMedia(initialMatches: boolean): FakeMediaQueryList {
  fakeMedia = new FakeMediaQueryList(initialMatches);
  // @ts-expect-error -- test stub, only implements what theme-init.ts uses
  window.matchMedia = (query: string) => {
    expect(query).toBe("(prefers-color-scheme: dark)");
    return fakeMedia;
  };
  return fakeMedia;
}

describe("applyColorScheme", () => {
  it("sets data-theme=dark when the OS prefers dark", () => {
    stubMatchMedia(true);
    applyColorScheme();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("sets data-theme=light when the OS prefers light", () => {
    stubMatchMedia(false);
    applyColorScheme();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("updates live when the OS preference changes", () => {
    const media = stubMatchMedia(false);
    applyColorScheme();
    expect(document.documentElement.dataset.theme).toBe("light");

    media.setMatches(true);
    expect(document.documentElement.dataset.theme).toBe("dark");

    media.setMatches(false);
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
