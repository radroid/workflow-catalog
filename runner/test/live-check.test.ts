import { describe, expect, it } from "vitest";
import { formatCheckFailure } from "../lib/live-check.ts";

/**
 * P10 packet carried item ("the doctor --live failure line"): `cli/doctor.ts`
 * used to print `The model check failed: The model answered, ...` -- a
 * capital right after the colon, and its own prefix that disagreed with the
 * Status page's "Check the model" button (`ui/assets/status.js`:
 * `` `The check failed: ${outcome.detail}` ``, fed by
 * `server/eve-gateway.ts`'s already-lower-case detail strings, e.g. "the
 * model answered, but not with the expected reply."). `formatCheckFailure`
 * is the one prefix `cli/doctor.ts -- --live` now shares with it.
 */
describe("formatCheckFailure", () => {
  it("matches the Status page's exact prefix", () => {
    expect(formatCheckFailure("the model answered, but not with the expected reply.")).toBe("The check failed: the model answered, but not with the expected reply.");
  });

  it("falls back to 'no detail', same as the Status page does for a missing detail", () => {
    expect(formatCheckFailure(undefined)).toBe("The check failed: no detail");
  });
});
