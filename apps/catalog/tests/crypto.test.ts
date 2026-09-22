import { describe, expect, it } from "vitest";
import { hmacSign, hmacVerify, randomToken, sha256Hex, timingSafeEqualString } from "../lib/crypto";

describe("crypto", () => {
  it("randomToken produces distinct, base64url values with >=128 bits of entropy", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toEqual(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    // 20 bytes (160 bits) base64url-encoded, no padding, is 27 chars.
    expect(a.length).toBe(27);
  });

  it("sha256Hex is deterministic and matches a known vector", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hmacVerify accepts a signature produced by hmacSign with the same secret", async () => {
    const signature = await hmacSign("secret-key", "hello");
    expect(await hmacVerify("secret-key", "hello", signature)).toBe(true);
  });

  it("hmacVerify rejects a tampered message, a tampered signature, or the wrong secret", async () => {
    const signature = await hmacSign("secret-key", "hello");
    expect(await hmacVerify("secret-key", "goodbye", signature)).toBe(false);
    expect(await hmacVerify("wrong-secret", "hello", signature)).toBe(false);
    expect(await hmacVerify("secret-key", "hello", signature.slice(0, -1) + (signature.endsWith("A") ? "B" : "A"))).toBe(
      false,
    );
  });

  it("hmacVerify fails closed on garbage input instead of throwing", async () => {
    await expect(hmacVerify("secret-key", "hello", "not-valid-base64url!!!")).resolves.toBe(false);
  });

  it("timingSafeEqualString is a true equality check regardless of length differences", () => {
    expect(timingSafeEqualString("same-value", "same-value")).toBe(true);
    expect(timingSafeEqualString("same-value", "different-value")).toBe(false);
    expect(timingSafeEqualString("short", "much-longer-value")).toBe(false);
    expect(timingSafeEqualString("", "")).toBe(true);
  });
});
