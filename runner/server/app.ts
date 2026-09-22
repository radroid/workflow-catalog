import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { UI_DIR } from "../lib/paths.ts";
import type { RunnerContext } from "./context.ts";
import { extensionApi } from "./extension-api.ts";
import { errorResponse } from "./http.ts";
import { localUi } from "./local-ui.ts";
import type { LoadedRouteModule, StopFunction } from "./route-modules.ts";

/**
 * The bridge: one Hono app on 127.0.0.1:4310 (loopback only) serving the
 * extension's four routes (extension-api.ts) and the local UI
 * (local-ui.ts). Every request first passes the Host check: the Host header
 * must be exactly 127.0.0.1:4310 or localhost:4310, which is what defeats DNS
 * rebinding (a hostile name resolving to 127.0.0.1 still sends its own name).
 */
export const BRIDGE_HOST = "127.0.0.1";
export const BRIDGE_PORT = 4310;
export const BRIDGE_ORIGIN = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;

export function allowedHostsFor(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

export interface BridgeOptions {
  readonly ctx: RunnerContext;
  readonly modules: readonly LoadedRouteModule[];
  readonly uiToken: string | undefined;
  readonly uiDir?: string;
  readonly port?: number;
}

export function createBridgeApp(options: BridgeOptions): Hono {
  const allowed = new Set(allowedHostsFor(options.port ?? BRIDGE_PORT));
  const app = new Hono();

  app.use("*", async (c, next) => {
    const host = c.req.header("host")?.toLowerCase();
    if (!host || !allowed.has(host)) {
      return errorResponse(403, "host_not_allowed", "The runner only answers requests addressed to 127.0.0.1:4310 or localhost:4310.");
    }
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    c.header("x-frame-options", "DENY");
  });

  app.route("/", extensionApi({ ctx: options.ctx, modules: options.modules }));
  app.route("/", localUi({ ctx: options.ctx, modules: options.modules, uiDir: options.uiDir ?? UI_DIR, uiToken: options.uiToken }));

  app.notFound(() => errorResponse(404, "not_found", "No such route."));
  app.onError((error) => {
    options.ctx.log.error(`Unexpected error: ${error.name}: ${error.message.slice(0, 200)}`);
    return errorResponse(500, "internal_error", "The runner hit an unexpected error.");
  });
  return app;
}

export interface RunningBridge {
  readonly url: string;
  close(): Promise<void>;
}

/** Listens on 127.0.0.1 only. Rejects with a clear message when the port is taken. */
export function listen(app: Hono, port = BRIDGE_PORT): Promise<RunningBridge> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname: BRIDGE_HOST }, () => {
      server.off("error", onError);
      resolve({
        url: `http://${BRIDGE_HOST}:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            // Idle keep-alive sockets must not hold the shutdown open.
            (server as { closeAllConnections?: () => void }).closeAllConnections?.();
          }),
      });
    });
    const onError = (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`Port ${port} on ${BRIDGE_HOST} is already in use. Is another runner running? Stop it first.`)
          : error,
      );
    };
    server.once("error", onError);
  });
}

/** Runs every module's start hook; returns the stop functions in reverse order. */
export async function startModules(ctx: RunnerContext, modules: readonly LoadedRouteModule[]): Promise<StopFunction[]> {
  const stops: StopFunction[] = [];
  for (const { name, module } of modules) {
    if (!module.start) continue;
    try {
      const stop = await module.start(ctx);
      if (typeof stop === "function") stops.unshift(stop);
    } catch (error) {
      throw new Error(`server/routes/${name}.ts failed to start: ${(error as Error).message}`);
    }
  }
  return stops;
}
