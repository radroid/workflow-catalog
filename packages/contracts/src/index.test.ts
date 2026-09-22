import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, protocolVersionSchema } from "./index";

describe("PROTOCOL_VERSION", () => {
  it("is 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("is accepted by protocolVersionSchema", () => {
    expect(protocolVersionSchema.parse(1)).toBe(1);
  });

  it("rejects any other value", () => {
    expect(() => protocolVersionSchema.parse(2)).toThrow();
  });
});
