import { z } from "zod";

/**
 * The bridge envelope protocol version. Domain schemas (career profile, job
 * snapshot, session manifest, bridge envelopes) land in P01; this package is
 * intentionally empty of them until then.
 */
export const PROTOCOL_VERSION = 1 as const;

export const protocolVersionSchema = z.literal(PROTOCOL_VERSION);
