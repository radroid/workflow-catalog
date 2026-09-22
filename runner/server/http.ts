import type { ZodError } from "zod";

/**
 * Small HTTP helpers shared by the extension routes and the local UI: one
 * error shape, zod issues with their paths, and a JSON body reader that
 * enforces the size cap on the raw bytes before anything is parsed.
 */

export interface ErrorBody {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly issues?: ReadonlyArray<{ readonly path: ReadonlyArray<string | number>; readonly message: string }>;
  };
}

export function errorBody(code: string, message: string, issues?: ErrorBody["error"]["issues"]): ErrorBody {
  return { ok: false, error: issues ? { code, message, issues } : { code, message } };
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function errorResponse(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return jsonResponse(status, errorBody(code, message), headers);
}

/** 400 with every zod issue and its path, e.g. [{ path: ["url"], message: "..." }]. */
export function validationErrorResponse(error: ZodError, headers: Record<string, string> = {}): Response {
  const issues = error.issues.map((issue) => ({
    path: issue.path.map((segment) => (typeof segment === "symbol" ? String(segment) : segment)),
    message: issue.message,
  }));
  const first = issues[0];
  const where = first ? (first.path.length > 0 ? first.path.join(".") : "(body)") : "(body)";
  return jsonResponse(400, errorBody("invalid_body", `Invalid request body at ${where}: ${first?.message ?? "invalid"}`, issues), headers);
}

/** True when the request declares a Content-Length above the cap: refuse it without reading a byte. */
export function declaredLengthExceeds(request: Request, maxBytes: number): boolean {
  const declared = request.headers.get("content-length");
  if (declared === null) return false;
  const length = Number(declared);
  return !Number.isFinite(length) || length < 0 || length > maxBytes;
}

export function isJsonContentType(request: Request): boolean {
  const type = request.headers.get("content-type");
  if (!type) return false;
  return type.split(";")[0]?.trim().toLowerCase() === "application/json";
}

export type BodyResult =
  | { readonly ok: true; readonly value: unknown; readonly bytes: number }
  | { readonly ok: false; readonly response: Response };

/**
 * Reads a JSON body, counting raw bytes as they arrive and giving up with 413
 * as soon as the count passes `maxBytes`, whatever Content-Length claimed.
 * Only a body within the cap is decoded (strict UTF-8) and parsed.
 */
export async function readBoundedJson(request: Request, maxBytes: number, headers: Record<string, string> = {}): Promise<BodyResult> {
  if (declaredLengthExceeds(request, maxBytes)) {
    return { ok: false, response: errorResponse(413, "body_too_large", `Request body is larger than ${maxBytes} bytes.`, headers) };
  }
  if (!isJsonContentType(request)) {
    return { ok: false, response: errorResponse(415, "unsupported_media_type", "Send the body as application/json.", headers) };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, response: errorResponse(413, "body_too_large", `Request body is larger than ${maxBytes} bytes.`, headers) };
      }
      chunks.push(value);
    }
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return { ok: false, response: errorResponse(400, "invalid_body", "Request body is not valid UTF-8.", headers) };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown, bytes: total };
  } catch {
    return { ok: false, response: errorResponse(400, "invalid_json", "Request body is not valid JSON.", headers) };
  }
}
