import { afterEach, describe, expect, it, vi } from "vitest";
import { RELEASE_FETCH_TIMEOUT_MS, fetchPackageRelease, releaseTag } from "../lib/release";

const VERSION = "0.1.0";
const TARBALL_NAME = "job-assistant-0.1.0.tgz";
const CHECKSUM_NAME = `${TARBALL_NAME}.sha256`;
const TARBALL_URL = `https://github.com/radroid/workflow-catalog/releases/download/job-assistant%400.1.0/${TARBALL_NAME}`;
const CHECKSUM_URL = `https://github.com/radroid/workflow-catalog/releases/download/job-assistant%400.1.0/${CHECKSUM_NAME}`;
const CHECKSUM_HEX = "a".repeat(64);

function releaseApiBody() {
  return {
    tag_name: releaseTag(VERSION),
    assets: [
      { name: TARBALL_NAME, browser_download_url: TARBALL_URL },
      { name: CHECKSUM_NAME, browser_download_url: CHECKSUM_URL },
    ],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fetchPackageRelease — release present", () => {
  it("returns the release-asset download URL and a checksum equal to the .sha256 asset's own content", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/")) {
        expect(url).toBe(`https://api.github.com/repos/radroid/workflow-catalog/releases/tags/job-assistant%400.1.0`);
        return new Response(JSON.stringify(releaseApiBody()), { status: 200 });
      }
      if (url === CHECKSUM_URL) {
        return new Response(`${CHECKSUM_HEX}  ${TARBALL_NAME}\n`, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPackageRelease(VERSION);

    expect(result.kind).toBe("found");
    if (result.kind !== "found") throw new Error("unreachable");
    expect(result.release.checksum).toBe(CHECKSUM_HEX);
    expect(result.release.tarballUrl).toBe(TARBALL_URL);
    expect(result.release.tarballUrl).not.toMatch(/vercel/i);
    expect(result.release.tarballUrl).toMatch(/^https:\/\/github\.com\/radroid\/workflow-catalog\/releases\//);
  });

  it("lowercases an uppercase hex checksum", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/")) return new Response(JSON.stringify(releaseApiBody()), { status: 200 });
        return new Response(`${CHECKSUM_HEX.toUpperCase()}  ${TARBALL_NAME}\n`, { status: 200 });
      }),
    );

    const result = await fetchPackageRelease(VERSION);
    expect(result.kind).toBe("found");
    if (result.kind !== "found") throw new Error("unreachable");
    expect(result.release.checksum).toBe(CHECKSUM_HEX);
  });
});

describe("fetchPackageRelease — release absent", () => {
  it("reports not_found on a 404 from the GitHub API (no release yet)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );

    const result = await fetchPackageRelease(VERSION);
    expect(result.kind).toBe("not_found");
  });
});

describe("fetchPackageRelease — API error", () => {
  it("reports error on a non-404, non-OK API response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );

    const result = await fetchPackageRelease(VERSION);
    expect(result.kind).toBe("error");
  });

  it("reports error when the API response is not valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200 })),
    );

    const result = await fetchPackageRelease(VERSION);
    expect(result.kind).toBe("error");
  });

  it("reports error when the release is missing the expected tarball or checksum asset", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ assets: [] }), { status: 200 })),
    );

    const result = await fetchPackageRelease(VERSION);
    expect(result.kind).toBe("error");
  });

  it("reports error when the checksum asset's own fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/")) return new Response(JSON.stringify(releaseApiBody()), { status: 200 });
        return new Response("", { status: 500 });
      }),
    );

    const result = await fetchPackageRelease(VERSION);
    expect(result.kind).toBe("error");
  });

  it("reports error when the checksum asset's content is not a recognizable sha256sum line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/")) return new Response(JSON.stringify(releaseApiBody()), { status: 200 });
        return new Response("not a checksum", { status: 200 });
      }),
    );

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
});

describe("fetchPackageRelease — timeout", () => {
  it("aborts and reports error once the request exceeds the timeout", async () => {
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
});
