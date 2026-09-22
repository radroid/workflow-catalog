/**
 * The bridge surface (mvp-spec §5: `POST /pair`, `GET /commands`,
 * `POST /events`, `GET /status`, all on `127.0.0.1:4310`) behind one
 * interface. Part A shipped only `stubBridgeClient` (no network, ever).
 * Part B replaces it with `createBridgeClient()`, a real `fetch`-backed
 * implementation -- no caller needed to change, since both shapes satisfy
 * the same `BridgeClient` interface.
 *
 * Every method still resolves, never throws: a caller only ever inspects
 * `.ok`. Chrome sets `Origin` itself on every request this makes (a POST
 * gets `chrome-extension://<id>`, a GET gets none) -- `Origin` is a
 * forbidden header name, so this never sets it, per mvp-spec §5 and
 * runner/README.md's "The bridge".
 */
import {
  commandsResponseSchema,
  pairResponseSchema,
  statusResponseSchema,
  type CommandsResponse,
  type EventsRequest,
  type PairRequest,
  type PairResponse,
  type StatusResponse,
} from "@workflow-catalog/contracts";
import { clearDeviceToken, getDeviceToken, setPairingOriginMismatch } from "./storage";

/** Loopback only (mvp-spec §5); the manifest's one host permission. */
export const BRIDGE_ORIGIN = "http://127.0.0.1:4310";

/**
 * The bridge's own error shape (runner/server/http.ts `ErrorBody`), carried
 * through instead of collapsed into a string -- P07 packet part B, deliverable
 * 4: "BridgeClient failures carry the HTTP status and error code, not just a
 * message." `status` is absent when no HTTP response was ever received
 * (`network_error`) or no request was attempted at all (`not_paired`).
 */
export interface BridgeError {
  readonly status?: number;
  readonly code: string;
  readonly message: string;
  /** From the response's own `Retry-After` header (seconds), when present
   * -- currently only `/pair`'s 429 `too_many_attempts` sends one
   * (runner/server/extension-api.ts). P07-B revision 1, B8: lets the
   * options page say "try again in about N minutes" instead of a vague
   * "wait". */
  readonly retryAfterSeconds?: number;
}

export type BridgeResult<T> = { ok: true; value: T } | { ok: false; error: BridgeError };

export interface PostEventResult {
  /** True when the bridge recognized this eventId as one it already
   * processed (runner/README.md "Replay") -- still a success: the same
   * job_capture sent twice must show "saved" once, not an error the second
   * time. */
  readonly duplicate: boolean;
}

export interface BridgeClient {
  pair(request: PairRequest): Promise<BridgeResult<PairResponse>>;
  postEvent(request: EventsRequest): Promise<BridgeResult<PostEventResult>>;
  getCommands(since?: string): Promise<BridgeResult<CommandsResponse>>;
  getStatus(): Promise<BridgeResult<StatusResponse>>;
}

const NETWORK_ERROR: BridgeError = {
  code: "network_error",
  message: "Can't reach the runner. Is it running? Start it with `npm run runner`.",
};

/** P07-B revision 1, B4: distinguished from NETWORK_ERROR's "is it running"
 * wording -- a request that connected but never answered is a different
 * fact for a person debugging it than one that never connected at all,
 * even though both are `code: "network_error"` (the outbox/popup still
 * queue-and-retry both exactly the same way, see shared/outbox.ts). */
const TIMEOUT_ERROR: BridgeError = {
  code: "network_error",
  message: "The runner isn't responding.",
};

/** A runner that accepts the TCP connection but never answers must not
 * leave "Pairing…"/"Saving…" disabled forever (P07-B revision 1, B4). */
const REQUEST_TIMEOUT_MS = 5000;

const NOT_PAIRED: BridgeError = {
  code: "not_paired",
  message: "This device isn't paired yet. Pair it above first.",
};

function invalidResponse(what: string): BridgeError {
  return { code: "invalid_response", message: `The runner's ${what} response didn't match the expected shape.` };
}

interface WireErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

/** True for the bridge's own error envelope (runner/server/http.ts
 * `errorBody`): `{ ok: false, error: { code, message, issues? } }`. Checked
 * structurally, not by trusting a `Content-Type` header alone. */
function looksLikeWireErrorBody(value: unknown): value is WireErrorBody {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const error = (value as { error?: unknown }).error;
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

/**
 * Sends one request and classifies the outcome instead of ever throwing.
 * `fetch` rejecting (no HTTP response at all -- DNS/connection refused,
 * which is what "the runner isn't running" looks like from a page's own
 * fetch) becomes `network_error`. An HTTP error response's own `{ code,
 * message }` is carried through verbatim: the bridge already writes a
 * clear, specific message for every 4xx it sends (401 `token_invalid`, 403
 * `origin_not_allowed`, 429 `too_many_attempts`, ...), so this never
 * invents its own wording for those.
 */
async function request(baseUrl: string, path: string, init: RequestInit): Promise<BridgeResult<unknown>> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    // AbortSignal.timeout's own abort reason is a DOMException named
    // "TimeoutError" (WHATWG signal-abort/timeout spec); fetch rejects with
    // that same reason. Nothing else here ever aborts this request, so any
    // other rejection (typically a TypeError "Failed to fetch") is a real
    // connection failure, not a slow answer.
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    return { ok: false, error: timedOut ? TIMEOUT_ERROR : NETWORK_ERROR };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (response.ok) {
    return { ok: true, value: body };
  }
  const rawRetryAfter = response.headers.get("retry-after");
  const retryAfterSeconds = rawRetryAfter !== null && /^\d+$/.test(rawRetryAfter) ? Number(rawRetryAfter) : undefined;
  if (looksLikeWireErrorBody(body)) {
    return { ok: false, error: { status: response.status, code: body.error.code, message: body.error.message, retryAfterSeconds } };
  }
  return {
    ok: false,
    error: {
      status: response.status,
      code: "unknown_error",
      message: `The runner answered with an unexpected error (HTTP ${response.status}).`,
      retryAfterSeconds,
    },
  };
}

export interface CreateBridgeClientOptions {
  readonly baseUrl?: string;
  /** Overridable for tests only; defaults to shared/storage.ts's getDeviceToken. */
  readonly getToken?: () => Promise<{ token: string } | null>;
  /**
   * Called once whenever an authenticated request comes back 401
   * (`token_invalid`: unknown, revoked or expired) -- overridable for
   * tests only; defaults to shared/storage.ts's `clearDeviceToken`. P07-B
   * revision 1, B3: a dead token must stop being offered as "paired"
   * anywhere in the UI, not just get a one-time error message -- clearing
   * it here, in the one place every authenticated route already funnels
   * through, means Pairing and Status both naturally show "not paired" on
   * their next render, wherever the 401 was actually observed.
   */
  readonly onTokenInvalid?: () => Promise<void>;
  /**
   * Called once whenever an authenticated request comes back 403
   * (`origin_not_allowed`) -- overridable for tests only; defaults to
   * shared/storage.ts's `setPairingOriginMismatch(true)`. P07-B revision 1,
   * B3: `GET /status` never carries an Origin header (Chrome doesn't send
   * one on a GET), so the options page's own status check can never itself
   * observe this -- this is the only channel that lets it react to a 403
   * `job_capture`'s `POST /events` saw.
   */
  readonly onOriginMismatch?: () => Promise<void>;
}

/** The real, `fetch`-backed `BridgeClient`. */
export function createBridgeClient(options: CreateBridgeClientOptions = {}): BridgeClient {
  const baseUrl = options.baseUrl ?? BRIDGE_ORIGIN;
  const getToken = options.getToken ?? getDeviceToken;
  const onTokenInvalid = options.onTokenInvalid ?? clearDeviceToken;
  const onOriginMismatch = options.onOriginMismatch ?? (() => setPairingOriginMismatch(true));

  async function authedRequest(path: string, init: RequestInit = {}): Promise<BridgeResult<unknown>> {
    const stored = await getToken();
    if (!stored) return { ok: false, error: NOT_PAIRED };
    const result = await request(baseUrl, path, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${stored.token}` },
    });
    if (!result.ok) {
      if (result.error.status === 401) await onTokenInvalid();
      else if (result.error.status === 403) await onOriginMismatch();
    }
    return result;
  }

  return {
    async pair(pairRequest) {
      const result = await request(baseUrl, "/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pairRequest),
      });
      if (!result.ok) return result;
      const parsed = pairResponseSchema.safeParse(result.value);
      if (!parsed.success) return { ok: false, error: invalidResponse("pairing") };
      return { ok: true, value: parsed.data };
    },

    async postEvent(event) {
      const result = await authedRequest("/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
      if (!result.ok) return result;
      // P07-B revision 1, B4: a capture counts as delivered only when the
      // body itself says so -- not just a 2xx status. Whatever answers on
      // 127.0.0.1:4310 might not be this bridge at all (another local
      // process bound to the port before the runner started); trusting any
      // 200 there would silently empty the outbox of a capture nothing
      // real ever received. `eventId` echoing the one just sent, not just
      // `ok: true`, additionally rules out a genuine bridge response meant
      // for a different, unrelated request.
      const value = result.value as { ok?: unknown; eventId?: unknown; duplicate?: unknown } | undefined;
      if (value?.ok !== true || value.eventId !== event.eventId) {
        return { ok: false, error: invalidResponse("events") };
      }
      return { ok: true, value: { duplicate: value.duplicate === true } };
    },

    async getCommands(since) {
      const query = since ? `?since=${encodeURIComponent(since)}` : "";
      const result = await authedRequest(`/commands${query}`, { method: "GET" });
      if (!result.ok) return result;
      const parsed = commandsResponseSchema.safeParse(result.value);
      if (!parsed.success) return { ok: false, error: invalidResponse("commands") };
      return { ok: true, value: parsed.data };
    },

    async getStatus() {
      const result = await authedRequest("/status", { method: "GET" });
      if (!result.ok) return result;
      const parsed = statusResponseSchema.safeParse(result.value);
      if (!parsed.success) return { ok: false, error: invalidResponse("status") };
      return { ok: true, value: parsed.data };
    },
  };
}

/** The one instance every page uses; a fresh device token is read from
 * storage on every call, so pairing/un-pairing elsewhere is picked up
 * immediately without recreating this. */
export const bridgeClient: BridgeClient = createBridgeClient();
