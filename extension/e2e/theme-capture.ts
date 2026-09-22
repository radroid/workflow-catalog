/**
 * Shared light/dark theme-switching and acceptance-screenshot capture for
 * a real popup (raw CDP) or a real Playwright page (options/sidepanel) --
 * moved out of real-popup.spec.ts (where it was built and hardened against
 * two real, observed browser races, see `ensureColorScheme`/`verifyTheme`
 * below) so bridge-e2e.spec.ts's own P07B acceptance screenshots can reuse
 * it instead of re-deriving the same "AFTER_RESIZE_QUIET wait" / "matchMedia
 * can drop or lag" / "DevTools' viewport-size label can leak into a
 * capture" handling a second time.
 *
 * `captureInTheme` takes a `resolvePath` callback rather than deciding
 * where to write a screenshot itself: each packet's own committed-vs-
 * gitignored-output choice (its own `P0xY_UPDATE_SCREENSHOTS` env var, its
 * own `docs/screenshots/` filenames) stays in that packet's own spec file,
 * not baked in here.
 */
import { writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { expect } from "./fixtures";
import type { RawCdpSession } from "./real-popup-cdp";

export type Theme = "light" | "dark";

/** A page a test switches between colour schemes and captures: a real
 * popup (raw CDP session) or a normal Playwright page (options/sidepanel). */
export interface ThemeTarget {
  readonly label: string;
  setColorScheme(theme: Theme): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
  capture(): Promise<Buffer>;
}

const TWO_FRAMES = "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))";

/** Starts recording the time of the page's last `resize` event (once per
 * document; later calls are no-ops). A theme switch fires resize events. */
const RECORD_RESIZES = `(() => {
  if (window.__wcLastResizeAt === undefined) {
    window.__wcLastResizeAt = performance.now();
    addEventListener("resize", () => { window.__wcLastResizeAt = performance.now(); });
  }
  return true;
})()`;

/** Resolves once no `resize` event has fired for 1.1 s, then two frames
 * later. DevTools' "380px × 418px" viewport-size label is painted after a
 * resize and removed by Chrome's overlay one second later (Blink's
 * InspectorOverlayAgent::OnResizeTimer). In the real popup the label
 * appeared in captures even with Overlay.setShowViewportSizeOnResize({
 * show: false }) sent on the driving session (see real-popup-cdp.ts's
 * triggerRealPopup), so it isn't that session's overlay painting it.
 *
 * Two things resize the popup: a theme switch, and -- until P07-B revision
 * 2 -- `Page.captureScreenshot` itself (real-popup-cdp.ts's `captureFrame`
 * explains why and what replaced it). This wait covers the first. The
 * second is why the label still turned up "even after this wait" in
 * earlier rounds: the capture fired its own resize after the wait had
 * already ended. Exported for real-popup.spec.ts's regression test of
 * exactly that. */
export const AFTER_RESIZE_QUIET = `new Promise((resolve) => {
  ${RECORD_RESIZES};
  const settle = () => (performance.now() - window.__wcLastResizeAt >= 1100 ? resolve(true) : setTimeout(settle, 50));
  settle();
}).then(() => ${TWO_FRAMES})`;

export function popupThemeTarget(popup: RawCdpSession): ThemeTarget {
  return {
    label: "popup",
    setColorScheme: async (theme) => {
      await popup.evaluate(RECORD_RESIZES);
      await popup.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    },
    evaluate: <T>(expression: string) => popup.evaluate<T>(expression),
    capture: async () => {
      await popup.evaluate(AFTER_RESIZE_QUIET);
      return popup.captureFrame();
    },
  };
}

export function pageThemeTarget(page: Page, label: string): ThemeTarget {
  return {
    label,
    setColorScheme: async (theme) => {
      await page.evaluate(RECORD_RESIZES);
      await page.emulateMedia({ colorScheme: theme });
    },
    evaluate: <T>(expression: string) => page.evaluate(expression) as Promise<T>,
    capture: async () => {
      await page.evaluate(AFTER_RESIZE_QUIET);
      // P07-B revision 1: plain page.screenshot() only captures the
      // current viewport -- on a page taller than that (the options
      // page, once Pairing + Status + File bridge + the E4 note are all
      // stacked, easily is) it silently crops, which is exactly how the
      // committed P07B options screenshots ended up as 400x620 crops
      // that cut off File bridge. fullPage captures the whole scrollable
      // document regardless of the viewport height that's set.
      return page.screenshot({ fullPage: true });
    },
  };
}

interface ThemeState {
  dataTheme: string | undefined;
  declaredBackground: string;
  expectedBackground: string;
  bodyBackground: string;
}

/** Resolves two animation frames after it's evaluated, so at least one
 * frame has been produced with the page's current style (a capture taken
 * sooner can return the frame from before a theme switch).
 * `declaredBackground` is theme.css's own --background for `theme`, read
 * from that theme's rule (`:root` for light, `[data-theme="dark"]` for
 * dark) instead of a hard-coded colour; `expectedBackground` is that value
 * resolved the way body's background-color is. */
function themeStateAfterTwoFrames(theme: Theme): string {
  const selector = theme === "dark" ? '[data-theme="dark"]' : ":root";
  return `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
    let declaredBackground = "";
    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule instanceof CSSStyleRule && rule.selectorText === ${JSON.stringify(selector)}) {
          declaredBackground = rule.style.getPropertyValue("--background").trim() || declaredBackground;
        }
      }
    }
    const probe = document.createElement("div");
    probe.style.backgroundColor = declaredBackground;
    document.body.appendChild(probe);
    const expectedBackground = getComputedStyle(probe).backgroundColor;
    probe.remove();
    resolve({
      dataTheme: document.documentElement.dataset.theme,
      declaredBackground,
      expectedBackground,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
    });
  })))`;
}

function expectTheme(state: ThemeState, theme: Theme, where: string): void {
  expect(state.dataTheme, `${where}: data-theme`).toBe(theme);
  expect(state.declaredBackground, `${where}: theme.css declares --background for ${theme}`).not.toBe("");
  expect(state.bodyBackground, `${where}: body background is painted, not transparent`).not.toBe("rgba(0, 0, 0, 0)");
  expect(state.bodyBackground, `${where}: body background is theme.css's ${theme} --background`).toBe(
    state.expectedBackground,
  );
}

/** True once the page's own live media query agrees with `theme` --
 * independent of `data-theme`/background (those are downstream of this and
 * checked separately by `expectTheme`). */
function matchesColorSchemeExpr(theme: Theme): string {
  return `matchMedia("(prefers-color-scheme: dark)").matches === ${theme === "dark" ? "true" : "false"}`;
}

/**
 * Sets `target` to `theme` and, if the page's own `matchMedia` doesn't
 * agree yet, retries *only that* -- re-applying the override and waiting --
 * bounded at 10s. The real popup can drop a freshly set
 * `prefers-color-scheme` override: early in a new popup's life (observed
 * within ~1.3s of it opening), a resize ~150-550ms after the override is
 * set flips `matchMedia("(prefers-color-scheme: dark)")` back to false.
 * That is how a normal run once wrote a light P07A-popup-dark.png, and how
 * the dark axe audit could run against the light page. Retrying is
 * deliberately scoped to this one specific, understood browser quirk
 * (matchMedia disagreeing with what was just requested) -- P07-B carry-
 * forward: any other failure (a real markup/CSS regression, a missing
 * theme.css token) must fail the test at once, not be silently retried
 * away by a broad catch-and-retry.
 */
async function ensureColorScheme(target: ThemeTarget, theme: Theme): Promise<void> {
  await target.setColorScheme(theme);
  if (await target.evaluate<boolean>(matchesColorSchemeExpr(theme))) return;
  const deadline = Date.now() + 10_000;
  let delayMs = 250;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await target.setColorScheme(theme);
    if (await target.evaluate<boolean>(matchesColorSchemeExpr(theme))) return;
    delayMs = Math.min(delayMs * 2, 1000);
  }
  throw new Error(`${target.label}: matchMedia never agreed with "${theme}" after retrying the colour-scheme override for 10s`);
}

/** `ensureColorScheme`, then the full `expectTheme` check -- called both
 * before and after `action` in `inTheme`. If matchMedia has drifted again
 * by the time this runs (the same drop can recur mid-action, e.g. from a
 * resize the action itself triggers), only that gets a bounded retry via
 * `ensureColorScheme`; every other field `expectTheme` checks fails the
 * test immediately, with no retry -- with one narrow exception, handled
 * below: `data-theme` specifically can lag matchMedia rather than simply
 * disagree with it, which needs a different repair.
 *
 * `data-theme` is set by the page's own "change" listener on the
 * `prefers-color-scheme` MediaQueryList, not read fresh each time -- so if
 * the same spurious resize-triggered drop `ensureColorScheme` documents
 * flips matchMedia away and back to `theme` again before this function's
 * first matchMedia check runs, that check sees matchMedia already agreeing
 * (nothing to retry) while `data-theme` is left showing the stale value
 * from mid-flip, because the listener never got a *third* "change" event
 * telling it to correct back. Re-applying the same override at that point
 * is a no-op (matchMedia hasn't actually changed from this function's point
 * of view, so no event fires) -- forcing a real opposite-then-back
 * transition is what makes the listener run again. Bounded at 3 attempts;
 * a `data-theme` mismatch that survives all of them falls through to
 * `expectTheme`, which fails the test with no further retry. */
async function verifyTheme(target: ThemeTarget, theme: Theme, where: string): Promise<void> {
  if (!(await target.evaluate<boolean>(matchesColorSchemeExpr(theme)))) {
    await ensureColorScheme(target, theme);
  }
  const opposite: Theme = theme === "dark" ? "light" : "dark";
  let state = await target.evaluate<ThemeState>(themeStateAfterTwoFrames(theme));
  for (let attempt = 0; state.dataTheme !== theme && attempt < 3; attempt += 1) {
    await target.setColorScheme(opposite);
    await ensureColorScheme(target, theme);
    state = await target.evaluate<ThemeState>(themeStateAfterTwoFrames(theme));
  }
  expectTheme(state, theme, where);
}

/** Switches `target` to `theme`, runs `action`, and checks the page showed
 * `theme` both before and after it -- see `ensureColorScheme`/`verifyTheme`
 * for exactly what does and does not get retried. */
export async function inTheme<T>(target: ThemeTarget, theme: Theme, action: () => Promise<T>): Promise<T> {
  await ensureColorScheme(target, theme);
  await verifyTheme(target, theme, `${target.label} ${theme}, before`);
  const result = await action();
  await verifyTheme(target, theme, `${target.label} ${theme}, after`);
  return result;
}

/** Mean of the R, G, B bytes of a PNG's top-left pixel, which is page
 * background in every capture here. Row 0's first pixel is stored verbatim
 * whatever PNG filter the row uses (every filter predicts 0 there), so this
 * only has to inflate the image data, not unfilter it. */
function topLeftBrightness(png: Buffer): number {
  const idat: Buffer[] = [];
  let bitDepth = 0;
  let colorType = 0;
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
    } else if (type === "IDAT") {
      idat.push(data);
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unexpected PNG format (bit depth ${bitDepth}, colour type ${colorType})`);
  }
  const pixels = inflateSync(Buffer.concat(idat));
  // Byte 0 is row 0's filter type; bytes 1-3 are the first pixel's R, G, B.
  return (pixels.readUInt8(1) + pixels.readUInt8(2) + pixels.readUInt8(3)) / 3;
}

/**
 * Full per-scanline PNG defiltering (all five filter types, previous row
 * treated as zero for row 0) for the first `rowCount` rows -- unlike
 * `topLeftBrightness`'s row-0-first-pixel shortcut, this reconstructs real
 * pixel values at arbitrary x within those rows, which the corner check
 * below needs. Only 8-bit RGB/RGBA (the format every capture here uses,
 * same precondition topLeftBrightness already asserts).
 */
function decodeTopRows(png: Buffer, rowCount: number): { width: number; bpp: number; rows: Buffer[] } {
  const idat: Buffer[] = [];
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
    } else if (type === "IDAT") {
      idat.push(data);
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unexpected PNG format (bit depth ${bitDepth}, colour type ${colorType})`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const rows: Buffer[] = [];
  let previous = Buffer.alloc(stride, 0);
  let position = 0;
  for (let y = 0; y < Math.min(rowCount, height); y += 1) {
    const filterType = raw.readUInt8(position);
    const filtered = raw.subarray(position + 1, position + 1 + stride);
    const current = Buffer.alloc(stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? (current[i - bpp] ?? 0) : 0; // left
      const b = previous[i] ?? 0; // up
      const c = i >= bpp ? (previous[i - bpp] ?? 0) : 0; // upper-left
      let value: number;
      switch (filterType) {
        case 0:
          value = filtered[i] ?? 0;
          break;
        case 1:
          value = (filtered[i] ?? 0) + a;
          break;
        case 2:
          value = (filtered[i] ?? 0) + b;
          break;
        case 3:
          value = (filtered[i] ?? 0) + Math.floor((a + b) / 2);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          value = (filtered[i] ?? 0) + predictor;
          break;
        }
        default:
          throw new Error(`unsupported PNG filter type ${filterType}`);
      }
      current[i] = value & 0xff;
    }
    rows.push(current);
    previous = current;
    position += 1 + stride;
  }
  return { width, bpp, rows };
}

/** "380x404": a PNG's own width and height (IHDR, bytes 16-23), for
 * failure messages -- a capture of the wrong size is itself a clue (CI's
 * failing P07A-popup-dark.png was at most 319 px wide, since its first bad
 * pixel was x = 159 of a 160-px band). */
function pngSize(png: Buffer): string {
  return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
}

/**
 * P07-B carry-forward: "Assert that the screenshot's top-right corner has
 * no DevTools size label." Chrome's device-emulation viewport-size label
 * (e.g. "380px x 418px"), when present, paints over the page there --
 * this is the regression guard that it stayed out, not the mechanism that
 * keeps it out (AFTER_RESIZE_QUIET, and a capture that fires no resize of
 * its own -- real-popup-cdp.ts's `captureFrame`).
 *
 * Every pixel in a small band along the top-right edge must match the
 * image's OWN top-left pixel almost exactly: a real screenshot is a
 * lossless PNG straight from Chrome's own compositor, the page background
 * is one flat colour with nothing painted near either corner, and the
 * top-left pixel is already proven to show the right theme
 * (topLeftBrightness, checked before this runs). Comparing corner to
 * corner within the same image, instead of re-deriving an "expected"
 * colour from `getComputedStyle` CSS text, sidesteps that text not always
 * being `rgb(...)` -- Chrome can serialize a computed background declared
 * via `oklch()` (this repo's theme.css) back out as `oklch(...)` too, which
 * a plain rgb()-pattern parse would reject.
 *
 * Returns a description of the first pixel that differs, or undefined when
 * the band is clean.
 */
export function findDevToolsLabelTopRight(png: Buffer): string | undefined {
  const bandHeight = 24;
  const bandWidth = 160;
  const tolerance = 12;
  const { width, bpp, rows } = decodeTopRows(png, bandHeight);
  const reference = rows[0];
  if (!reference) throw new Error(`could not decode row 0 of a ${pngSize(png)} PNG to sample a reference colour`);
  const [refR, refG, refB] = [reference[0] ?? 0, reference[1] ?? 0, reference[2] ?? 0];
  const startX = Math.max(0, width - bandWidth);

  for (let y = 0; y < rows.length; y += 1) {
    const row = rows[y];
    if (!row) continue;
    for (let x = startX; x < width; x += 1) {
      const offset = x * bpp;
      const r = row[offset] ?? 0;
      const g = row[offset + 1] ?? 0;
      const b = row[offset + 2] ?? 0;
      if (Math.abs(r - refR) > tolerance || Math.abs(g - refG) > tolerance || Math.abs(b - refB) > tolerance) {
        return `pixel (${x}, ${y}) in the top-right corner of the ${pngSize(png)} image is rgb(${r}, ${g}, ${b}), not the page's own background rgb(${refR}, ${refG}, ${refB}) (sampled from the image's own top-left corner) -- looks like a DevTools viewport-size label`;
      }
    }
  }
  return undefined;
}

/** Each of captureInTheme's two repairs may run this many times before the
 * capture fails. They are counted separately, so one can never use up the
 * other's budget. */
const MAX_SCHEME_REPAIRS = 3;
const MAX_LABEL_WAITS = 3;

/** Captures `target` in `theme` and writes the PNG (via `resolvePath`, so
 * each caller keeps its own committed-vs-gitignored-output policy) only
 * once the capture itself is proven to show that theme: its top-left
 * pixel, page background, is light (mean RGB >= 128) for light and dark
 * for dark, and its top-right corner shows no DevTools viewport-size
 * label. A wrong image is never written.
 *
 * Two different, understood browser behaviours can spoil a capture, and
 * each gets its own repair with its own bound (P07-B revision 2 split
 * them: in revision 1 they shared one four-attempt loop):
 *
 * 1. The matchMedia drop (see ensureColorScheme): the background has the
 *    wrong brightness AND the page's own `matchMedia` disagrees with
 *    `theme` right now. Repair: re-force the scheme, recapture. `inTheme`'s
 *    "before" check already proved matchMedia, data-theme and the CSS
 *    background all agreed immediately before this action started, so a
 *    wrong brightness while matchMedia still agrees is not this quirk; it
 *    fails at once (the P07-B revision 1 reviewer nit, kept).
 * 2. The overlay: DevTools' viewport-size label is in the top-right
 *    corner. Chrome removes it one second after the last resize, so the
 *    repair is to wait that out -- `target.capture()` always starts with a
 *    fresh AFTER_RESIZE_QUIET -- and recapture. Since `captureFrame`
 *    (real-popup-cdp.ts) the popup capture no longer resizes the popup
 *    itself, so this should only ever be a late resize from a theme
 *    switch.
 *
 * Anything else -- or either repair running out -- fails the test with the
 * image's size in the message. */
export async function captureInTheme(
  target: ThemeTarget,
  theme: Theme,
  fileName: string,
  resolvePath: (fileName: string) => string,
): Promise<void> {
  const png = await inTheme(target, theme, async () => {
    await target.evaluate("document.fonts.ready.then(() => true)");

    let schemeRepairs = 0;
    let labelWaits = 0;
    for (;;) {
      const capture = await target.capture();
      const brightness = topLeftBrightness(capture);
      const observed: Theme = brightness >= 128 ? "light" : "dark";
      if (observed !== theme) {
        const stillMatches = await target.evaluate<boolean>(matchesColorSchemeExpr(theme));
        if (stillMatches || schemeRepairs === MAX_SCHEME_REPAIRS) {
          expect(
            observed,
            `${fileName} (${pngSize(capture)}): captured background, mean RGB ${brightness}` +
              (stillMatches
                ? " (matchMedia already agrees with the requested theme -- not the known spurious-drop quirk)"
                : ` (matchMedia still disagreed after ${schemeRepairs} re-forced overrides)`),
          ).toBe(theme);
        }
        schemeRepairs += 1;
        await ensureColorScheme(target, theme);
        continue;
      }
      const label = findDevToolsLabelTopRight(capture);
      if (label === undefined) return capture;
      if (labelWaits === MAX_LABEL_WAITS) {
        throw new Error(`${fileName}: ${label}; still there after ${labelWaits} waits for the overlay to clear`);
      }
      labelWaits += 1;
    }
  });
  writeFileSync(resolvePath(fileName), png);
}
