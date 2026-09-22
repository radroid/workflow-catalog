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
  });
});
