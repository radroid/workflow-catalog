// G1 (round-1 revision, reviewer issue 1; eve-runtime.md §8 item 15): regression tests against the *real*
// eve@0.63.0 `Client`, with global `fetch` stubbed by a scripted fake eve server — no port is bound and nothing
// live is contacted. Adapted from the round-1 reviewer's probes (logs/handoff/P08-A-round-1-review.md,
// /tmp/p08a-review/in-tree-probes/). These are the three abort points G1 names plus the two turn shapes
// (a normally-open-stream abort, and a clean park) needed to show `runTurn` classifies every one of them
// correctly and only ever cancels through the real `ClientSession.cancel()` (`POST .../session/:id/cancel`),
// never the no-op-prone `MessageResponse.cancel()`.
import { Client } from "eve/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManualClock } from "../lib/clock.ts";
import { createRunnerContext, silentLogger } from "../server/context.ts";
import type { EveGateway } from "../server/eve-gateway.ts";
import { runTurn, withRun } from "../server/run-harness.ts";
import { getRun, hasSucceededWithIdempotencyKey } from "../store/runs.ts";
import { newWorkspace } from "./helpers.ts";

const HOST = "http://127.0.0.1:3210"; // never contacted: fetch is stubbed
const SESSION = "s-probe";
const enc = new TextEncoder();
let seq = 0;
const ev = (type: string, data: Record<string, unknown>) => ({ type, data, meta: { at: "2026-09-22T09:00:00.000Z", id: `evt-${String(seq++).padStart(5, "0")}` } });
const line = (o: unknown) => enc.encode(`${JSON.stringify(o)}\n`);

type Plan = "lease-end-then-hang-reopen" | "hang-open" | "events-then-hang-read" | "parked" | "idle-stall";

/** A scripted fake eve HTTP server, stood up entirely through a stubbed `fetch` — no port, no process. */
function stubEve(plan: Plan) {
  const requests: string[] = [];
  let streamOpens = 0;
  let cancels = 0;
  const fake = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const signal = init.signal ?? undefined;
    requests.push(`${method} ${url.pathname}${url.search}`);
    if (method === "POST" && url.pathname === "/eve/v1/session") {
      return new Response(JSON.stringify({ ok: true, sessionId: SESSION }), { status: 202, headers: { "content-type": "application/json", "x-eve-session-id": SESSION } });
    }
    if (method === "POST" && url.pathname === `/eve/v1/session/${SESSION}/cancel`) {
      cancels += 1;
      return new Response(JSON.stringify({ ok: true, sessionId: SESSION, status: "accepted" }), { status: 202, headers: { "content-type": "application/json" } });
    }
    if (method === "GET" && url.pathname === `/eve/v1/session/${SESSION}/stream`) {
      streamOpens += 1;
      const hang = () =>
        new Promise<Response>((_resolve, reject) => {
          if (signal?.aborted) return reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      if (plan === "hang-open") return hang();
      if (plan === "lease-end-then-hang-reopen" && streamOpens > 1) return hang();
      if (plan === "idle-stall" && streamOpens > 1) return hang(); // the stalled server never answers the reconnect either
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode("\n"));
          controller.enqueue(line(ev("turn.started", { sequence: 0, turnId: "t1" })));
          controller.enqueue(line(ev("step.started", { modelId: "probe-model", sequence: 1, stepIndex: 0, turnId: "t1" })));
          if (plan === "idle-stall") {
            // Then silence forever: no heartbeat, no close (a stalled eve). The client's own 15s idle-reconnect
            // fires before our timeout, and *that* reconnect is what our abort actually lands inside.
            return;
          }
          controller.enqueue(line(ev("step.completed", { finishReason: "tool-calls", sequence: 2, stepIndex: 0, turnId: "t1", usage: { inputTokens: 7, outputTokens: 3 } })));
          if (plan === "lease-end-then-hang-reopen") {
            // eve's server ends every stream lease after 60s (eve-channel/request.js, 6e4) and the client reconnects.
            controller.enqueue(line({ $eve: "stream.lease-ended", version: 1 }));
            controller.close();
            return;
          }
          if (plan === "parked") {
            controller.enqueue(line(ev("input.requested", { requests: [{ kind: "text", id: "q1", prompt: "Which job?" }], sequence: 3, turnId: "t1" })));
            controller.enqueue(line(ev("session.waiting", { continuationToken: SESSION, wait: "next-user-message" })));
            controller.close();
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              try {
                controller.error(signal.reason);
              } catch {
                /* closed */
              }
            },
            { once: true },
          );
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson", "x-eve-stream-version": "25" } });
    }
    return new Response("not found", { status: 404 });
  };
  vi.stubGlobal("fetch", fake);
  const client = new Client({ host: HOST, redirect: "manual" });
  const eve: EveGateway = { url: HOST, client, health: async () => ({ ok: true }), modelId: async () => undefined, checkModel: async () => ({ ok: true }) };
  return { eve, requests, cancels: () => cancels, streamOpens: () => streamOpens };
}

async function ctxWith(eve: EveGateway) {
  const clock = new ManualClock();
  const workspace = await newWorkspace(clock);
  return { ctx: createRunnerContext({ workspace, clock, packageVersion: "0.1.0", eve, log: silentLogger }), workspace, clock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runTurn against the real eve@0.63.0 client: the three abort points (G1)", () => {
  it("control: abort while reading an already-open stream -> throws -> 'timeout' with one real cancel", async () => {
    const fake = stubEve("events-then-hang-read");
    const { ctx } = await ctxWith(fake.eve);
    const result = await runTurn(ctx, { message: "go", timeoutMs: 300 });
    expect(result.status).toBe("timeout");
    expect(result.tokens).toEqual({ input: 7, output: 3 }); // partial usage from before the abort survives
    expect(fake.cancels()).toBe(1); // a real POST .../cancel, not just a called-but-no-op response.cancel()
  });

  it("abort point 1 of 3 — before the stream opens: quiet end (no throw), still classified 'timeout' with a real cancel", async () => {
    const fake = stubEve("hang-open");
    const { ctx } = await ctxWith(fake.eve);
    const result = await runTurn(ctx, { message: "go", timeoutMs: 300 });
    expect(result.status).toBe("timeout"); // the bug this replaces: the old code trusted result() and said "ok"
    expect(result.tokens).toEqual({ input: 0, output: 0 });
    expect(fake.cancels()).toBe(1);
  });

  it("abort point 2 of 3 — during the routine (lease-end) reconnect: quiet end, 'timeout' with a real cancel and the withRun record is honest", async () => {
    const fake = stubEve("lease-end-then-hang-reopen");
    const { ctx, workspace, clock } = await ctxWith(fake.eve);
    const record = await withRun(ctx, { kind: "prepare_newly_saved_jobs", idempotencyKey: "job-ada-quill-northwind", isCatchUp: false }, async (c) => ({ turns: [await runTurn(c, { message: "prepare", timeoutMs: 300 })] }));
    const onDisk = await getRun(workspace, record.runId);
    const done = await hasSucceededWithIdempotencyKey(workspace, clock, "job-ada-quill-northwind");
    expect(onDisk?.outcome).toBe("failure"); // not "success" — the bug this replaces
    expect(done).toBe(false); // so a later duplicate-prevention check is never fooled
    expect(fake.cancels()).toBe(1);
  });

  it("abort point 3 of 3 — during an idle reconnect (15s idle timeout fires before our deadline): 'timeout' with a real cancel", { timeout: 40_000 }, async () => {
    const fake = stubEve("idle-stall");
    const { ctx } = await ctxWith(fake.eve);
    const started = performance.now();
    const result = await runTurn(ctx, { message: "prepare", timeoutMs: 17_000 });
    expect(result.status).toBe("timeout");
    expect(performance.now() - started).toBeGreaterThan(16_000); // genuinely rode out the idle reconnect, not a fast short-circuit
    expect(fake.cancels()).toBe(1);
  });

});

describe("runTurn against the real eve@0.63.0 client: a clean park", () => {
  it("session.waiting after input.requested: 'parked' with one real cancel (MessageResponse.cancel() would send nothing here)", async () => {
    const fake = stubEve("parked");
    const { ctx } = await ctxWith(fake.eve);
    const result = await runTurn(ctx, { message: "go", timeoutMs: 5_000 });
    expect(result.status).toBe("parked");
    expect(fake.cancels()).toBe(1);
  });
});
