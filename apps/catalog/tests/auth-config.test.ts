import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthConfigError, getOwnerSecret, getSessionSecret } from "../lib/auth-config";

describe("auth config — fail closed", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("getOwnerSecret returns the configured value", () => {
    vi.stubEnv("OWNER_SECRET", "the-owner-secret");
    expect(getOwnerSecret()).toBe("the-owner-secret");
  });

  it("getOwnerSecret throws AuthConfigError when unset", () => {
    vi.stubEnv("OWNER_SECRET", "");
    expect(() => getOwnerSecret()).toThrow(AuthConfigError);
  });

  it("getSessionSecret returns the configured value", () => {
    vi.stubEnv("SESSION_SECRET", "the-session-secret");
    expect(getSessionSecret()).toBe("the-session-secret");
  });

  it("getSessionSecret throws AuthConfigError when unset", () => {
    vi.stubEnv("SESSION_SECRET", "");
    expect(() => getSessionSecret()).toThrow(AuthConfigError);
  });
});
