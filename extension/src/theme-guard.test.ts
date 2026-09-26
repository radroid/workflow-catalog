// @vitest-environment node
/**
 * P07-B revision 3, nit 6: the acceptance-screenshot guard's refusal paths,
 * adopted from the round-3 reviewer's theme-guard probe. It drives the real
 * `captureInTheme` and `findDevToolsLabelTopRight` (e2e/theme-capture.ts)
 * with a scripted ThemeTarget and synthetic PNGs -- no browser, no ports --
 * and `writeFileSync` mocked, so nothing is ever written: the guard must
 * refuse a wrong-theme or overlaid image outright, keep its two retry
 * budgets (MAX_SCHEME_REPAIRS, MAX_LABEL_WAITS) apart, and write only a
 * clean capture.
 *
 * It lives under src/ because vitest.config.ts excludes e2e/**.
 */
import { writeFileSync } from "node:fs";
import zlib from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureInTheme, findDevToolsLabelTopRight, type Theme, type ThemeTarget } from "../e2e/theme-capture";

vi.mock("node:fs", async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return { ...actual, writeFileSync: vi.fn() };
});

const written = vi.mocked(writeFileSync);

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typeAndData) >>> 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** An 8-bit RGB PNG, filter 0 on every row; `pixel(x, y)` gives [r, g, b]. */
function makePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset++] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const LIGHT_PAGE = makePng(380, 404, () => [255, 255, 255]);
const DARK_PAGE = makePng(380, 404, () => [10, 10, 10]);
/** CI run 35758037837's bad frame, reconstructed: a dark page with the
 * DevTools size label's grey box from x = 159 of a 319 px wide frame. */
const CI_LIKE_OVERLAID_DARK = makePng(319, 404, (x, y) => (x >= 159 && y < 20 ? [86, 86, 86] : [0, 0, 0]));
/** The label on an otherwise correct light page. */
const OVERLAID_LIGHT = makePng(380, 378, (x, y) => (x >= 300 && y < 18 ? [86, 86, 86] : [255, 255, 255]));

interface Script {
  /** Returned in order; the last one repeats. */
  readonly captures: readonly Buffer[];
  /** matchMedia's answer right after each capture -- `false` plays the
   * real popup's quirk of dropping the colour-scheme override. */
  readonly matchMediaAfterCapture?: boolean;
}

/** A page that answers every check `inTheme` makes for `theme`, and hands
 * out `script.captures` as its screenshots. */
function scriptedTarget(theme: Theme, script: Script): { target: ThemeTarget; captureCount: () => number } {
  let matchMediaAgrees = true;
  let captures = 0;
  const background = theme === "dark" ? "rgb(10, 10, 10)" : "rgb(255, 255, 255)";
  const target: ThemeTarget = {
    label: "scripted-popup",
    setColorScheme: async () => {
      matchMediaAgrees = true;
    },
    evaluate: async <T>(expression: string): Promise<T> => {
      if (expression.startsWith("matchMedia(")) return matchMediaAgrees as T;
      if (expression.includes("declaredBackground")) {
        return { dataTheme: theme, declaredBackground: background, expectedBackground: background, bodyBackground: background } as T;
      }
      return true as T; // document.fonts.ready
    },
    capture: async () => {
      const png = script.captures[Math.min(captures, script.captures.length - 1)];
      if (!png) throw new Error("the script has no captures");
      captures += 1;
      if (script.matchMediaAfterCapture !== undefined) matchMediaAgrees = script.matchMediaAfterCapture;
      return png;
    },
  };
  return { target, captureCount: () => captures };
}

const toOutput = (fileName: string) => `/never-written/${fileName}`;

beforeEach(() => {
  written.mockClear();
});

describe("captureInTheme refuses a bad image and writes only a clean one (P07-B revision 3, nit 6)", () => {
  it("control: a clean dark capture is taken once and written", async () => {
    const { target, captureCount } = scriptedTarget("dark", { captures: [DARK_PAGE] });
    await captureInTheme(target, "dark", "clean-dark.png", toOutput);
    expect(captureCount()).toBe(1);
    expect(written).toHaveBeenCalledTimes(1);
    expect(written).toHaveBeenCalledWith("/never-written/clean-dark.png", DARK_PAGE);
  });

  it("a light image for a dark capture while matchMedia agrees fails at once -- no retry spent -- and nothing is written", async () => {
    const { target, captureCount } = scriptedTarget("dark", { captures: [LIGHT_PAGE] });
    await expect(captureInTheme(target, "dark", "wrong-theme.png", toOutput)).rejects.toThrow(/matchMedia already agrees/);
    expect(captureCount()).toBe(1);
    expect(written).not.toHaveBeenCalled();
  });

  it("a dark image for a light capture while matchMedia agrees fails the same way", async () => {
    const { target, captureCount } = scriptedTarget("light", { captures: [DARK_PAGE] });
    await expect(captureInTheme(target, "light", "wrong-theme.png", toOutput)).rejects.toThrow(/matchMedia already agrees/);
    expect(captureCount()).toBe(1);
    expect(written).not.toHaveBeenCalled();
  });

  it("a wrong theme that persists while matchMedia keeps dropping fails after exactly 3 re-forced overrides, and nothing is written", async () => {
    const { target, captureCount } = scriptedTarget("dark", { captures: [LIGHT_PAGE], matchMediaAfterCapture: false });
    await expect(captureInTheme(target, "dark", "wrong-theme.png", toOutput)).rejects.toThrow(
      /matchMedia still disagreed after 3 re-forced overrides/,
    );
    expect(captureCount(), "1 + MAX_SCHEME_REPAIRS").toBe(4);
    expect(written).not.toHaveBeenCalled();
  });

  it("CI's overlaid dark frame is flagged, and a label that stays fails after 3 waits, with nothing written", async () => {
    expect(findDevToolsLabelTopRight(CI_LIKE_OVERLAID_DARK)).toMatch(/pixel \(159, 0\).*319x404.*rgb\(86, 86, 86\).*rgb\(0, 0, 0\)/);
    expect(findDevToolsLabelTopRight(DARK_PAGE), "a clean frame has no label").toBeUndefined();
    const { target, captureCount } = scriptedTarget("dark", { captures: [CI_LIKE_OVERLAID_DARK] });
    await expect(captureInTheme(target, "dark", "overlaid.png", toOutput)).rejects.toThrow(/still there after 3 waits/);
    expect(captureCount(), "1 + MAX_LABEL_WAITS").toBe(4);
    expect(written).not.toHaveBeenCalled();
  });

  it("a label on a light page fails the same way", async () => {
    const { target } = scriptedTarget("light", { captures: [OVERLAID_LIGHT] });
    await expect(captureInTheme(target, "light", "overlaid.png", toOutput)).rejects.toThrow(/still there after 3 waits/);
    expect(written).not.toHaveBeenCalled();
  });

  it("the two budgets never combine into a pass: 3 scheme repairs, then 3 label waits, then the label again still fails", async () => {
    const { target, captureCount } = scriptedTarget("dark", {
      captures: [LIGHT_PAGE, LIGHT_PAGE, LIGHT_PAGE, CI_LIKE_OVERLAID_DARK],
      matchMediaAfterCapture: false,
    });
    await expect(captureInTheme(target, "dark", "mixed.png", toOutput)).rejects.toThrow(/still there after 3 waits/);
    expect(captureCount()).toBe(7);
    expect(written).not.toHaveBeenCalled();
  });

  it("a label that clears on the next capture is waited out, and the file written is the clean capture", async () => {
    const { target, captureCount } = scriptedTarget("dark", { captures: [CI_LIKE_OVERLAID_DARK, DARK_PAGE] });
    await captureInTheme(target, "dark", "recovered.png", toOutput);
    expect(captureCount()).toBe(2);
    expect(written).toHaveBeenCalledTimes(1);
    expect(written).toHaveBeenCalledWith("/never-written/recovered.png", DARK_PAGE);
  });
});
