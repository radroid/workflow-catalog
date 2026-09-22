/**
 * Minimal read-only static server for extension/fixtures/*.html, used only
 * by real-popup.spec.ts. The capture flow needs an http(s) page to read --
 * shared/url.ts refuses `file:` outright -- and nothing else in this repo
 * serves these fixtures over HTTP.
 *
 * Port 3107 is fixed, not ephemeral: it's the port CLAUDE.md's revision
 * checklist names for a post-hoc cleanup check
 * (`lsof -ti tcp:3107 -sTCP:LISTEN | xargs kill`). real-popup.spec.ts's
 * own afterAll always closes this server; that checklist step is a
 * deliberate second line of defense for a process that got killed before
 * its own cleanup ran, not the primary way this gets shut down.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(here, "../fixtures");

export const FIXTURE_SERVER_PORT = 3107;
export const FIXTURE_SERVER_ORIGIN = `http://127.0.0.1:${FIXTURE_SERVER_PORT}`;

export interface FixtureServerHandle {
  close(): Promise<void>;
}

export function startFixtureServer(): Promise<FixtureServerHandle> {
  const server: Server = createServer((request, response) => {
    const name = path.basename(new URL(request.url ?? "/", FIXTURE_SERVER_ORIGIN).pathname);
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
    server.listen(FIXTURE_SERVER_PORT, "127.0.0.1", () => {
      resolve({
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}
