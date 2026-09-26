/**
 * What the extension will open, and which commands it will act on (P07
 * part C). browser-boundary.md, "Minimal protocol contract": "Validate
 * command expiry, device binding, workflow version, task ownership, URL
 * scheme, and maximum group size; reject `javascript:`, local files,
 * privileged browser URLs, and arbitrary code. Bind commands to stored job
 * URLs."
 *
 * The runner already sends only https URLs to public hosts, each the
 * stored capture URL (P06, `commandUrlProblem`). The contract's
 * `httpUrlSchema` still admits http, and a session manifest imported from
 * a file comes from wherever the person got it, so the extension checks
 * every URL again before it opens one (the carried "Opening stored URLs"
 * item, `logs/blocks.md` "P04 URL rule"): https only, no user name or
 * password, and never a loopback, private, link-local or metadata address,
 * or a local-only name. The address ranges mirror the runner's
 * `isBlockedAddress` (runner/lib/safe-fetch.ts).
 *
 * A browser can't resolve a name before opening it, so a public name that
 * resolves to a private address is not caught here; the runner's check
 * and the stored-URL binding are what stand behind that.
 */
import { MAX_APPLICATION_GROUP_SIZE, type OpenApplicationGroup } from "@workflow-catalog/contracts";

export type UrlProblem = "not_a_url" | "not_https" | "has_credentials" | "private_host";

/** The workflow this extension was built for: `job-assistant@<major>`
 * (P06 sends `job-assistant@0` today, package 0.1.0). A command naming
 * another package or major is refused. */
export const SUPPORTED_WORKFLOW_VERSION = "job-assistant@0";

const LOCAL_ONLY_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa|localdomain)$/;

function isBlockedIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0) return true; // "this network" / unspecified
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 169 && b === 254) return true; // link-local, including the 169.254.169.254 metadata address
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT shared space (and 100.100.100.200, a metadata address)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/** Sixteen bytes of an IPv6 literal (no brackets), or undefined. */
function ipv6Bytes(address: string): Uint8Array | undefined {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  let tailBytes: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const parts = tail.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
    tailBytes = parts;
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] | undefined => {
    if (part === "") return [];
    const groups = part.split(":").map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : Number.NaN));
    return groups.some(Number.isNaN) ? undefined : groups;
  };
  let groups: number[] | undefined;
  if (halves.length === 2) {
    const head = parse(halves[0]!);
    const rest = parse(halves[1]!);
    if (!head || !rest || head.length + rest.length > 7) return undefined;
    groups = [...head, ...new Array<number>(8 - head.length - rest.length).fill(0), ...rest];
  } else {
    groups = parse(text);
  }
  if (!groups || groups.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = (group >> 8) & 0xff;
    bytes[index * 2 + 1] = group & 0xff;
  });
  if (tailBytes.length === 4) bytes.set(tailBytes, 12);
  return bytes;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], bits: number): boolean {
  for (let bit = 0; bit < bits; bit += 1) {
    const byte = Math.floor(bit / 8);
    const mask = 0x80 >> (bit % 8);
    if ((bytes[byte]! & mask) !== ((prefix[byte] ?? 0) & mask)) return false;
  }
  return true;
}

function isBlockedIPv6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (!bytes) return true;
  const allZero = (from: number, to: number) => bytes.slice(from, to).every((value) => value === 0);
  if (allZero(0, 16)) return true; // unspecified
  if (allZero(0, 15) && bytes[15] === 1) return true; // loopback
  if (startsWith(bytes, [0xfe, 0x80], 10)) return true; // link-local
  if (startsWith(bytes, [0xfe, 0xc0], 10)) return true; // site-local
  if (startsWith(bytes, [0xfc], 7)) return true; // unique local (and fd00:ec2::254, a metadata address)
  if (startsWith(bytes, [0xff], 8)) return true; // multicast
  if (startsWith(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48)) return true; // local-use NAT64
  if (startsWith(bytes, [0x20, 0x02], 16)) return true; // 6to4
  const embedded = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  const mapped = allZero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff;
  const translated = allZero(0, 8) && bytes[8] === 0xff && bytes[9] === 0xff && bytes[10] === 0 && bytes[11] === 0;
  const compatible = allZero(0, 12);
  const nat64 = startsWith(bytes, [0x00, 0x64, 0xff, 0x9b], 96);
  if (mapped || translated || compatible || nat64) return isBlockedIPv4(embedded);
  return false;
}

/**
 * Why the extension won't open `raw` in a tab, or undefined when it will.
 * The WHATWG URL parser has already turned every IPv4 spelling
 * (`2130706433`, `0x7f.1`, `127.1`) into dotted decimal, and every IPv6
 * spelling into its bracketed compressed form, before these checks run.
 */
export function openableUrlProblem(raw: string): UrlProblem | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not_a_url";
  }
  if (url.protocol !== "https:") return "not_https";
  if (url.username !== "" || url.password !== "") return "has_credentials";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) return isBlockedIPv6(host.slice(1, -1)) ? "private_host" : undefined;
  if (/^[0-9.]+$/.test(host)) return isBlockedIPv4(host) ? "private_host" : undefined;
  if (!host.includes(".") || LOCAL_ONLY_NAME.test(host)) return "private_host";
  return undefined;
}

/** One sentence for a person, for each `UrlProblem`. */
export function describeUrlProblem(problem: UrlProblem): string {
  switch (problem) {
    case "not_https":
      return "Its address isn't a secure (https) web address, so it won't be opened.";
    case "has_credentials":
      return "Its address carries a user name or password, so it won't be opened.";
    case "private_host":
      return "Its address points at this computer or a private network, so it won't be opened.";
    case "not_a_url":
      return "Its address isn't a web address, so it won't be opened.";
  }
}

export type CommandRefusal = "other_device" | "expired" | "workflow_version" | "duplicate_task" | "too_many" | "no_openable_item";

export interface CheckedItem {
  readonly taskId: string;
  readonly jobRevision: number;
  readonly url: string;
  readonly urlProblem?: UrlProblem;
}

export type CommandCheck =
  | { readonly ok: true; readonly items: readonly CheckedItem[] }
  | { readonly ok: false; readonly refusal: CommandRefusal; readonly items: readonly CheckedItem[] };

/** The items of a manifest or command, each with its URL problem, if any. */
export function checkItems(items: ReadonlyArray<{ readonly taskId: string; readonly jobRevision: number; readonly url: string }>): CheckedItem[] {
  return items.map((item) => {
    const urlProblem = openableUrlProblem(item.url);
    return { taskId: item.taskId, jobRevision: item.jobRevision, url: item.url, ...(urlProblem ? { urlProblem } : {}) };
  });
}

/** Refusals that hold for a whole list of items, whatever it came in. */
export function itemsRefusal(items: readonly CheckedItem[]): CommandRefusal | undefined {
  if (items.length > MAX_APPLICATION_GROUP_SIZE) return "too_many";
  if (new Set(items.map((item) => item.taskId)).size !== items.length) return "duplicate_task";
  if (items.every((item) => item.urlProblem !== undefined)) return "no_openable_item";
  return undefined;
}

/**
 * The checks the contract's zod schema can't make, for a command that
 * already passed it (`commandsResponseSchema`, which bounds the group size
 * and refuses any URL that isn't http(s)): the device it is for, its
 * expiry, the workflow version, one entry per task, and each URL.
 */
export function checkCommand(command: OpenApplicationGroup, context: { readonly deviceId: string; readonly now: Date }): CommandCheck {
  const items = checkItems(command.payload.items);
  if (command.deviceId !== context.deviceId) return { ok: false, refusal: "other_device", items };
  if (new Date(command.expiresAt).getTime() <= context.now.getTime()) return { ok: false, refusal: "expired", items };
  if (command.workflowVersion !== SUPPORTED_WORKFLOW_VERSION) return { ok: false, refusal: "workflow_version", items };
  const refusal = itemsRefusal(items);
  if (refusal) return { ok: false, refusal, items };
  return { ok: true, items };
}

/** One sentence for a person, for each `CommandRefusal`. */
export function describeCommandRefusal(refusal: CommandRefusal): string {
  switch (refusal) {
    case "other_device":
      return "It was meant for another browser, so it wasn't opened here.";
    case "expired":
      return "It expired before it was opened. Start a new session from the runner's Board.";
    case "workflow_version":
      return "It came from a version of the workflow this extension doesn't know. Update the extension, then start the session again.";
    case "duplicate_task":
      return "It names one application twice, so it wasn't opened.";
    case "too_many":
      return `It has more than ${MAX_APPLICATION_GROUP_SIZE} applications, so it wasn't opened.`;
    case "no_openable_item":
      return "None of its addresses can be opened safely, so nothing was opened.";
  }
}
