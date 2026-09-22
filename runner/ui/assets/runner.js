/* global document, window, fetch */
// Shared helpers for runner pages (plain ES module, no framework). Every page
// talks to the bridge's local API with these, so each request is same-origin,
// carries the sign-in cookie, and states the JSON content type the API's
// state-changing guard requires (server/local-ui.ts).

/** GET /api/... as JSON. Throws an Error with the API's message on failure. */
export async function getJson(path) {
  return request("GET", path);
}

/** POST /api/... with a JSON body (an empty object by default). */
export async function postJson(path, body = {}) {
  return request("POST", path, body);
}

async function request(method, path, body) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    // not JSON
  }
  if (response.status === 401) {
    window.location.reload();
    throw new Error("Signed out.");
  }
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

/** Creates an element with text content only: never innerHTML with data. */
export function el(tag, options = {}, ...children) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = String(options.text);
  for (const [name, value] of Object.entries(options.attrs ?? {})) node.setAttribute(name, value);
  for (const child of children) if (child) node.append(child);
  return node;
}

export function formatTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
