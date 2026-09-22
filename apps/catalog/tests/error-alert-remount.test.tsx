// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorAlert } from "../components/error-alert";

// P09-B revision round (reviewer issue 1): tests/error-alert.test.ts reads
// source as text — it can prove the JSX has the right shape, but not that
// focus actually moves anywhere. This file renders ErrorAlert into a real
// DOM (via happy-dom, this repo's only DOM-environment test file) and
// asserts on document.activeElement, which is what a source pattern match
// structurally cannot do. The bug this proves the fix for: a second,
// identical refusal (e.g. the wrong secret twice in a row) redirects to
// the exact same `?error=CODE` URL unless a fresh nonce is appended (see
// lib/actions/owner.ts / lib/actions/invite.ts), so without `key={nonce}`
// on the call site, React reconciles the existing element in place instead
// of remounting it — the mount-only focus effect never re-fires, and the
// unchanged text is never re-announced to assistive tech either.
describe("ErrorAlert remounts and re-focuses on every refusal, including two identical ones in a row", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("focuses the alert on first mount, and again on a second mount with the same message but a new key", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root.render(<ErrorAlert key="attempt-1" id="admin-error" message="Wrong secret." />);
    });

    const firstAlert = container.querySelector("#admin-error");
    expect(firstAlert).not.toBeNull();
    expect(document.activeElement).toBe(firstAlert);

    // Simulate what happens between two real refusals: focus does not stay
    // put on its own (the browser processes a fresh response). Blurring
    // here first is what makes the assertion below meaningful — without
    // it, an element that was merely reconciled in place (never actually
    // unmounted) would still coincidentally read as focused, and the test
    // would pass for the wrong reason.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).not.toBe(firstAlert);

    // Same message, different key — exactly what a fresh nonce produces
    // for a second, identical "wrong secret" refusal in a row.
    act(() => {
      root.render(<ErrorAlert key="attempt-2" id="admin-error" message="Wrong secret." />);
    });

    const secondAlert = container.querySelector("#admin-error");
    expect(secondAlert).not.toBeNull();
    expect(document.activeElement).toBe(secondAlert);
  });

  it("does NOT refocus when the key is unchanged — isolating that the key, not some other effect of re-rendering, is what causes the remount", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root.render(<ErrorAlert key="same" id="admin-error" message="Wrong secret." />);
    });
    const firstAlert = container.querySelector("#admin-error");
    expect(document.activeElement).toBe(firstAlert);

    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).not.toBe(firstAlert);

    // Unchanged key this time: React reconciles the existing element
    // instead of remounting it, so the mount-only effect does not re-run
    // and focus stays wherever it was blurred to (<body>). This control
    // case is what proves the first test's remount is really coming from
    // the key change specifically, not from calling root.render again.
    act(() => {
      root.render(<ErrorAlert key="same" id="admin-error" message="Wrong secret." />);
    });

    expect(document.activeElement).not.toBe(container.querySelector("#admin-error"));
    expect(document.activeElement).toBe(document.body);
  });
});
