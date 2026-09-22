import { afterEach, describe, expect, it, vi } from "vitest";

// P09.1 revision round (reviewer R1, third required test — "the parsed
// result is cached and revalidates"): tests/release.test.ts proves the raw
// fetch inside fetchPackageRelease is never cached (cache: "no-store", no
// `next` option). This file proves the other half of the fix: that
// getCachedPackageRelease actually registers fetchPackageRelease with
// unstable_cache under keyParts ["release"] and this module's own
// RELEASE_REVALIDATE_SECONDS window, and that a real call through
// getCachedPackageRelease still delegates to fetchPackageRelease with
// `version` passed as a real argument (not closed over — see
// lib/release.ts's doc comment on why that distinction matters to
// unstable_cache's own key derivation).
//
// The real unstable_cache requires Next's request-scoped incrementalCache
// to actually invoke its wrapped function (`Invariant: incrementalCache
// missing` otherwise, confirmed empirically — see lib/release.ts's doc
// comment). Merely *constructing* the wrapper doesn't throw, which is why
// tests/release.test.ts can import lib/release.ts unmocked at all, but
// calling the wrapped function would. Mocking next/cache's unstable_cache
// here as an identity passthrough (return the given function unmodified)
// sidesteps that: getCachedPackageRelease becomes directly callable in
// this test's module graph, while unstableCacheMock's own call args are
// exactly what the real unstable_cache would have been asked to register.
const { unstableCacheMock } = vi.hoisted(() => ({
  unstableCacheMock: vi.fn((fn: (...args: never[]) => unknown) => fn),
}));

vi.mock("next/cache", () => ({
  unstable_cache: unstableCacheMock,
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getCachedPackageRelease — unstable_cache wiring", () => {
  it('registers fetchPackageRelease under keyParts ["release"] with this module\'s revalidation window', async () => {
    const { RELEASE_REVALIDATE_SECONDS } = await import("../lib/release");

    expect(unstableCacheMock).toHaveBeenCalledTimes(1);
    const [wrapped, keyParts, options] = unstableCacheMock.mock.calls[0]!;
    expect(typeof wrapped).toBe("function");
    expect(keyParts).toEqual(["release"]);
    // Compared against the module's own exported constant, not a literal
    // 3600 — this test must keep failing for the right reason if someone
    // changes RELEASE_REVALIDATE_SECONDS without updating this file, and
    // keep passing if they change both together.
    expect(options).toEqual({ revalidate: RELEASE_REVALIDATE_SECONDS });
  });

  it("delegates a real call through to fetchPackageRelease, with version passed as a real argument", async () => {
    const { getCachedPackageRelease } = await import("../lib/release");
    const VERSION = "9.9.9";
    let requestedUrl: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        requestedUrl = String(input);
        return new Response("Not Found", { status: 404 });
      }),
    );

    const result = await getCachedPackageRelease(VERSION);

    // Only meaningful if the version this call passed in is what actually
    // reached fetchPackageRelease's URL construction — proving delegation
    // and argument pass-through together, not just that *some* fetch
    // happened.
    expect(requestedUrl).toBe(
      "https://github.com/radroid/workflow-catalog/releases/download/job-assistant%409.9.9/job-assistant-9.9.9.tgz.sha256",
    );
    expect(result.kind).toBe("not_found");
  });
});
