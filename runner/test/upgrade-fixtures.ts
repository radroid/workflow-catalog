import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { PerformRequest, RawResponse, Resolve, UpgradeFetchDeps } from "../upgrade/release-source.ts";

/**
 * Shared fixtures for the upgrade flow's tests (P10 packet Decisions:
 * "Serve fake releases (0.1.0 and 0.2.0 tarballs and their checksums) from
 * an injected fetch or a local fixture" — no test here ever touches the
 * network, GitHub, or DNS). A hand-rolled USTAR writer, the mirror of
 * `upgrade/tar.ts`'s reader: only what a small, ASCII, non-directory
 * tarball needs (no PAX, no long names), which is all these fixtures are.
 */

const BLOCK_SIZE = 512;

function ustarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100, "ascii"); // mode
  header.write("0000000\0", 108, "ascii"); // uid
  header.write("0000000\0", 116, "ascii"); // gid
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii"); // size, octal
  header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 136, "ascii"); // mtime
  header.write("        ", 148, "ascii"); // chksum placeholder: eight spaces
  header.write("0", 156, "ascii"); // typeflag: regular file
  header.write("ustar\0", 257, "ascii"); // magic
  header.write("00", 263, "ascii"); // version
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

function tarEntry(name: string, content: string | Buffer): Buffer {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const header = ustarHeader(name, data.length);
  const paddedLength = Math.ceil(data.length / BLOCK_SIZE) * BLOCK_SIZE;
  const padded = Buffer.alloc(paddedLength);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

/** A minimal but valid gzip+tar release tarball: `package/<name>` for every file given, npm/pnpm-pack style. */
export function buildReleaseTarball(files: Record<string, string>): Buffer {
  const parts = Object.entries(files).map(([name, content]) => tarEntry(`package/${name}`, content));
  const end = Buffer.alloc(BLOCK_SIZE * 2); // the end-of-archive marker: two zero blocks
  return gzipSync(Buffer.concat([...parts, end]));
}

export function sha256Line(bytes: Buffer, filename: string): string {
  // Mirrors checksum.ts's own algorithm deliberately (not importing it): a
  // test proving verifyChecksum works should compute the digest its own way.
  return `${createHash("sha256").update(bytes).digest("hex")}  ${filename}\n`;
}

export interface FakeAsset {
  readonly name: string;
  readonly bytes: Buffer;
}

export interface FakeRelease {
  readonly version: string;
  readonly notes?: string;
  readonly tarball: Buffer;
  /** Defaults to a correct checksum of `tarball`; override to build a mismatch fixture. */
  readonly checksumBytes?: Buffer;
}

const FAKE_ADDRESS = { address: "203.0.113.10", family: 4 as const }; // TEST-NET-3 (RFC 5737): a public, documentation-only address, not one isBlockedAddress refuses

/**
 * Builds `UpgradeFetchDeps` that serve `release` from GitHub's "latest
 * release" endpoint and its two assets, entirely in memory. `undefined`
 * release means "no releases published" (a 404, exactly what `fetchLatestRelease`
 * treats as `release: undefined`).
 */
export function fakeUpgradeDeps(release: FakeRelease | undefined): UpgradeFetchDeps {
  const tarballName = release ? `job-assistant-${release.version}.tgz` : "";
  const checksumName = `${tarballName}.sha256`;
  const checksumBytes = release ? (release.checksumBytes ?? Buffer.from(sha256Line(release.tarball, tarballName), "utf8")) : Buffer.alloc(0);
  const tarballUrl = "https://releases.example/assets/tarball";
  const checksumUrl = "https://releases.example/assets/checksum";

  const releaseJson = release
    ? JSON.stringify({
        tag_name: `job-assistant@${release.version}`,
        body: release.notes ?? `Release notes for ${release.version}.`,
        assets: [
          { name: tarballName, browser_download_url: tarballUrl },
          { name: checksumName, browser_download_url: checksumUrl },
        ],
      })
    : undefined;

  const resolve: Resolve = async () => [FAKE_ADDRESS];
  const performRequest: PerformRequest = async ({ url }) => {
    if (url.hostname === "api.github.com") {
      if (!releaseJson) return response(404, {}, Buffer.from('{"message":"Not Found"}', "utf8"));
      return response(200, { "content-type": "application/json" }, Buffer.from(releaseJson, "utf8"));
    }
    if (url.toString() === tarballUrl) return response(200, { "content-type": "application/octet-stream" }, release!.tarball);
    if (url.toString() === checksumUrl) return response(200, { "content-type": "text/plain" }, checksumBytes);
    return response(404, {}, Buffer.alloc(0));
  };
  return { resolve, performRequest };
}

function response(status: number, headers: Record<string, string>, body: Buffer): Promise<RawResponse> {
  return Promise.resolve({ status, headers, body });
}

/** `UpgradeFetchDeps` whose `performRequest` always fails: proves a caller never reaches the network by accident. */
export const networkForbiddenDeps: UpgradeFetchDeps = {
  resolve: async () => {
    throw new Error("upgrade-fixtures: DNS resolution must never be reached in a test.");
  },
  performRequest: async () => {
    throw new Error("upgrade-fixtures: the network must never be reached in a test.");
  },
};
