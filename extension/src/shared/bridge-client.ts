/**
 * The bridge surface (mvp-spec §5: `POST /pair`, `GET /commands`,
 * `POST /events`, `GET /status`, all on `127.0.0.1:4310`) behind one
 * interface, so part B can swap in a real `fetch`-backed implementation
 * without changing any caller. Part A ships only `stubBridgeClient`: "a
 * `BridgeClient` interface whose part-A implementation is a stub that
 * returns a clear 'Pairing connects in the next version' result — no
 * network." No method here ever calls `fetch`.
 */
import type {
  CommandsResponse,
  EventsRequest,
  PairRequest,
  PairResponse,
  StatusResponse,
} from "@workflow-catalog/contracts";

export type BridgeResult<T> = { ok: true; value: T } | { ok: false; message: string };

export interface BridgeClient {
  pair(request: PairRequest): Promise<BridgeResult<PairResponse>>;
  postEvent(request: EventsRequest): Promise<BridgeResult<void>>;
  getCommands(since?: string): Promise<BridgeResult<CommandsResponse>>;
  getStatus(): Promise<BridgeResult<StatusResponse>>;
}

const NOT_CONNECTED = <T>(message: string): Promise<BridgeResult<T>> =>
  Promise.resolve({ ok: false, message });

/**
 * Part A's `BridgeClient`. Every method resolves immediately, with no
 * network access of any kind — matches the packet's own acceptance
 * criteria for part A ("NO bridge calls") and this repo's manifest, which
 * grants `host_permissions` for `127.0.0.1:4310` but nothing here uses it
 * yet.
 */
export const stubBridgeClient: BridgeClient = {
  pair: () => NOT_CONNECTED("Pairing connects in the next version."),
  postEvent: () => NOT_CONNECTED("The bridge connects in the next version. Use file export for now."),
  getCommands: () => NOT_CONNECTED("The bridge connects in the next version."),
  getStatus: () => NOT_CONNECTED("The bridge connects in the next version."),
};
