// G1 and I1 regression tests against the *real* eve@0.63.0 `Client`, with global `fetch` stubbed by a scripted
// fake eve server — no port is bound and nothing live is contacted. Adapted from the round-1 and round-2 reviewers'
// probes (logs/handoff/P08-A-round-1-review.md, logs/handoff/P08-A-round-2-review.md; /tmp/p08a-review/,
// /tmp/p08a-r2-review/). They cover:
//   - I1: the P02 spike's exact normal sequences (docs/spec/research/eve-spike.md): a conversation turn ends
//     `turn.completed → session.waiting` and is ok; a task-mode turn ends `session.completed` and is ok too. Only a
//     non-empty `input.requested` list parks a turn; `turn.cancelled` and failure events are not ok.
//   - G1: the abort points where eve's client ends a turn quietly (eve-runtime.md §8 item 15), each keeping the
//     partial usage and model read before the abort (I3, nit 2), and each sending one real cancel through
//     `ClientSession.cancel()` (`POST .../session/:id/cancel`), never the no-op-prone `MessageResponse.cancel()`.
//   - I3 (nit 4): the cancel is bounded, so an eve that never answers it can't hang the run.
import { Client } from "eve/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManualClock } from "../lib/clock.ts";
import { createRunnerContext, silentLogger } from "../server/context.ts";
import type { EveGateway } from "../server/eve-gateway.ts";
import { CANCEL_TIMEOUT_MS, runTurn, withRun } from "../server/run-harness.ts";
import { getRun, hasSucceededWithIdempotencyKey } from "../store/runs.ts";
import { newWorkspace } from "./helpers.ts";

const HOST = "http://127.0.0.1:3210"; // never contacted: fetch is stubbed
const SESSION = "s-probe";
const enc = new TextEncoder();
let seq = 0;
const ev = (type: string, data: Record<string, unknown>) => ({ type, data, meta: { at: "2026-09-22T09:00:00.000Z", id: `evt-${String(seq++).padStart(5, "0")}` } });
const line = (o: unknown) => enc.encode(`${JSON.stringify(o)}\n`);
const WAITING = () => ev("session.waiting", { continuationToken: SESSION, wait: "next-user-message" });

type Plan =
  | "normal-conversation"
  | "normal-task"
  | "failed-conversation"
  | "cancelled-elsewhere"
  | "parked"
  | "events-then-hang-read"
  | "lease-end-then-hang-reopen"
  | "hang-open"
  | "open-503-backoff"
  | "idle-stall"
  | "hang-open-and-cancel";

/** A scripted fake eve HTTP server, stood up entirely through a stubbed `fetch` — no port, no process. */
function stubEve(plan: Plan) {
  const requests: string[] = [];
  let streamOpens = 0;
  let cancels = 0;
  let cancelSignal: AbortSignal | undefined;
  const fake = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const signal = init.signal ?? undefined;
    requests.push(`${method} ${url.pathname}${url.search}`);
    const hang = () =>
      new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    if (method === "POST" && url.pathname === "/eve/v1/session") {
      return new Response(JSON.stringify({ ok: true, sessionId: SESSION }), { status: 202, headers: { "content-type": "application/json", "x-eve-session-id": SESSION } });
    }
    if (method === "POST" && url.pathname === `/eve/v1/session/${SESSION}/cancel`) {
      cancels += 1;
      cancelSignal = signal;
      if (plan === "hang-open-and-cancel") return hang(); // a stalled eve that never answers the cancel either
      return new Response(JSON.stringify({ ok: true, sessionId: SESSION, status: "accepted" }), { status: 202, headers: { "content-type": "application/json" } });
    }
    if (method === "GET" && url.pathname === `/eve/v1/session/${SESSION}/stream`) {
      streamOpens += 1;
      if (plan === "hang-open" || plan === "hang-open-and-cancel") return hang();
      if (plan === "open-503-backoff") return new Response("busy", { status: 503 }); // the client backs off and retries
      if (plan === "lease-end-then-hang-reopen" && streamOpens > 1) return hang();
      if (plan === "idle-stall" && streamOpens > 1) return hang(); // the stalled server never answers the reconnect either
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const push = (o: unknown) => controller.enqueue(line(o));
          controller.enqueue(enc.encode("\n"));
          if (plan === "normal-conversation" || plan === "normal-task") {
            // The exact sequence the P02 spike recorded against real eve (eve-spike.md: run 2 ends session.waiting;
            // the A2 cron fire, a task-mode session, ends session.completed).
            push(ev("session.started", {}));
            push(ev("turn.started", { sequence: 0, turnId: "t1" }));
            push(ev("message.received", { message: "go", parts: [{ type: "text", text: "go" }], sequence: 1, turnId: "t1" }));
            push(ev("step.started", { modelId: "probe-model", sequence: 2, stepIndex: 0, turnId: "t1" }));
            push(ev("message.appended", { messageDelta: "pong", sequence: 3, stepIndex: 0, turnId: "t1" }));
            push(ev("message.completed", { message: "pong", finishReason: "stop", sequence: 4, stepIndex: 0, turnId: "t1" }));
            push(ev("step.completed", { finishReason: "stop", sequence: 5, stepIndex: 0, turnId: "t1", usage: { inputTokens: 11, outputTokens: 2 } }));
            push(ev("turn.completed", { sequence: 6, turnId: "t1" }));
            push(plan === "normal-conversation" ? WAITING() : ev("session.completed", {}));
            controller.close();
            return;
          }
          if (plan === "failed-conversation") {
            // eve's recoverable failure in a conversation (harness/emission.js emitRecoverableFailedTurn).
            push(ev("turn.started", { sequence: 0, turnId: "t1" }));
            push(ev("step.started", { modelId: "probe-model", sequence: 1, stepIndex: 0, turnId: "t1" }));
            push(ev("step.failed", { code: "MODEL_CALL_FAILED", message: "Model provider API request failed (HTTP 400).", details: { statusCode: 400 }, sequence: 2, stepIndex: 0, turnId: "t1" }));
            push(ev("turn.failed", { code: "MODEL_CALL_FAILED", message: "Model provider API request failed (HTTP 400).", details: { statusCode: 400 }, sequence: 3, turnId: "t1" }));
            push(WAITING());
            controller.close();
            return;
          }
          if (plan === "cancelled-elsewhere") {
            push(ev("turn.started", { sequence: 0, turnId: "t1" }));
            push(ev("step.started", { modelId: "probe-model", sequence: 1, stepIndex: 0, turnId: "t1" }));
            push(ev("turn.cancelled", { sequence: 2, turnId: "t1" }));
            push(WAITING());
            controller.close();
            return;
          }
          push(ev("turn.started", { sequence: 0, turnId: "t1" }));
          push(ev("step.started", { modelId: "probe-model", sequence: 1, stepIndex: 0, turnId: "t1" }));
          if (plan === "idle-stall") {
            // Then silence forever: no heartbeat, no close (a stalled eve). The client's own 15s idle-reconnect
            // fires before our timeout, and *that* reconnect is what our abort actually lands inside.
            return;
          }
          push(ev("step.completed", { finishReason: "tool-calls", sequence: 2, stepIndex: 0, turnId: "t1", usage: { inputTokens: 7, outputTokens: 3 } }));
          if (plan === "lease-end-then-hang-reopen") {
            // eve's server ends every stream lease after 60s (eve-channel/request.js, 6e4) and the client reconnects.
            push({ $eve: "stream.lease-ended", version: 1 });
            controller.close();
            return;
          }
          if (plan === "parked") {
            push(
              ev("input.requested", {
                requests: [{ action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "ask_question" }, kind: "question", prompt: "Which saved Northwind Labs job first?", requestId: "req-1" }],
                sequence: 3,
                stepIndex: 0,
                turnId: "t1",
              }),
            );
            push(WAITING());
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
  return { eve, requests, cancels: () => cancels, cancelSignal: () => cancelSignal, streamOpens: () => streamOpens };
}

async function ctxWith(eve: EveGateway) {
  const clock = new ManualClock();
  const workspace = await newWorkspace(clock);
  return { ctx: createRunnerContext({ workspace, clock, packageVersion: "0.1.0", eve, log: silentLogger }), workspace, clock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runTurn against the real eve@0.63.0 client: what a finished turn looks like (I1)", () => {
  it("the spike's normal conversation sequence (turn.completed → session.waiting) is ok, with 0 cancels", async () => {
    const fake = stubEve("normal-conversation");
    const { ctx } = await ctxWith(fake.eve);
    const result = await runTurn(ctx, { message: "go", timeoutMs: 5_000 });
    expect(result).toEqual({ status: "ok", tokens: { input: 11, output: 2 }, model: "probe-model" });
    expect(fake.cancels()).toBe(0);
    expect(fake.requests.some((request) => request.endsWith("/cancel"))).toBe(false);
  });

  it("through withRun, that turn records success, and the idempotency lookup then says done", async () => {
    const fake = stubEve("normal-conversation");
    const { ctx, workspace, clock } = await ctxWith(fake.eve);
    const record = await withRun(ctx, { kind: "prepare_newly_saved_jobs", idempotencyKey: "job-ada-quill-northwind", isCatchUp: false }, async (c) => ({ turns: [await runTurn(c, { message: "prepare", timeoutMs: 5_000 })] }));
    const onDisk = await getRun(workspace, record.runId);
    expect(onDisk).toMatchObject({ outcome: "success", model: "probe-model", tokens: { input: 11, output: 2 } });
    expect(onDisk?.error).toBeUndefined();
    expect(await hasSucceededWithIdempotencyKey(workspace, clock, "job-ada-quill-northwind")).toBe(true);
    expect(fake.cancels()).toBe(0);
  });

  it("the spike's task-mode sequence (turn.completed → session.completed) is ok too", async () => {
    const fake = stubEve("normal-task");
    const { ctx } = await ctxWith(fake.eve);
    const result = await runTurn(ctx, { message: "go", timeoutMs: 5_000 });
    expect(result).toEqual({ status: "ok", tokens: { input: 11, output: 2 }, model: "probe-model" });
    expect(fake.cancels()).toBe(0);
  });

  it("a failed conversation turn (step.failed → turn.failed → session.waiting) is 'failed', with no cancel", async () => {
    const fake = stubEve("failed-conversation");
    const { ctx } = await ctxWith(fake.eve);
    const result = await runTurn(ctx, { message: "go", timeoutMs: 5_000 });
    expect(result).toMatchObject({ status: "failed", model: "probe-model", providerLimit: false });
    expect(result.detail).toContain("MODEL_CALL_FAILED");
    expect(fake.cancels()).toBe(0);
  });

  it("turn.cancelled then session.waiting is not ok: 'cancelled', with no cancel of our own", async () => {
    const fake = stubEve("cancelled-elsewhere");
    const { ctx } = await ctxWith(fake.eve);
    const result = await runTurn(ctx, { message: "go", timeoutMs: 5_000 });
    expect(result).toMatchObject({ status: "cancelled", model: "probe-model" });
    expect(fake.cancels()).toBe(0);
  });

  it("waiting on the person: input.requested then session.waiting is 'parked', with one real cancel (MessageResponse.cancel() would send nothing here)", async () => {
    const fake = stubEve("parked");
    const { ctx } = await ctxWith(fake.eve);
    const result = await runTurn(ctx, { message: "go", timeoutMs: 5_000 });
    expect(result).toMatchObject({ status: "parked", tokens: { input: 7, output: 3 }, model: "probe-model" });
    expect(fake.cancels()).toBe(1);
  });
});

describe("runTurn against the real eve@0.63.0 client: the abort points (G1), keeping partial usage and model (I3)", () => {
  it("control: abort while reading an already-open stream -> throws -> 'timeout' with one real cancel", async () => {
    const fake = stubEve("events-then-hang-read");
    const { ctx } = await ctxWith(fake.eve);
    const result = await runTurn(ctx, { message: "go", timeoutMs: 300 });
    expect(result.status).toBe("timeout");
    expect(result.tokens).toEqual({ input: 7, output: 3 }); // partial usage from before the abort survives
    expect(result.model).toBe("probe-model"); // and so does the model id
    expect(fake.cancels()).toBe(1); // a real POST .../cancel, not just a called-but-no-op response.cancel()
  });

  it("abort point 1 of 3 — before the stream opens: quiet end (no throw), still classified 'timeout' with a real cancel", async () => {
    const fake = stubEve("hang-open");
    const { ctx } = await ctxWith(fake.eve);
    const result = await runTurn(ctx, { message: "go", timeoutMs: 300 });
    expect(result.status).toBe("timeout"); // the bug this replaces: the old code trusted result() and said "ok"
    expect(result.tokens).toEqual({ input: 0, output: 0 });
    expect(result.model).toBeUndefined(); // nothing was read before the abort
    expect(fake.cancels()).toBe(1);
  });

  it("abort point 2 of 3 — during the routine (lease-end) reconnect: quiet end, 'timeout' with a real cancel, and the withRun record keeps the partial usage and model", async () => {
    const fake = stubEve("lease-end-then-hang-reopen");
    const { ctx, workspace, clock } = await ctxWith(fake.eve);
    const turns: Awaited<ReturnType<typeof runTurn>>[] = [];
    const record = await withRun(ctx, { kind: "prepare_newly_saved_jobs", idempotencyKey: "job-ada-quill-northwind", isCatchUp: false }, async (c) => {
      turns.push(await runTurn(c, { message: "prepare", timeoutMs: 300 }));
      return { turns };
    });
    expect(turns[0]).toMatchObject({ status: "timeout", tokens: { input: 7, output: 3 }, model: "probe-model" });
    const onDisk = await getRun(workspace, record.runId);
    expect(onDisk).toMatchObject({ outcome: "failure", tokens: { input: 7, output: 3 }, model: "probe-model", error: "No answer within 0.3 s." }); // not "success" — the bug this replaces
    expect(await hasSucceededWithIdempotencyKey(workspace, clock, "job-ada-quill-northwind")).toBe(false); // so a later duplicate-prevention check is never fooled
    expect(fake.cancels()).toBe(1);
  });

  it("abort during the open-retry backoff (eve answers 503): quiet end, 'timeout' with a real cancel", async () => {
    const fake = stubEve("open-503-backoff");
    const { ctx } = await ctxWith(fake.eve);
    const result = await runTurn(ctx, { message: "go", timeoutMs: 900 });
    expect(result).toMatchObject({ status: "timeout", tokens: { input: 0, output: 0 } });
    expect(result.model).toBeUndefined();
    expect(fake.streamOpens()).toBeGreaterThan(1); // the client really did back off and retry before the abort
    expect(fake.cancels()).toBe(1);
  });

  it("abort point 3 of 3 — during an idle reconnect (15s idle timeout fires before our deadline): 'timeout' with a real cancel, the model kept", { timeout: 40_000 }, async () => {
    const fake = stubEve("idle-stall");
    const { ctx } = await ctxWith(fake.eve);
    const started = performance.now();
    const result = await runTurn(ctx, { message: "prepare", timeoutMs: 17_000 });
    expect(result.status).toBe("timeout");
    expect(result.tokens).toEqual({ input: 0, output: 0 });
    expect(result.model).toBe("probe-model"); // step.started arrived before the stall
    expect(performance.now() - started).toBeGreaterThan(16_000); // genuinely rode out the idle reconnect, not a fast short-circuit
    expect(fake.streamOpens()).toBe(2);
    expect(fake.cancels()).toBe(1);
  });
});

describe("runTurn against the real eve@0.63.0 client: the cancel is bounded (I3, nit 4)", () => {
  it("an eve that never answers the cancel POST: runTurn still resolves 'timeout' once CANCEL_TIMEOUT_MS passes, and the cancel request carried an abort signal", { timeout: 15_000 }, async () => {
    const fake = stubEve("hang-open-and-cancel");
    const { ctx } = await ctxWith(fake.eve);
    const started = performance.now();
    const result = await runTurn(ctx, { message: "prepare", timeoutMs: 300 });
    const elapsed = performance.now() - started;
    expect(result.status).toBe("timeout");
    expect(fake.cancels()).toBe(1);
    expect(fake.cancelSignal()?.aborted).toBe(true); // the bound fired: this is what freed runTurn
    expect(elapsed).toBeGreaterThanOrEqual(300 + CANCEL_TIMEOUT_MS - 100);
    expect(elapsed).toBeLessThan(300 + CANCEL_TIMEOUT_MS + 3_000);
  });
});
