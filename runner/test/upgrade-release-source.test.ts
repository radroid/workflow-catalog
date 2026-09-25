import { describe, expect, it } from "vitest";
import { downloadReleaseAsset, fetchBytes, fetchLatestRelease, type PerformRequest, type RawResponse, type Resolve } from "../upgrade/release-source.ts";
import { buildReleaseTarball, fakeUpgradeDeps, sha256Line } from "./upgrade-fixtures.ts";

const PUBLIC_ADDRESS = { address: "203.0.113.10", family: 4 as const };

/** A typed constructor keeps every ad hoc fake response a plain `RawResponse`, so a branch with different header keys never becomes an incompatible object-literal union. */
function raw(status: number, headers: Record<string, string>, body: Buffer): RawResponse {
  return { status, headers, body };
}

function fakeDeps(overrides: { resolve?: Resolve; performRequest?: PerformRequest } = {}) {
  return {
    resolve: overrides.resolve ?? (async () => [PUBLIC_ADDRESS]),
    performRequest: overrides.performRequest ?? (async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }) satisfies RawResponse),
  };
}

describe("fetchBytes", () => {
  it("refuses a non-https URL before ever resolving or connecting", async () => {
    const result = await fetchBytes("http://example.com/file", {}, fakeDeps({ resolve: async () => { throw new Error("must not resolve"); } }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("scheme_not_https");
  });

  it("refuses an address isBlockedAddress rejects (private, loopback, link-local, metadata)", async () => {
    const result = await fetchBytes("https://internal.example/x", {}, fakeDeps({ resolve: async () => [{ address: "127.0.0.1", family: 4 }] }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("blocked_address");
  });

  it("refuses when DNS resolution fails", async () => {
    const result = await fetchBytes("https://nowhere.example/x", {}, fakeDeps({ resolve: async () => { throw new Error("NXDOMAIN"); } }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("dns_failed");
  });

  it("follows a redirect and re-validates the new hop's address", async () => {
    let calls = 0;
    const performRequest: PerformRequest = async ({ url }) => {
      calls += 1;
      if (url.toString() === "https://start.example/a") return raw(302, { location: "https://start.example/b" }, Buffer.alloc(0));
      return raw(200, { "content-type": "text/plain" }, Buffer.from("ok", "utf8"));
    };
    const result = await fetchBytes("https://start.example/a", {}, fakeDeps({ performRequest }));
    expect(result.ok).toBe(true);
    expect(result.ok && result.bytes.toString("utf8")).toBe("ok");
    expect(calls).toBe(2);
  });

  it("refuses a redirect to a blocked address", async () => {
    const performRequest: PerformRequest = async ({ url }) => {
      if (url.hostname === "start.example") return raw(302, { location: "https://internal.example/b" }, Buffer.alloc(0));
      return raw(200, {}, Buffer.alloc(0));
    };
    const resolve: Resolve = async (hostname) => [hostname === "internal.example" ? { address: "10.0.0.5", family: 4 } : PUBLIC_ADDRESS];
    const result = await fetchBytes("https://start.example/a", {}, fakeDeps({ performRequest, resolve }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("blocked_address");
  });

  it("caps redirects", async () => {
    const performRequest: PerformRequest = async ({ url }) => ({ status: 302, headers: { location: `${url.toString()}x` }, body: Buffer.alloc(0) });
    const result = await fetchBytes("https://loop.example/a", {}, { ...fakeDeps({ performRequest }), maxRedirects: 2 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("too_many_redirects");
  });

  it("refuses an http status outside 2xx", async () => {
    const result = await fetchBytes("https://example.test/a", {}, fakeDeps({ performRequest: async () => ({ status: 500, headers: {}, body: Buffer.alloc(0) }) }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("http_status");
  });
});

describe("fetchLatestRelease", () => {
  it("returns release: undefined when there is no release yet (404, the real state of this repo today)", async () => {
    const result = await fetchLatestRelease(fakeUpgradeDeps(undefined));
    expect(result.ok).toBe(true);
    expect(result.ok && result.release).toBeUndefined();
  });

  it("parses a real job-assistant release's tag, assets and notes", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify({ version: "0.2.0" }) });
    const result = await fetchLatestRelease(fakeUpgradeDeps({ version: "0.2.0", notes: "New things.", tarball }));
    expect(result.ok).toBe(true);
    expect(result.ok && result.release?.version).toBe("0.2.0");
    expect(result.ok && result.release?.tagName).toBe("job-assistant@0.2.0");
    expect(result.ok && result.release?.notes).toBe("New things.");
    expect(result.ok && result.release?.assets.map((a) => a.name).sort()).toEqual(["job-assistant-0.2.0.tgz", "job-assistant-0.2.0.tgz.sha256"]);
  });

  it("treats a latest release under a different tag prefix as 'no job-assistant release'", async () => {
    const performRequest: PerformRequest = async ({ url }) =>
      url.hostname === "api.github.com"
        ? raw(200, { "content-type": "application/json" }, Buffer.from(JSON.stringify({ tag_name: "something-else@1.0.0", body: "", assets: [] }), "utf8"))
        : raw(404, {}, Buffer.alloc(0));
    const result = await fetchLatestRelease({ resolve: async () => [PUBLIC_ADDRESS], performRequest });
    expect(result.ok).toBe(true);
    expect(result.ok && result.release).toBeUndefined();
  });
});

describe("downloadReleaseAsset", () => {
  it("downloads an asset's bytes", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": "{}" });
    const deps = fakeUpgradeDeps({ version: "0.2.0", tarball });
    const latest = await fetchLatestRelease(deps);
    const tarballAsset = latest.ok ? latest.release?.assets.find((a) => a.name.endsWith(".tgz")) : undefined;
    expect(tarballAsset).toBeDefined();
    const result = await downloadReleaseAsset(tarballAsset!.url, deps);
    expect(result.ok).toBe(true);
    expect(result.ok && Buffer.compare(result.bytes, tarball)).toBe(0);
  });
});

// sha256Line is exercised indirectly above (fakeUpgradeDeps' default checksum); this proves its own shape once, directly.
describe("sha256Line", () => {
  it("matches sha256sum's <hex>  <filename> form", () => {
    const line = sha256Line(Buffer.from("x", "utf8"), "f.tgz");
    expect(line).toMatch(/^[0-9a-f]{64} {2}f\.tgz\n$/);
  });
});
