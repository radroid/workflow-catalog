import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
function read(relPath: string): string {
  return readFileSync(path.join(here, relPath), "utf8");
}

const errorAlert = read("../components/error-alert.tsx");
const adminPage = read("../app/admin/page.tsx");
const invitePage = read("../app/invite/[token]/page.tsx");

// Regression coverage for a P09-B must-fix: a refusal reached via a Server
// Action (redirect to `?error=CODE`) is, whenever JavaScript is on, an
// in-app client-side transition, not a full page load — so a bare
// `autoFocus` JSX attribute on the "Refused" box was not a reliable way to
// move focus there (only a real full navigation has the browser's own HTML
// parser around to honor it). These tests read source as text and assert
// the structural facts that make the fix correct (matching
// tests/globals.test.ts's established convention for CSS/JSX facts) — for
// the actual focus-moves-on-every-refusal *behavior*, including the
// repeated-identical-refusal case a P09-B revision round added, see the
// real-DOM rendering tests in tests/error-alert-remount.test.tsx instead. A
// source pattern match can prove the JSX has the right shape; it can't
// prove focus actually lands anywhere, which is why that file exists too.
describe("ErrorAlert — focus moves to the refusal box on every refusal, not only a full page load", () => {
  it("is a Client Component that focuses itself via a ref + effect on mount", () => {
    expect(errorAlert).toMatch(/^"use client";/);
    expect(errorAlert).toMatch(/useRef<HTMLDivElement>/);
    expect(errorAlert).toMatch(/useEffect\(\s*\(\)\s*=>\s*{\s*ref\.current\?\.focus\(\);/);
    expect(errorAlert).toMatch(/tabIndex={-1}/);
    expect(errorAlert).toMatch(/role="alert"/);
  });

  it("no longer relies on a bare autoFocus attribute anywhere in the admin or invite pages", () => {
    expect(adminPage).not.toMatch(/autoFocus/);
    expect(invitePage).not.toMatch(/autoFocus/);
  });

  it("both pages render ErrorAlert (not a raw flash div) for every refusal", () => {
    expect(adminPage).toMatch(/import { ErrorAlert } from "..\/..\/components\/error-alert";/);
    expect([...adminPage.matchAll(/<ErrorAlert\b/g)]).toHaveLength(2);
    expect(invitePage).toMatch(/import { ErrorAlert } from "..\/..\/..\/components\/error-alert";/);
    expect([...invitePage.matchAll(/<ErrorAlert\b/g)]).toHaveLength(2);
  });

  it("every ErrorAlert call site is conditional on the error/status turning truthy, and keyed by the per-attempt nonce", () => {
    // ErrorAlert must only ever be reached through a `cond ? <ErrorAlert
    // ... /> : ...` ternary — never rendered unconditionally — because it's
    // that transition (nothing there -> the element newly there) which
    // makes the ref + mount-effect fire on every *first* refusal. On its
    // own that's not enough for a *second, identical* refusal in a row: two
    // requests for the exact same `?error=CODE` URL don't change the
    // element's key, so React reconciles in place instead of remounting,
    // and the mount-only effect doesn't re-run. `key={nonce}` (nonce = the
    // `n` search param lib/actions/owner.ts and lib/actions/invite.ts mint
    // fresh per redirect) forces a remount every time regardless of whether
    // the message text repeats — deliberately not an impure per-render
    // value like `Date.now()`, which `react-hooks/purity` (this repo's
    // configured lint rule) rejects reading directly in a Server
    // Component's render body; nonce is plain data read out of
    // `searchParams`, not computed during render.
    expect(adminPage).toMatch(/{error \? <ErrorAlert key={nonce} id="admin-error" message={error} \/> : null}/);
    expect(adminPage).toMatch(/{error \? <ErrorAlert key={nonce} message={error} \/> : null}/);
    expect(invitePage).toMatch(/status === "invalid" \? \(\s*\n\s*<ErrorAlert message=/);
    expect(invitePage).toMatch(/{error \? <ErrorAlert key={nonce} id="invite-error" message={error} \/> : null}/);
  });
});
