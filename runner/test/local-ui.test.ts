import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MINUTE_MS } from "../lib/clock.ts";
import type { DoctorReport } from "../lib/doctor.ts";
import { UI_DIR } from "../lib/paths.ts";
import { PAGE_CSP, UI_COOKIE, renderNav } from "../server/local-ui.ts";
import { loadRouteModules } from "../server/route-modules.ts";
import type { EveGateway } from "../server/eve-gateway.ts";
import { ROUTES_DIR } from "../lib/paths.ts";
import { getBudgetState } from "../store/budget.ts";
import { BRIDGE, UI_TOKEN, makeBridge, tempDir, type TestBridge } from "./helpers.ts";
import { rateLimitedTurn, scriptedEve } from "./scripted-eve.ts";

const COOKIE = `${UI_COOKIE}=${UI_TOKEN}`;
const SAME_ORIGIN = { cookie: COOKIE, origin: BRIDGE, "content-type": "application/json", "sec-fetch-site": "same-origin" };

async function realBridge(extra: { eve?: EveGateway; checklist?: () => Promise<DoctorReport> } = {}): Promise<TestBridge> {
  return makeBridge({ modules: await loadRouteModules(ROUTES_DIR), ...extra });
}

describe("local UI: sign-in", () => {
  it("sets an HttpOnly, SameSite=Strict cookie from a one-time link, then refuses the link", async () => {
    const bridge = await realBridge();
    const { url } = await bridge.ctx.uiLogin.issue(BRIDGE);
    const pathname = url.slice(BRIDGE.length);
    const response = await bridge.request(pathname);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/ui/status");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${UI_COOKIE}=${UI_TOKEN}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    const again = await bridge.request(pathname);
    expect(again.status).toBe(401);
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("answers HEAD without redeeming the link, so a HEAD then a GET still signs in", async () => {
    const bridge = await realBridge();
    const { url } = await bridge.ctx.uiLogin.issue(BRIDGE);
    const pathname = url.slice(BRIDGE.length);
    const head = await bridge.request(pathname, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("set-cookie")).toBeNull();
    // HEAD's answer carries the same security headers as every other page answer.
    expect(head.headers.get("content-security-policy")).toBe(PAGE_CSP);
    expect(head.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(head.headers.get("x-content-type-options")).toBe("nosniff");
    expect(head.headers.get("referrer-policy")).toBe("no-referrer");
    expect(head.headers.get("x-frame-options")).toBe("DENY");
    // The nonce still works: HEAD did not spend it.
    const get = await bridge.request(pathname);
    expect(get.status).toBe(303);
    expect(get.headers.get("location")).toBe("/ui/status");
    expect(get.headers.get("set-cookie") ?? "").toContain(`${UI_COOKIE}=${UI_TOKEN}`);
    // Now the link is spent, HEAD or GET.
    expect((await bridge.request(pathname, { method: "HEAD" })).status).toBe(200);
    const reused = await bridge.request(pathname);
    expect(reused.status).toBe(401);
    expect(reused.headers.get("set-cookie")).toBeNull();
  });

  it("refuses an expired or made-up link", async () => {
    const bridge = await realBridge();
    const { url } = await bridge.ctx.uiLogin.issue(BRIDGE);
    bridge.clock.advance(10 * MINUTE_MS);
    expect((await bridge.request(url.slice(BRIDGE.length))).status).toBe(401);
    expect((await bridge.request("/ui/login?nonce=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).status).toBe(401);
    expect((await bridge.request("/ui/login")).status).toBe(401);
  });

  it("cannot sign anyone in before setup made a UI token", async () => {
    const bridge = await makeBridge({ uiToken: null, modules: await loadRouteModules(ROUTES_DIR) });
    const { url } = await bridge.ctx.uiLogin.issue(BRIDGE);
    expect((await bridge.request(url.slice(BRIDGE.length))).status).toBe(503);
    expect((await bridge.request("/api/status", { headers: { cookie: `${UI_COOKIE}=` } })).status).toBe(401);
  });
});

describe("local UI: pages", () => {
  it("redirects / to the status page", async () => {
    const bridge = await realBridge();
    const response = await bridge.request("/");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/ui/status");
  });

  it("serves a page only with the cookie, with CSP and no framing", async () => {
    const bridge = await realBridge();
    const tokenless = await bridge.request("/ui/status");
    expect(tokenless.status).toBe(401);
    expect(await tokenless.text()).toContain("npm run ui");
    const wrong = await bridge.request("/ui/status", { headers: { cookie: `${UI_COOKIE}=not-the-token` } });
    expect(wrong.status).toBe(401);
    const page = await bridge.request("/ui/status", { headers: { cookie: COOKIE } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toBe(PAGE_CSP);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await page.text();
    expect(html).toContain('<nav class="runner-nav"');
    expect(html).toContain('<a href="/ui/status" aria-current="page">Status</a>');
    expect(html).not.toContain("<!-- runner:nav -->");
  });

  it("serves assets without the cookie, and nothing outside ui/assets", async () => {
    const bridge = await realBridge();
    const css = await bridge.request("/ui/assets/runner.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    const font = await bridge.request("/ui/assets/fonts/Geist-Variable.woff2");
    expect(font.headers.get("content-type")).toBe("font/woff2");
    for (const pathname of ["/ui/assets/../status.html", "/ui/assets/%2e%2e/status.html", "/ui/assets/.hidden.css", "/ui/assets/runner.css.map", "/ui/assets/"]) {
      expect((await bridge.request(pathname)).status, pathname).toBe(404);
    }
    expect((await bridge.request("/ui/..%2fpackage", { headers: { cookie: COOKIE } })).status).toBe(404);
    expect((await bridge.request("/ui/Status", { headers: { cookie: COOKIE } })).status).toBe(404);
  });

  it("does not follow a symlink out of ui/", async () => {
    const uiDir = await tempDir("wc-ui-");
    const outside = await tempDir("wc-outside-");
    await writeFile(path.join(outside, "secret.css"), "body{}");
    await mkdir(path.join(uiDir, "assets"));
    await symlink(path.join(outside, "secret.css"), path.join(uiDir, "assets", "linked.css"));
    await writeFile(path.join(uiDir, "status.html"), "<!doctype html><title>t</title>");
    const bridge = await makeBridge({ uiDir });
    expect((await bridge.request("/ui/assets/linked.css")).status).toBe(404);
    expect((await bridge.request("/ui/status", { headers: { cookie: COOKIE } })).status).toBe(200);
  });

  it("builds the navigation from the pages present, in the planned order", async () => {
    const uiDir = await tempDir("wc-ui-");
    for (const name of ["status", "jobs", "onboarding", "application"]) await writeFile(path.join(uiDir, `${name}.html`), "<!doctype html>");
    await writeFile(path.join(uiDir, "extras.html"), '<meta name="runner-nav" content="Extras">');
    const nav = await renderNav(uiDir, "jobs");
    expect(nav).toBe(
      // P06 (carried from P05's review): Applications is a planned page now, between Jobs and Board.
      '<nav class="runner-nav" aria-label="Runner"><a href="/ui/onboarding">Onboarding</a><a href="/ui/jobs" aria-current="page">Jobs</a><a href="/ui/application">Applications</a><a href="/ui/status">Status</a><a href="/ui/extras">Extras</a></nav>',
    );
    expect(await renderNav(UI_DIR, "status")).toContain("Status");
  });

  it("places Applications between Jobs and Board in the real pages' navigation (P06)", async () => {
    const labels = [...(await renderNav(UI_DIR, "board")).matchAll(/<a href="\/ui\/([a-z-]+)"/g)].map((match) => match[1]);
    expect(labels.indexOf("application")).toBe(labels.indexOf("jobs") + 1);
    expect(labels.indexOf("board")).toBe(labels.indexOf("application") + 1);
    expect(labels.indexOf("sessions")).toBe(labels.indexOf("board") + 1);
  });
});

describe("local UI: JSON API protection", () => {
  it("refuses a wrong Host (DNS rebinding) even with the cookie", async () => {
    const bridge = await realBridge();
    const response = await bridge.request("/api/devices", { headers: { cookie: COOKIE, host: "rebind.attacker.example:4310" } });
    expect(response.status).toBe(403);
  });

  it("refuses tokenless requests with 401", async () => {
    const bridge = await realBridge();
    expect((await bridge.request("/api/devices")).status).toBe(401);
    const post = await bridge.request("/api/pairing/codes", { method: "POST", headers: { origin: BRIDGE, "content-type": "application/json" }, body: "{}" });
    expect(post.status).toBe(401);
    expect(await bridge.ctx.pairing.outstanding()).toBe(0);
  });

  it("refuses cross-origin and same-site (other port) requests with 403, cookie or not", async () => {
    const bridge = await realBridge();
    for (const origin of ["https://jobs.example", "http://127.0.0.1:3000", "http://localhost:4310", "null"]) {
      const response = await bridge.request("/api/pairing/codes", { method: "POST", headers: { ...SAME_ORIGIN, origin }, body: "{}" });
      expect(response.status, origin).toBe(403);
    }
    const noOrigin = await bridge.request("/api/pairing/codes", { method: "POST", headers: { cookie: COOKIE, "content-type": "application/json" }, body: "{}" });
    expect(noOrigin.status).toBe(403);
    for (const site of ["cross-site", "same-site"]) {
      const read = await bridge.request("/api/devices", { headers: { cookie: COOKIE, "sec-fetch-site": site } });
      expect(read.status, site).toBe(403);
    }
    expect(await bridge.ctx.pairing.outstanding()).toBe(0);
  });

  it("answers only Sec-Fetch-Site: same-origin when the header is present, while pages and sign-in still open with none", async () => {
    const bridge = await realBridge();
    // Chrome marks an extension's fetch to 127.0.0.1:4310 `none` and sends the
    // SameSite=Strict cookie with it (Chromium 153): the API must refuse it.
    for (const site of ["none", "cross-site", "same-site"]) {
      const read = await bridge.request("/api/devices", { headers: { cookie: COOKIE, "sec-fetch-site": site, "sec-fetch-mode": "cors" } });
      expect(read.status, site).toBe(403);
      expect(((await read.json()) as { error: { code: string } }).error.code).toBe("cross_site_request");
      const write = await bridge.request("/api/pairing/codes", { method: "POST", headers: { ...SAME_ORIGIN, "sec-fetch-site": site }, body: "{}" });
      expect(write.status, site).toBe(403);
    }
    expect(await bridge.ctx.pairing.outstanding()).toBe(0);
    expect((await bridge.request("/api/devices", { headers: { cookie: COOKIE, "sec-fetch-site": "same-origin" } })).status).toBe(200);
    // Navigations: the sign-in link and a page opened from the address bar or a terminal are `none`.
    const navigate = { "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    const { url } = await bridge.ctx.uiLogin.issue(BRIDGE);
    const login = await bridge.request(url.slice(BRIDGE.length), { headers: navigate });
    expect(login.status).toBe(303);
    const page = await bridge.request("/ui/status", { headers: { ...navigate, cookie: COOKIE } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Runner status");
  });

  it("refuses a form-encoded state change with 415", async () => {
    const bridge = await realBridge();
    const response = await bridge.request("/api/pairing/codes", {
      method: "POST",
      headers: { ...SAME_ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: "a=b",
    });
    expect(response.status).toBe(415);
  });

  it("serves the API to its own signed-in pages", async () => {
    const bridge = await realBridge();
    const issued = await bridge.request("/api/pairing/codes", { method: "POST", headers: SAME_ORIGIN, body: "{}" });
    expect(issued.status).toBe(200);
    const { code } = (await issued.json()) as { code: string };
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    const devices = await bridge.request("/api/devices", { headers: { cookie: COOKIE, "sec-fetch-site": "same-origin" } });
    expect(await devices.json()).toEqual({ devices: [] });
    expect((await bridge.request("/api/nope", { headers: { cookie: COOKIE } })).status).toBe(404);
  });

  it("revokes a device from the API", async () => {
    const bridge = await realBridge();
    const { code } = await bridge.ctx.pairing.issue();
    const paired = (await (
      await bridge.request("/pair", { method: "POST", headers: { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop", "content-type": "application/json" }, body: JSON.stringify({ code }) })
    ).json()) as { deviceId: string; token: string };
    const revoke = await bridge.request(`/api/devices/${paired.deviceId}/revoke`, { method: "POST", headers: SAME_ORIGIN, body: "{}" });
    expect(revoke.status).toBe(200);
    const status = await bridge.request("/status", { headers: { authorization: `Bearer ${paired.token}`, origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" } });
    expect(status.status).toBe(401);
    expect((await bridge.request(`/api/devices/${paired.deviceId}/revoke`, { method: "POST", headers: SAME_ORIGIN, body: "{}" })).status).toBe(404);
  });

  it("reports the checklist and eve on /api/status, and checks the model through eve once per click", async () => {
    let checks = 0;
    const eve = {
      url: "http://127.0.0.1:3210",
      client: undefined as never,
      health: async () => ({ ok: true }),
      modelId: async () => "gpt-5.6-luna",
      checkModel: async () => {
        checks += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ok: true, modelId: "gpt-5.6-luna" };
      },
    } satisfies EveGateway;
    const checklist = async (): Promise<DoctorReport> => ({ ok: true, checkedAt: "2026-09-22T09:00:00.000Z", items: [] });
    const bridge = await realBridge({ eve, checklist });
    const status = (await (await bridge.request("/api/status", { headers: { cookie: COOKIE } })).json()) as Record<string, unknown>;
    expect(status).toMatchObject({ packageVersion: "0.1.0", eve: { ok: true }, checklist: { ok: true } });
    const [a, b] = await Promise.all([
      bridge.request("/api/model/check", { method: "POST", headers: SAME_ORIGIN, body: "{}" }),
      bridge.request("/api/model/check", { method: "POST", headers: SAME_ORIGIN, body: "{}" }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(checks).toBe(1);
    const model = (await (await bridge.request("/api/model", { headers: { cookie: COOKIE } })).json()) as { verified: boolean; lastCheck: { via: string } };
    expect(model.verified).toBe(true);
    expect(model.lastCheck.via).toBe("runner");
  });

  // Q5 (revision 1, reviewer 4), rewritten in revision 2. S3: checkModel is a method of the gateway, which is
  // built before the RunnerContext and holds no ctx, but it runs only inside routes/model.ts's POST
  // /api/model/check, which has one. It calls classifyTurn directly, never runTurn, and the route has no
  // pauseBudget call of its own: neither a model check nor an interactive extraction pauses the budget (Q5).
  // S8: the real checkModel and the real eve Client over a scripted eve (scripted-eve.ts), not a stubbed
  // checkModel, so the provider limit is detected by the real classifier. A scheduled run behind a manual model
  // check must never be refused by a pause the person never asked for.
  it("a provider limit through POST /api/model/check leaves the budget unpaused", async () => {
    const scripted = scriptedEve(rateLimitedTurn());
    try {
      const bridge = await realBridge({ eve: scripted.eve });
      expect((await getBudgetState(bridge.workspace, bridge.clock)).paused).toBe(false);
      const check = await bridge.request("/api/model/check", { method: "POST", headers: SAME_ORIGIN, body: "{}" });
      expect(check.status).toBe(200);
      expect(await check.json()).toMatchObject({ ok: false, detail: "the model's provider is rate-limited right now. Try again later." });
      expect(scripted.sessions()).toBe(1); // one real turn through eve's Client, classified by classifyTurn
      expect((await getBudgetState(bridge.workspace, bridge.clock)).paused).toBe(false);
    } finally {
      scripted.restore();
    }
  });
});
