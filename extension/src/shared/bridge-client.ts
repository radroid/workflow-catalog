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
import { flagOriginMismatch, forgetInvalidToken, getDeviceToken } from "./storage";

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
 * queue-and-retry both exactly the same way, see shared/outbox.ts).
 * Revision 2 polish: with a next step -- it may just be busy; if it stays
 * silent, restarting it is the fix. */
const TIMEOUT_ERROR: BridgeError = {
  code: "network_error",
  message: "The runner isn't responding. Wait a moment and try again, or restart it with `npm run runner`.",
};

/** A runner that accepts the TCP connection but never answers must not
 * leave "Pairing…"/"Saving…" disabled forever (P07-B revision 1, B4). */
const REQUEST_TIMEOUT_MS = 5000;

const NOT_PAIRED: BridgeError = {
  code: "not_paired",
  message: "This device isn't paired yet. Pair it above first.",
};

/** P07-B revision 2, B4: the bridge refused a token that a new pairing
 * replaced while the request was in flight -- twice in a row, since
 * `authedRequest` already retries once with the replacement. Says nothing
 * about the pairing this browser holds now, so shared/outbox.ts retries it
 * (never pauses it). */
const TOKEN_REPLACED: BridgeError = {
  code: "token_replaced",
  message: "This browser was paired again while sending. It will be sent again shortly.",
};

/**
 * P07-B revision 3, H2: what a person is told when whatever answers on the
 * runner's port isn't the runner -- an error outside the bridge's own
 * envelope (`unknown_error`), or a success that isn't the answer the
 * request expects (`invalid_response`). The runner answers every request
 * in its envelope, its own 404s and 500s included, so either one means
 * another program holds the port. One sentence with a next step, the same
 * wherever it shows (Status, Pairing); revision 2's wording ("didn't match
 * the expected shape", "HTTP 404") blamed the runner, in jargon.
 */
export const FOREIGN_SERVER_MESSAGE =
  "Something other than the runner is answering on its port. Close that program, then start the runner with `npm run runner`.";

function invalidResponse(): BridgeError {
  return { code: "invalid_response", message: FOREIGN_SERVER_MESSAGE };
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
      message: FOREIGN_SERVER_MESSAGE,
      retryAfterSeconds,
    },
  };
}

export interface CreateBridgeClientOptions {
  readonly baseUrl?: string;
  /** Overridable for tests only; defaults to shared/storage.ts's getDeviceToken. */
  readonly getToken?: () => Promise<{ token: string } | null>;
  /**
   * Called with the refused token whenever the bridge answers an
   * authenticated request 401 (`token_invalid`: unknown, revoked or
   * expired) and that token is still the stored one -- overridable for
   * tests only; defaults to shared/storage.ts's `forgetInvalidToken`, which
   * forgets the token only if it is still stored. P07-B revision 1, B3: a
   * dead token must stop being offered as "paired" anywhere in the UI, not
   * just get a one-time error message -- clearing it here, in the one
   * place every authenticated route already funnels through, means Pairing
   * and Status both naturally show "not paired" on their next render,
   * wherever the 401 was actually observed.
   */
  readonly onTokenInvalid?: (token: string) => Promise<void>;
  /**
   * Called with the refused token whenever the bridge answers an
   * authenticated request 403 (`origin_not_allowed`) and that token is
   * still the stored one -- overridable for tests only; defaults to
   * shared/storage.ts's `flagOriginMismatch`. P07-B revision 1, B3: `GET
   * /status` never carries an Origin header (Chrome doesn't send one on a
   * GET), so the options page's own status check can never itself observe
   * this -- this is the only channel that lets it react to a 403
   * `job_capture`'s `POST /events` saw.
   */
  readonly onOriginMismatch?: (token: string) => Promise<void>;
}

/** A 401 or 403 in the bridge's own error envelope. An `unknown_error`
 * with the same status is not the bridge (something else answering on the
 * port), so it says nothing about this browser's token. */
function isBridgeAuthRefusal(error: BridgeError): boolean {
  return (error.status === 401 || error.status === 403) && error.code !== "unknown_error";
}

/** The real, `fetch`-backed `BridgeClient`. */
export function createBridgeClient(options: CreateBridgeClientOptions = {}): BridgeClient {
  const baseUrl = options.baseUrl ?? BRIDGE_ORIGIN;
  const getToken = options.getToken ?? getDeviceToken;
  const onTokenInvalid = options.onTokenInvalid ?? forgetInvalidToken;
  const onOriginMismatch = options.onOriginMismatch ?? flagOriginMismatch;

  function sendWithToken(path: string, init: RequestInit, token: string): Promise<BridgeResult<unknown>> {
    return request(baseUrl, path, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });
  }

  async function reportRefusal(error: BridgeError, token: string): Promise<void> {
    if (error.status === 401) await onTokenInvalid(token);
    else await onOriginMismatch(token);
  }

  /**
   * P07-B revision 2, B4: a bridge 401/403 is only about the token that
   * was sent. If a pairing replaced the stored token while the request was
   * in flight (the options page pairing while the worker's alarm flush is
   * mid-request), the refusal says nothing about the new pairing: retry
   * once with the new token, and never let the old token's refusal clear
   * or flag the new one. Revision 1 cleared whatever token was stored on
   * any 401, undoing the pairing that had just succeeded.
   *
   * Resending is safe: the bridge checks the token and origin before it
   * reads the body, so a refused `POST /events` recorded nothing.
   */
  async function authedRequest(path: string, init: RequestInit = {}): Promise<BridgeResult<unknown>> {
    const stored = await getToken();
    if (!stored) return { ok: false, error: NOT_PAIRED };
    const result = await sendWithToken(path, init, stored.token);
    if (result.ok || !isBridgeAuthRefusal(result.error)) return result;

    const current = await getToken();
    if (current === null || current.token === stored.token) {
      // Still the same token (the hook re-checks, too), or it's already
      // gone -- Un-pair, or another context's 401 got there first.
      await reportRefusal(result.error, stored.token);
      return result;
    }
    const retried = await sendWithToken(path, init, current.token);
    if (retried.ok || !isBridgeAuthRefusal(retried.error)) return retried;
    const latest = await getToken();
    if (latest !== null && latest.token !== current.token) return { ok: false, error: TOKEN_REPLACED };
    await reportRefusal(retried.error, current.token);
    return retried;
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
      if (!parsed.success) return { ok: false, error: invalidResponse() };
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
        return { ok: false, error: invalidResponse() };
      }
      return { ok: true, value: { duplicate: value.duplicate === true } };
    },

    async getCommands(since) {
      const query = since ? `?since=${encodeURIComponent(since)}` : "";
      const result = await authedRequest(`/commands${query}`, { method: "GET" });
      if (!result.ok) return result;
      const parsed = commandsResponseSchema.safeParse(result.value);
      if (!parsed.success) return { ok: false, error: invalidResponse() };
      return { ok: true, value: parsed.data };
    },

    async getStatus() {
      const result = await authedRequest("/status", { method: "GET" });
      if (!result.ok) return result;
      const parsed = statusResponseSchema.safeParse(result.value);
      if (!parsed.success) return { ok: false, error: invalidResponse() };
      return { ok: true, value: parsed.data };
    },
  };
}

/** The one instance every page uses; a fresh device token is read from
 * storage on every call, so pairing/un-pairing elsewhere is picked up
 * immediately without recreating this. */
export const bridgeClient: BridgeClient = createBridgeClient();
