import { describe, it, expect } from "vitest";
import { HTTPException } from "hono/http-exception";
import { parseRateConfigPatch } from "./endpoints";

// PATCH validator for the rate-limit pair. Semantics (Q6 iii):
//   - both absent  -> returns undefined (no change)
//   - both int+bounds -> returns the pair
//   - both null -> returns null pair (clear)
//   - everything else -> 400
// Bounds: rps in [1,100], burst in [1,1000].

function expectHttp(status: number, fn: () => unknown): HTTPException {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof HTTPException)) throw new Error("expected HTTPException");
    expect(e.status).toBe(status);
    return e;
  }
  throw new Error("expected throw");
}

describe("parseRateConfigPatch", () => {
  it("returns undefined when neither field is present", () => {
    expect(parseRateConfigPatch({})).toBeUndefined();
    expect(parseRateConfigPatch({ ordered: true })).toBeUndefined();
  });

  it("accepts a valid int pair and returns it normalized", () => {
    expect(parseRateConfigPatch({ rate_limit_rps: 10, rate_limit_burst: 20 })).toEqual({
      rateLimitRps: 10,
      rateLimitBurst: 20,
    });
  });

  it("accepts both-null as an explicit clear", () => {
    expect(parseRateConfigPatch({ rate_limit_rps: null, rate_limit_burst: null })).toEqual({
      rateLimitRps: null,
      rateLimitBurst: null,
    });
  });

  it("rejects half-pair (one field present, the other absent)", () => {
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_rps: 10 }));
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_burst: 20 }));
  });

  it("rejects mixed null + int (can't clear half the pair)", () => {
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_rps: 10, rate_limit_burst: null }));
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_rps: null, rate_limit_burst: 20 }));
  });

  it("rejects rps out of [1, 100]", () => {
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_rps: 0, rate_limit_burst: 1 }));
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_rps: 101, rate_limit_burst: 1 }));
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_rps: -1, rate_limit_burst: 1 }));
  });

  it("rejects burst out of [1, 1000]", () => {
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_rps: 1, rate_limit_burst: 0 }));
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_rps: 1, rate_limit_burst: 1001 }));
  });

  it("rejects non-integer numeric values", () => {
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_rps: 1.5, rate_limit_burst: 1 }));
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_rps: 1, rate_limit_burst: 1.5 }));
  });

  it("rejects non-numeric types (string/boolean/etc)", () => {
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_rps: "10", rate_limit_burst: 1 }));
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_rps: true, rate_limit_burst: 1 }));
  });

  it("accepts the boundary values", () => {
    expect(parseRateConfigPatch({ rate_limit_rps: 1, rate_limit_burst: 1 })).toEqual({
      rateLimitRps: 1,
      rateLimitBurst: 1,
    });
    expect(parseRateConfigPatch({ rate_limit_rps: 100, rate_limit_burst: 1000 })).toEqual({
      rateLimitRps: 100,
      rateLimitBurst: 1000,
    });
  });

  it("permits the documented-silly `burst < rps` (no cross-field constraint)", () => {
    expect(parseRateConfigPatch({ rate_limit_rps: 10, rate_limit_burst: 1 })).toEqual({
      rateLimitRps: 10,
      rateLimitBurst: 1,
    });
  });
});
