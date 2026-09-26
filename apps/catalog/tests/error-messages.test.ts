import { describe, expect, it } from "vitest";
import { GENERIC_ERROR_MESSAGE, adminErrorMessage, inviteErrorMessage } from "../lib/error-messages";

// Regression coverage for the P09-A round-2 reviewer note: `?error=__proto__`
// used to resolve to `Object.prototype` itself (every plain object inherits
// it), which is truthy, so the old `?? GENERIC_ERROR_MESSAGE` fallback never
// kicked in — React then threw trying to render an object/function as a
// child, crashing an otherwise-public page. `__proto__`, `constructor`, and
// `toString` are exactly the three inherited-from-Object.prototype names the
// review called out; none of them is ever a real CODE these maps were built
// with.
const PROTOTYPE_POLLUTION_CODES = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"];

describe("adminErrorMessage", () => {
  it("maps a known code to its fixed, server-authored message", () => {
    expect(adminErrorMessage("wrong_secret")).toBe("Incorrect secret.");
    expect(adminErrorMessage("not_owner")).toBe("Sign in as the owner first.");
  });

  it("returns null when there is no code at all", () => {
    expect(adminErrorMessage(undefined)).toBeNull();
  });

  it("falls back to the generic message for an unrecognized code", () => {
    expect(adminErrorMessage("totally-made-up")).toBe(GENERIC_ERROR_MESSAGE);
  });

  it.each(PROTOTYPE_POLLUTION_CODES)("treats the inherited property %s as unrecognized, not a message", (code) => {
    expect(adminErrorMessage(code)).toBe(GENERIC_ERROR_MESSAGE);
  });
});

describe("inviteErrorMessage", () => {
  it("maps a known code to its fixed, server-authored message", () => {
    expect(inviteErrorMessage("invalid_display_name")).toMatch(/Display name must be/);
  });

  it("returns null when there is no code at all", () => {
    expect(inviteErrorMessage(undefined)).toBeNull();
  });

  it("falls back to the generic message for an unrecognized code", () => {
    expect(inviteErrorMessage("totally-made-up")).toBe(GENERIC_ERROR_MESSAGE);
  });

  it.each(PROTOTYPE_POLLUTION_CODES)("treats the inherited property %s as unrecognized, not a message", (code) => {
    expect(inviteErrorMessage(code)).toBe(GENERIC_ERROR_MESSAGE);
  });
});
