import { describe, expect, it } from "vitest";
import { validateDisplayName } from "../lib/display-name";

describe("validateDisplayName", () => {
  it("accepts a normal name and trims it", () => {
    const result = validateDisplayName("  Ada Quill  ");
    expect(result).toEqual({ ok: true, value: "Ada Quill" });
  });

  it("accepts exactly 1 and exactly 40 characters", () => {
    expect(validateDisplayName("A")).toEqual({ ok: true, value: "A" });
    const forty = "A".repeat(40);
    expect(validateDisplayName(forty)).toEqual({ ok: true, value: forty });
  });

  it("rejects empty (including whitespace-only) names", () => {
    expect(validateDisplayName("").ok).toBe(false);
    expect(validateDisplayName("   ").ok).toBe(false);
  });

  it("rejects names over 40 characters", () => {
    expect(validateDisplayName("A".repeat(41)).ok).toBe(false);
  });

  it("rejects control characters", () => {
    expect(validateDisplayName(`Ada${String.fromCharCode(0)}Quill`).ok).toBe(false);
    expect(validateDisplayName(`Ada${String.fromCharCode(7)}Quill`).ok).toBe(false);
    expect(validateDisplayName(`Ada${String.fromCharCode(127)}Quill`).ok).toBe(false);
  });

  it("allows ordinary punctuation", () => {
    expect(validateDisplayName("Sam Fernwood-Harbor Jr.").ok).toBe(true);
  });

  it("rejects bidi control characters", () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE could make "Ada" render reversed, or
    // disguise what's actually stored — see lib/display-name.ts's comment.
    expect(validateDisplayName("Ada‮Quill").ok).toBe(false);
    expect(validateDisplayName("⁦Ada Quill⁩").ok).toBe(false); // LRI ... PDI
    expect(validateDisplayName("Ada‎Quill").ok).toBe(false); // LRM
  });

  it("rejects other Unicode format characters (e.g. zero-width joiner)", () => {
    expect(validateDisplayName("Ada‍Quill").ok).toBe(false); // ZWJ
    expect(validateDisplayName("Ada‌Quill").ok).toBe(false); // ZWNJ
    expect(validateDisplayName("Ada﻿Quill").ok).toBe(false); // BOM / ZWNBSP
  });
});
