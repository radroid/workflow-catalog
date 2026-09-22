/**
 * Minimal read-only static server for extension/fixtures/*.html, used only
 * by real-popup.spec.ts. The capture flow needs an http(s) page to read --
 * shared/url.ts refuses `file:` outright -- and nothing else in this repo
 * serves these fixtures over HTTP.
 *
 * Listens on port 0, so the OS picks a free ephemeral port and this can
 * never collide with another harness, reviewer, or dev server on the same
 * machine (a fixed port did: a concurrent run already held it). The chosen
 * origin is handed back on the handle; specs build every fixture URL from
 * `handle.origin`, never from a constant. real-popup.spec.ts's afterAll
 * always closes the server, and it binds 127.0.0.1 only.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(here, "../fixtures");

export interface FixtureServerHandle {
  /** e.g. `http://127.0.0.1:54321` -- the port the OS actually assigned. */
  readonly origin: string;
  close(): Promise<void>;
}

export function startFixtureServer(): Promise<FixtureServerHandle> {
  const server: Server = createServer((request, response) => {
    const name = path.basename(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    const file = path.join(fixturesRoot, name);
    if (!name.endsWith(".html") || !existsSync(file)) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(readFileSync(file));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error(`fixture server: expected a TCP address, got ${String(address)}`));
        return;
      }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}
