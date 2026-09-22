import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Hono, type MiddlewareHandler } from "hono";
import { hexDigestsEqual, sha256Hex } from "../lib/crypto.ts";
import type { RunnerContext } from "./context.ts";
import { errorResponse } from "./http.ts";
import type { LoadedRouteModule } from "./route-modules.ts";

/**
 * The runner's local UI and its JSON API, for the person's own browser at
 * http://127.0.0.1:4310. Any page they visit (a hostile job posting
 * included) can send requests to 127.0.0.1, and DNS rebinding can make a
 * hostile hostname resolve there. So, besides the Host check every bridge
 * request passes (app.ts):
 *
 * - Sign-in: `npm run runner` (or `npm run ui`) prints a one-time link,
 *   /ui/login?nonce=..., valid 10 minutes (store/ui-login.ts). Opening it
 *   sets the cookie `wc_runner_ui` = the install's UI token (RUNNER_UI_TOKEN
 *   in runner/.env.local): HttpOnly, SameSite=Strict, Path=/, 30 days.
 * - Pages (/ui/<page>) and /api/* need that cookie, compared in constant time.
 * - /api/* answers only what the browser marks `Sec-Fetch-Site: same-origin`
 *   (when the header is present at all), so only the runner's own pages can
 *   use it. That refuses:
 *   - `cross-site` and `same-site`: same-site includes other ports on
 *     127.0.0.1, which the cookie alone cannot tell apart, because cookies
 *     are not scoped by port.
 *   - `none`: Chrome sends the SameSite=Strict cookie with a fetch from any
 *     extension that has host permission for 127.0.0.1:4310, marked `none`
 *     (measured on Chromium 153), and a request typed into the address bar
 *     is `none` too.
 *   Pages and the sign-in link are navigations and keep working with `none`.
 * - State-changing /api/* requests (anything but GET/HEAD) also need an
 *   Origin equal to this server's own origin and a JSON Content-Type, which
 *   an HTML form on another site cannot send.
 * - Every response: nosniff, no referrer, no framing; pages get a CSP that
 *   allows only this origin's own scripts, styles and fonts.
 *
 * Pages are plain HTML files in runner/ui/, assets in runner/ui/assets/. A
 * page that contains `<!-- runner:nav -->` gets the navigation there.
 */
export const UI_COOKIE = "wc_runner_ui";
export const UI_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;
export const PAGE_NAME = /^[a-z][a-z0-9-]*$/;
const ASSET_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NAV_MARKER = "<!-- runner:nav -->";

/** Navigation order and labels for the pages the MVP plans (mvp-spec §6). Other pages join with `<meta name="runner-nav" content="Label">`. */
export const NAV_PAGES: ReadonlyArray<readonly [string, string]> = [
  ["onboarding", "Onboarding"],
  ["profile", "Profile"],
  ["jobs", "Jobs"],
  ["board", "Board"],
  ["sessions", "Sessions"],
  ["runs", "Runs"],
  ["settings", "Settings"],
  ["status", "Status"],
];

export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const SAFE_METHODS = new Set(["GET", "HEAD"]);

export interface LocalUiOptions {
  readonly ctx: RunnerContext;
  readonly modules: readonly LoadedRouteModule[];
  readonly uiDir: string;
  /** RUNNER_UI_TOKEN. Without one (setup not run) nobody can sign in. */
  readonly uiToken: string | undefined;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

function hasUiCookie(request: Request, uiToken: string | undefined): boolean {
  if (!uiToken) return false;
  const presented = readCookie(request.headers.get("cookie"), UI_COOKIE);
  return presented !== undefined && hexDigestsEqual(sha256Hex(presented), sha256Hex(uiToken));
}

function htmlResponse(status: number, html: string, extra: Record<string, string> = {}): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": PAGE_CSP,
      "cross-origin-resource-policy": "same-origin",
      ...extra,
    },
  });
}

function messagePage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Job assistant runner</title>
<link rel="icon" href="data:,"><link rel="stylesheet" href="/ui/assets/runner.css"></head>
<body><main class="page narrow"><h1>${escapeHtml(title)}</h1>${body}</main></body>
</html>
`;
}

const SIGN_IN_PAGE = messagePage(
  "Sign in to the runner",
  `<p>This page is only for the person running the runner on this computer.</p>
<p>Open the sign-in link that <code>npm run runner</code> printed, or run <code>npm run ui</code> in <code>runner/</code> for a new one.</p>`,
);

async function listPages(uiDir: string): Promise<string[]> {
  try {
    return (await readdir(uiDir))
      .filter((file) => file.endsWith(".html"))
      .map((file) => file.slice(0, -".html".length))
      .filter((name) => PAGE_NAME.test(name));
  } catch {
    return [];
  }
}

/** The navigation for the pages present in `uiDir`. */
export async function renderNav(uiDir: string, current: string): Promise<string> {
  const present = new Set(await listPages(uiDir));
  const entries: Array<[string, string]> = NAV_PAGES.filter(([name]) => present.has(name)).map(([name, label]) => [name, label]);
  const known = new Set(NAV_PAGES.map(([name]) => name));
  const extras: Array<[string, string]> = [];
  for (const name of [...present].filter((page) => !known.has(page)).sort()) {
    const html = await readFile(path.join(uiDir, `${name}.html`), "utf8").catch(() => "");
    const label = /<meta\s+name="runner-nav"\s+content="([^"]{1,40})"\s*\/?>/i.exec(html)?.[1];
    if (label) extras.push([name, label]);
  }
  const links = [...entries, ...extras]
    .map(([name, label]) => `<a href="/ui/${name}"${name === current ? ' aria-current="page"' : ""}>${escapeHtml(label)}</a>`)
    .join("");
  return `<nav class="runner-nav" aria-label="Runner">${links}</nav>`;
}

async function insideDirectory(root: string, target: string): Promise<string | undefined> {
  try {
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
    const relative = path.relative(realRoot, realTarget);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    return realTarget;
  } catch {
    return undefined;
  }
}

/** The /api guard: origin checks first (no secret involved), then the cookie. */
function apiGuard(uiToken: string | undefined): MiddlewareHandler {
  return async (c, next) => {
    const request = c.req.raw;
    const site = request.headers.get("sec-fetch-site");
    if (site !== null && site !== "same-origin") {
      return errorResponse(403, "cross_site_request", "The runner's local API only answers its own pages.");
    }
    if (!SAFE_METHODS.has(request.method)) {
      const host = request.headers.get("host");
      const origin = request.headers.get("origin");
      if (!origin || !host || origin !== `http://${host}`) {
        return errorResponse(403, "origin_not_allowed", "State-changing requests must come from the runner's own pages.");
      }
      const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (type !== "application/json") {
        return errorResponse(415, "unsupported_media_type", "Send application/json.");
      }
    }
    if (!hasUiCookie(request, uiToken)) {
      return errorResponse(401, "ui_login_required", "Sign in with the link from `npm run runner` or `npm run ui`.");
    }
    await next();
    c.header("cross-origin-resource-policy", "same-origin");
    if (!c.res.headers.has("cache-control")) c.header("cache-control", "no-store");
  };
}

export function localUi(options: LocalUiOptions): Hono {
  const { ctx, modules, uiDir, uiToken } = options;
  const assetsDir = path.join(uiDir, "assets");
  const app = new Hono();

  app.get("/", (c) => c.redirect("/ui/status", 303));

  app.get("/ui/login", async (c) => {
    if (!uiToken) {
      return htmlResponse(503, messagePage("Setup has not finished", "<p>Run <code>npm run setup</code> in <code>runner/</code>, then start the runner again.</p>"));
    }
    // Hono answers HEAD with this GET handler. HEAD must not redeem: a nonce
    // works once, and a link-preview fetch (a chat client, an email scanner)
    // sends HEAD (sometimes GET) before the person opens the link, which
    // would spend it first. There is no way to check a nonce without
    // consuming it (store/one-time-codes.ts), so HEAD skips the check
    // entirely, the same way HEAD /commands skips the lease.
    if (c.req.method === "HEAD") {
      return new Response(null, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    const nonce = new URL(c.req.url).searchParams.get("nonce") ?? "";
    const result = nonce ? await ctx.uiLogin.redeem(nonce) : "invalid";
    if (result !== "ok") {
      return htmlResponse(
        401,
        messagePage(
          result === "expired" ? "This sign-in link has expired" : "This sign-in link does not work",
          "<p>Sign-in links work once, for 10 minutes. Run <code>npm run ui</code> in <code>runner/</code> for a new one.</p>",
        ),
      );
    }
    return new Response(null, {
      status: 303,
      headers: {
        location: "/ui/status",
        "cache-control": "no-store",
        "set-cookie": `${UI_COOKIE}=${uiToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${UI_COOKIE_MAX_AGE_S}`,
      },
    });
  });

  app.get("/ui/assets/*", async (c) => {
    const rest = c.req.path.slice("/ui/assets/".length);
    const segments = rest.split("/");
    if (segments.length === 0 || !segments.every((segment) => ASSET_SEGMENT.test(segment) && !segment.includes(".."))) {
      return errorResponse(404, "not_found", "No such asset.");
    }
    const contentType = CONTENT_TYPES[path.extname(rest).toLowerCase()];
    const file = contentType ? await insideDirectory(assetsDir, path.join(assetsDir, ...segments)) : undefined;
    if (!file || !contentType) return errorResponse(404, "not_found", "No such asset.");
    const data = await readFile(file);
    return new Response(data, {
      status: 200,
      headers: { "content-type": contentType, "cache-control": "no-cache", "cross-origin-resource-policy": "same-origin" },
    });
  });

  app.get("/ui/:page", async (c) => {
    const page = c.req.param("page");
    if (!PAGE_NAME.test(page)) return errorResponse(404, "not_found", "No such page.");
    const file = await insideDirectory(uiDir, path.join(uiDir, `${page}.html`));
    if (!file) return errorResponse(404, "not_found", "No such page.");
    if (!hasUiCookie(c.req.raw, uiToken)) return htmlResponse(401, SIGN_IN_PAGE);
    let html = await readFile(file, "utf8");
    if (html.includes(NAV_MARKER)) html = html.replace(NAV_MARKER, await renderNav(uiDir, page));
    return htmlResponse(200, html);
  });

  const api = new Hono();
  api.use("*", apiGuard(uiToken));
  for (const { name, module } of modules) {
    if (!module.api) continue;
    const router = new Hono();
    module.api(router, ctx);
    api.route(`/${name}`, router);
  }
  app.route("/api", api);

  return app;
}
