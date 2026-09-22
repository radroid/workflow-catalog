import { afterEach, describe, expect, it, vi } from "vitest";
import { RELEASE_FETCH_TIMEOUT_MS, fetchPackageRelease } from "../lib/release";

const VERSION = "0.1.0";
const TAG = "job-assistant@0.1.0";
const TARBALL_NAME = "job-assistant-0.1.0.tgz";
const CHECKSUM_NAME = `${TARBALL_NAME}.sha256`;
const DOWNLOAD_BASE = `https://github.com/radroid/workflow-catalog/releases/download/${encodeURIComponent(TAG)}`;
const TARBALL_URL = `${DOWNLOAD_BASE}/${TARBALL_NAME}`;
const CHECKSUM_URL = `${DOWNLOAD_BASE}/${CHECKSUM_NAME}`;
const CHECKSUM_HEX = "a".repeat(64);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stubFetchOnce(handler: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => handler(String(input))),
  );
}

describe("fetchPackageRelease — release present", () => {
  it("fetches the fixed github.com/.../releases/download/ URL directly, no API call", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url !== CHECKSUM_URL) {
        throw new Error(`unexpected fetch: ${url} (only the checksum asset should ever be fetched)`);
      }
      return new Response(`${CHECKSUM_HEX}  ${TARBALL_NAME}\n`, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPackageRelease(VERSION);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("found");
    if (result.kind !== "found") throw new Error("unreachable");
    expect(result.release.checksum).toBe(CHECKSUM_HEX);
    // Constructed locally from fixed constants, never read out of a
    // response body — nothing here is a model- or API-supplied URL.
    expect(result.release.tarballUrl).toBe(TARBALL_URL);
    expect(result.release.checksumAssetUrl).toBe(CHECKSUM_URL);
    expect(result.release.tarballUrl).not.toMatch(/vercel/i);
    expect(result.release.tarballUrl).toMatch(/^https:\/\/github\.com\/radroid\/workflow-catalog\/releases\/download\//);
  });

  it("lowercases an uppercase hex checksum", async () => {
    stubFetchOnce(() => new Response(`${CHECKSUM_HEX.toUpperCase()}  ${TARBALL_NAME}\n`, { status: 200 }));

    const result = await fetchPackageRelease(VERSION);
    expect(result.kind).toBe("found");
    if (result.kind !== "found") throw new Error("unreachable");
    expect(result.release.checksum).toBe(CHECKSUM_HEX);
  });
});

describe("fetchPackageRelease — release absent", () => {
  it("reports not_found on a 404 for the checksum asset (no release yet)", async () => {
    stubFetchOnce(() => new Response("Not Found", { status: 404 }));

    const result = await fetchPackageRelease(VERSION);
    expect(result.kind).toBe("not_found");
  });
});

describe("fetchPackageRelease — error", () => {
  it("reports error on a non-404, non-OK response", async () => {
    stubFetchOnce(() => new Response("", { status: 500 }));

    const result = await fetchPackageRelease(VERSION);
    expect(result.kind).toBe("error");
  });

  it("reports error when the checksum content is not a recognizable sha256sum line", async () => {
    stubFetchOnce(() => new Response("not a checksum", { status: 200 }));

    const result = await fetchPackageRelease(VERSION);
    expect(result.kind).toBe("error");
  });

  it("reports error when the checksum line names a different file than the one requested", async () => {
    // P09-B revision round: a checksum line that parses fine but names the
    // wrong asset must not be accepted as if it matched this tarball.
    stubFetchOnce(() => new Response(`${CHECKSUM_HEX}  some-other-package-9.9.9.tgz\n`, { status: 200 }));

    const result = await fetchPackageRelease(VERSION);
    expect(result.kind).toBe("error");
  });

  it("reports error on a network rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const result = await fetchPackageRelease(VERSION);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unreachable");
    expect(result.message).toContain("network down");
  });

  it("reports error when the response body exceeds the size cap", async () => {
    // Comfortably over the internal cap (a .sha256 file is a few hundred
    // bytes at most) without needing to import the exact constant.
    stubFetchOnce(() => new Response("a".repeat(50_000), { status: 200 }));

    const result = await fetchPackageRelease(VERSION);
    expect(result.kind).toBe("error");
  });

  // P09-B peer review, round 2 (low follow-up #2): when the cap trips,
  // readCappedText used to release its lock on the reader (in a `finally`)
  // without ever cancelling it — dropping this function's own reference to
  // the stream, but never telling the underlying connection to stop. A
  // custom ReadableStream whose `cancel()` records that it was called is
  // the only way to prove the fix from outside the module: a plain
  // Response body (as the test above uses) doesn't expose whether anyone
  // downstream is still consuming the connection after this function gives
  // up on it. This test fails against the pre-fix code (confirmed:
  // temporarily reverted the `reader.cancel()` call locally, reran, watched
  // `cancelCalled` stay false).
  //
  // P09.1 revision round (reviewer R1): cancel() alone turned out not to be
  // enough in production — when this fetch was routed through Next's Data
  // Cache, Next's patched fetch had already teed the response, and
  // cancelling only *our* copy of the body left an internal second copy
  // (feeding the cache) still reading regardless, measured at ~835 KB and
  // ~5 s. Aborting the fetch's own AbortSignal is what actually stops the
  // underlying request; this test now also captures the signal the mocked
  // fetch was called with and asserts it's aborted once the cap trips.
  it("cancels the body reader AND aborts the fetch's own signal once the cap trips", async () => {
    let cancelCalled = false;
    let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            // One chunk, comfortably over the 4096-byte cap, so the cap
            // trips on the very first read() rather than needing the
            // stream to be asked for more.
            controller.enqueue(new TextEncoder().encode("a".repeat(50_000)));
          },
          cancel() {
            cancelCalled = true;
          },
        });
        return new Response(stream, { status: 200 });
      }),
    );

    const result = await fetchPackageRelease(VERSION);

    expect(result.kind).toBe("error");
    expect(cancelCalled).toBe(true);
    expect(capturedSignal?.aborted).toBe(true);
  });

  // P09.1 revision round (reviewer R1): this fetch must never enter Next's
  // Data Cache — the *parsed* result is what getCachedPackageRelease caches
  // instead (see release-cache.test.ts). `cache: "no-store"` is the
  // documented way to opt a single fetch() call out of it; a `next: {...}`
  // option is the (now removed) alternative that put it there in the first
  // place, so this also asserts that option is gone, not just that
  // no-store is present.
  it("never passes fetch a `next` caching option, and always passes cache: \"no-store\"", async () => {
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedInit = init;
        return new Response(`${CHECKSUM_HEX}  ${TARBALL_NAME}\n`, { status: 200 });
      }),
    );

    await fetchPackageRelease(VERSION);

    expect(capturedInit?.cache).toBe("no-store");
    expect(capturedInit).not.toHaveProperty("next");
  });
});

describe("fetchPackageRelease — timeout", () => {
  it("aborts and reports error once the request exceeds the timeout before headers arrive", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const abortError = new Error("This operation was aborted");
            abortError.name = "AbortError";
            reject(abortError);
          });
        });
      }),
    );

    const pending = fetchPackageRelease(VERSION);
    await vi.advanceTimersByTimeAsync(RELEASE_FETCH_TIMEOUT_MS + 1);
    const result = await pending;

    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unreachable");
    expect(result.message).toMatch(/timed out/i);
  });

  // P09-B revision round (reviewer issue 2): the previous implementation
  // cleared its abort timer as soon as fetch() itself resolved — i.e. once
  // headers arrived — so a body that stalled *after* that point hung
  // forever, with no timeout protection at all. Both of the next two tests
  // give fetch() a Response that resolves immediately (status/ok available
  // right away) but whose body ReadableStream never closes; if the fix
  // regressed, `await pending` below would simply never settle and the
  // test would time out (fail) rather than assert anything meaningful.
  it("resolves to the error state within the timeout when the body stalls before any bytes arrive", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start() {
            // Never enqueue, never close.
          },
        });
        return new Response(stream, { status: 200 });
      }),
    );

    const pending = fetchPackageRelease(VERSION);
    await vi.advanceTimersByTimeAsync(RELEASE_FETCH_TIMEOUT_MS + 1);
    const result = await pending;

    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unreachable");
    // P09.1 (P09-B review round 2 follow-up): pin the actual message, not
    // just the "error" kind — describeFetchError only produces this exact
    // string for an AbortError, so this also proves the abort (not some
    // other rejection) is what resolved the request.
    expect(result.message).toBe("Request timed out.");
  });

  it("resolves to the error state within the timeout when the body stalls mid-stream, after some bytes", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(CHECKSUM_HEX.slice(0, 8)));
            // Then stall — never enqueue the rest, never close.
          },
        });
        return new Response(stream, { status: 200 });
      }),
    );

    const pending = fetchPackageRelease(VERSION);
    await vi.advanceTimersByTimeAsync(RELEASE_FETCH_TIMEOUT_MS + 1);
    const result = await pending;

    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unreachable");
    expect(result.message).toBe("Request timed out.");
  });
});
