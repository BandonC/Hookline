import { describe, it, expect } from "vitest";
import { signPayload } from "./signing";

// Invariant 2: HMAC-SHA256 over `${timestamp}.${rawBody}`, hex, `v1=<hex>`.
// The golden signature below was computed independently with Node's crypto
// (createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')), so this
// is a real oracle — a wrong algorithm, message construction, or encoding fails
// it, not just a self-consistent round-trip.
const SECRET = "whsec_test_secret";
const TS = 1700000000;
const BODY = JSON.stringify({ id: "evt_123", payload: { hello: "world" } });
const GOLDEN =
  "v1=d867d575e3758b0181ad34d310e696ed48ab95b1853cc74d866fca167d633bf1";

describe("signPayload", () => {
  it("produces the known signature for a fixed (secret, body, timestamp)", async () => {
    expect(await signPayload(SECRET, BODY, TS)).toBe(GOLDEN);
  });

  it("changes when the body is tampered (replay/forgery protection)", async () => {
    const tampered = JSON.stringify({ id: "evt_123", payload: { hello: "evil" } });
    expect(await signPayload(SECRET, tampered, TS)).not.toBe(GOLDEN);
  });

  it("changes when the timestamp is tampered", async () => {
    expect(await signPayload(SECRET, BODY, TS + 1)).not.toBe(GOLDEN);
  });

  it("changes under a different secret", async () => {
    expect(await signPayload("whsec_other", BODY, TS)).not.toBe(GOLDEN);
  });
});
